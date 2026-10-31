import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';

const require = createRequire(import.meta.url);
export const Database = require('better-sqlite3') as typeof BetterSqlite3;
export type Db = BetterSqlite3.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS crawl_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS urls (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  depth INTEGER,
  in_sitemap INTEGER NOT NULL DEFAULT 0,
  indexable INTEGER,
  indexability_reason TEXT
);
CREATE INDEX IF NOT EXISTS urls_state ON urls(state, kind, id);
CREATE TABLE IF NOT EXISTS responses (
  url_id INTEGER PRIMARY KEY REFERENCES urls(id),
  status INTEGER,
  content_type TEXT,
  redirect_target TEXT,
  x_robots TEXT,
  link_canonical TEXT,
  response_ms INTEGER,
  bytes INTEGER,
  error TEXT,
  blocked_reason TEXT,
  fetched_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS links (
  source_id INTEGER NOT NULL REFERENCES urls(id),
  target_id INTEGER NOT NULL REFERENCES urls(id),
  type TEXT NOT NULL,
  anchor TEXT,
  nofollow INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS links_target ON links(target_id);
CREATE INDEX IF NOT EXISTS links_source ON links(source_id);
CREATE TABLE IF NOT EXISTS page_elements (
  url_id INTEGER PRIMARY KEY REFERENCES urls(id),
  titles TEXT NOT NULL,
  meta_descriptions TEXT NOT NULL,
  h1s TEXT NOT NULL,
  meta_robots TEXT NOT NULL,
  canonicals TEXT NOT NULL,
  word_count INTEGER NOT NULL,
  text_hash TEXT,
  html_bytes INTEGER NOT NULL,
  script_count INTEGER NOT NULL,
  has_empty_app_root INTEGER NOT NULL,
  h2s TEXT,
  rendered INTEGER NOT NULL DEFAULT 0,
  raw_word_count INTEGER,
  js_only_links INTEGER,
  render_error TEXT
);
CREATE TABLE IF NOT EXISTS hreflang (
  url_id INTEGER NOT NULL REFERENCES urls(id),
  lang TEXT NOT NULL,
  href TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS hreflang_url ON hreflang(url_id);
CREATE TABLE IF NOT EXISTS structured_data (
  url_id INTEGER NOT NULL REFERENCES urls(id),
  raw TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS redirect_hops (
  start_id INTEGER NOT NULL REFERENCES urls(id),
  hop INTEGER NOT NULL,
  url TEXT NOT NULL,
  status INTEGER,
  PRIMARY KEY (start_id, hop)
);
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  url TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS issues_type ON issues(type);
CREATE INDEX IF NOT EXISTS issues_url ON issues(url);
CREATE TABLE IF NOT EXISTS search_console (
  url TEXT PRIMARY KEY,
  clicks REAL, impressions REAL, ctr REAL, position REAL
);
CREATE TABLE IF NOT EXISTS analytics (
  url TEXT PRIMARY KEY,
  sessions REAL, engaged_sessions REAL
);
CREATE TABLE IF NOT EXISTS pagespeed (
  url TEXT NOT NULL,
  strategy TEXT NOT NULL,
  performance REAL, lcp_ms REAL, cls REAL, inp_ms REAL, ttfb_ms REAL,
  PRIMARY KEY (url, strategy)
);
CREATE TABLE IF NOT EXISTS paid_data (
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  cost REAL NOT NULL DEFAULT 0,
  cached INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (kind, key)
);
CREATE TABLE IF NOT EXISTS bing_webmaster (
  url TEXT PRIMARY KEY,
  clicks REAL, impressions REAL, click_position REAL, impression_position REAL, source_url TEXT
);
CREATE TABLE IF NOT EXISTS traffic_pulls (
  source TEXT PRIMARY KEY,
  account TEXT, property TEXT, days INTEGER, start_date TEXT, end_date TEXT, fetched_at TEXT NOT NULL,
  status TEXT NOT NULL, row_count INTEGER NOT NULL DEFAULT 0, matched INTEGER NOT NULL DEFAULT 0, dropped INTEGER NOT NULL DEFAULT 0,
  note TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS gsc_queries (
  url TEXT NOT NULL,
  query TEXT NOT NULL,
  clicks REAL, impressions REAL, ctr REAL, position REAL,
  PRIMARY KEY (url, query)
);
CREATE TABLE IF NOT EXISTS url_inspection (
  url TEXT PRIMARY KEY,
  verdict TEXT, coverage_state TEXT, indexing_state TEXT, robots_state TEXT, page_fetch_state TEXT, last_crawl_time TEXT,
  google_canonical TEXT, user_canonical TEXT, error TEXT, fetched_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS page_schema (
  url_id INTEGER NOT NULL REFERENCES urls(id),
  type TEXT NOT NULL,
  PRIMARY KEY (url_id, type)
);
CREATE TABLE IF NOT EXISTS ai_bots (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  purpose TEXT NOT NULL,
  robots_allowed INTEGER,
  probe_status INTEGER,
  probe_refused INTEGER
);
CREATE TABLE IF NOT EXISTS crux (
  scope TEXT NOT NULL,
  form_factor TEXT NOT NULL,
  lcp_ms REAL, cls REAL, inp_ms REAL, fetched_at TEXT NOT NULL,
  PRIMARY KEY (scope, form_factor)
);
CREATE TABLE IF NOT EXISTS ai_referrals (
  url TEXT NOT NULL,
  source TEXT NOT NULL,
  sessions REAL, engaged_sessions REAL, key_events REAL,
  PRIMARY KEY (url, source)
);
CREATE TABLE IF NOT EXISTS ai_search_pages (
  source TEXT NOT NULL,
  url TEXT NOT NULL,
  impressions REAL, citations REAL,
  in_crawl INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source, url)
);
CREATE TABLE IF NOT EXISTS ai_search_queries (
  source TEXT NOT NULL,
  query TEXT NOT NULL,
  citations REAL, citation_share REAL,
  PRIMARY KEY (source, query)
);
CREATE TABLE IF NOT EXISTS ai_citations (
  url TEXT NOT NULL,
  engine TEXT NOT NULL,
  subject TEXT NOT NULL,
  volume REAL,
  PRIMARY KEY (url, engine, subject)
);
CREATE TABLE IF NOT EXISTS gbp_profile (
  key TEXT PRIMARY KEY,
  title TEXT, category TEXT, additional_categories TEXT, description TEXT, address TEXT, phone TEXT, url TEXT, domain TEXT,
  place_id TEXT, cid TEXT, is_claimed INTEGER, total_photos INTEGER, rating REAL, rating_votes INTEGER, rating_distribution TEXT,
  has_hours INTEGER, attributes INTEGER, services INTEGER, place_topics TEXT, competitors TEXT,
  reviews_fetched INTEGER, reviews_with_reply INTEGER, latest_review TEXT, reviews_last_90 INTEGER,
  posts_fetched INTEGER, latest_post TEXT, fetched_at TEXT NOT NULL
);
`;

const SCHEMA_VERSION = 4;

const ADDED_COLUMNS: Record<string, Record<string, string>> = {
  // h2s stays NULL on crawls saved before it existed, so they don't read as "no H2" on every page.
  page_elements: {
    h2s: 'TEXT',
    rendered: 'INTEGER NOT NULL DEFAULT 0',
    raw_word_count: 'INTEGER',
    js_only_links: 'INTEGER',
    render_error: 'TEXT',
    // JSON. NULL on older crawls, so their checks skip it instead of reporting every page.
    signals: 'TEXT',
  },
  urls: { link_score: 'REAL' },
  // An empty string means the header was absent. NULL means the crawl predates reading it.
  responses: { content_encoding: 'TEXT', cache_control: 'TEXT', hsts: 'TEXT', truncated: 'INTEGER NOT NULL DEFAULT 0' },
  search_console: { source_url: 'TEXT' },
  analytics: { users: 'REAL', views: 'REAL', key_events: 'REAL', source_url: 'TEXT' },
  pagespeed: { field_lcp_ms: 'REAL', field_cls: 'REAL' },
  url_inspection: { rich_verdict: 'TEXT', rich_types: 'TEXT', rich_issues: 'TEXT' },
  gbp_profile: { business_status: 'TEXT' },
};

function migrate(db: Db): void {
  db.exec(SCHEMA);
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    const existing = new Set((db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name));
    for (const [name, type] of Object.entries(columns)) {
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

export function sakHome(): string {
  return process.env.SAK_HOME ?? join(homedir(), '.sak');
}

export function crawlsDir(): string {
  const dir = join(sakHome(), 'crawls');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function crawlPath(id: string): string {
  if (!/^[\w.-]+$/.test(id)) throw new Error(`Invalid crawl id: ${id}`);
  return join(crawlsDir(), `${id}.sqlite`);
}

export function createCrawlDb(id: string): Db {
  const db = new Database(crawlPath(id));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  return db;
}

export function openCrawlDb(id: string, options: { readonly?: boolean } = {}): Db {
  const path = crawlPath(id);
  if (!existsSync(path)) throw new Error(`No crawl with id ${id}`);
  const db = new Database(path, { readonly: options.readonly ?? false });
  if (!options.readonly) {
    db.pragma('journal_mode = WAL');
    migrate(db);
    return db;
  }
  if ((db.pragma('user_version', { simple: true }) as number) >= SCHEMA_VERSION) return db;
  // Read-only callers still need an up-to-date schema, so an older crawl is upgraded once.
  db.close();
  openCrawlDb(id).close();
  return new Database(path, { readonly: true });
}

export function listCrawlIds(): string[] {
  return readdirSync(crawlsDir())
    .filter((f) => f.endsWith('.sqlite'))
    .map((f) => f.slice(0, -'.sqlite'.length))
    .sort()
    .reverse();
}

export function getMeta(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM crawl_meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO crawl_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function deleteMeta(db: Db, key: string): void {
  db.prepare('DELETE FROM crawl_meta WHERE key = ?').run(key);
}
