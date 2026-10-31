import { getMeta, listCrawlIds, openCrawlDb, type Db } from './db.ts';
import { URL_ROW_SQL } from './analysis.ts';
import { ISSUES } from './checks/catalog.ts';
import type { UrlRow } from './types.ts';

export interface Page<T> {
  total: number;
  offset: number;
  limit: number;
  items: T[];
}

export interface CrawlOverview {
  id: string;
  startUrl: string | null;
  status: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  pages: number;
  fetched: number;
  pending: number;
  issues: number;
  error: string | null;
  trafficStatus: string | null;
}

export function withCrawl<T>(id: string, read: (db: Db) => T): T {
  const db = openCrawlDb(id, { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

export function crawlOverview(db: Db, id: string): CrawlOverview {
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    id,
    startUrl: getMeta(db, 'start_url'),
    status: getMeta(db, 'status'),
    startedAt: getMeta(db, 'started_at'),
    finishedAt: getMeta(db, 'finished_at'),
    pages: count(`SELECT COUNT(*) AS n FROM urls WHERE kind = 'page'`),
    fetched: count(`SELECT COUNT(*) AS n FROM urls WHERE state IN ('done', 'blocked_robots')`),
    pending: count(`SELECT COUNT(*) AS n FROM urls WHERE state IN ('pending', 'in_progress')`),
    issues: count('SELECT COUNT(*) AS n FROM issues'),
    error: getMeta(db, 'error'),
    trafficStatus: getMeta(db, 'traffic_status'),
  };
}

export function listCrawls(): CrawlOverview[] {
  return listCrawlIds()
    .map((id) => withCrawl(id, (db) => crawlOverview(db, id)))
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
}

export interface IssueSummaryRow {
  type: string;
  severity: string;
  title: string;
  fix: string;
  count: number;
}

const SEVERITY_ORDER: Record<string, number> = { error: 0, warning: 1, notice: 2 };

export function issuesSummary(db: Db): IssueSummaryRow[] {
  const rows = db.prepare('SELECT type, severity, COUNT(*) AS count FROM issues GROUP BY type, severity').all() as { type: string; severity: string; count: number }[];
  return rows
    .map((row) => ({ ...row, title: ISSUES[row.type]?.title ?? row.type, fix: ISSUES[row.type]?.fix ?? '' }))
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3) || b.count - a.count);
}

export interface IssueRow {
  type: string;
  severity: string;
  url: string;
  detail: string | null;
}

const ISSUE_SORTABLE = new Set(['type', 'severity', 'url', 'detail']);

export function listIssues(db: Db, filter: { type?: string; severity?: string; url?: string; search?: string; sort?: string; desc?: boolean; limit?: number; offset?: number } = {}): Page<IssueRow> {
  const where: string[] = [];
  const params: unknown[] = [];
  for (const column of ['type', 'severity', 'url'] as const) {
    if (filter[column]) {
      where.push(`${column} = ?`);
      params.push(filter[column]);
    }
  }
  if (filter.search) {
    where.push('(url LIKE ? OR detail LIKE ?)');
    params.push(`%${filter.search}%`, `%${filter.search}%`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(filter.limit ?? 50, 1000);
  const offset = filter.offset ?? 0;
  const sort = filter.sort && ISSUE_SORTABLE.has(filter.sort) ? filter.sort : 'id';
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM issues ${clause}`).get(...params) as { n: number };
  const items = db.prepare(`SELECT type, severity, url, detail FROM issues ${clause} ORDER BY ${sort} ${filter.desc ? 'DESC' : 'ASC'} NULLS LAST, id LIMIT ? OFFSET ?`).all(...params, limit, offset) as IssueRow[];
  return { total: n, offset, limit, items };
}

export interface UrlListRow extends UrlRow {
  title: string | null;
  meta_description: string | null;
  h1: string | null;
  canonical: string | null;
  word_count: number | null;
  inlinks: number;
  issue_count: number;
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  position: number | null;
  sessions: number | null;
  engaged_sessions: number | null;
  users: number | null;
  views: number | null;
  key_events: number | null;
  bing_clicks: number | null;
  bing_impressions: number | null;
  bing_position: number | null;
}

const LIST_SQL = `SELECT base.*,
    json_extract(p.titles, '$[0]') AS title,
    json_extract(p.meta_descriptions, '$[0]') AS meta_description,
    json_extract(p.h1s, '$[0]') AS h1,
    COALESCE(json_extract(p.canonicals, '$[0]'), base.link_canonical) AS canonical,
    p.word_count,
    (SELECT COUNT(DISTINCT l.source_id) FROM links l WHERE l.target_id = base.id AND (l.type = 'a' OR base.kind IN ('image', 'css', 'script'))) AS inlinks,
    (SELECT COUNT(*) FROM issues i WHERE i.url = base.url) AS issue_count,
    sc.clicks, sc.impressions, sc.ctr, sc.position,
    an.sessions, an.engaged_sessions, an.users, an.views, an.key_events,
    bw.clicks AS bing_clicks, bw.impressions AS bing_impressions, bw.impression_position AS bing_position
  FROM (${URL_ROW_SQL}) base
  LEFT JOIN page_elements p ON p.url_id = base.id
  LEFT JOIN search_console sc ON sc.url = base.url
  LEFT JOIN analytics an ON an.url = base.url
  LEFT JOIN bing_webmaster bw ON bw.url = base.url`;

const SORTABLE = new Set(['url', 'status', 'depth', 'title', 'word_count', 'inlinks', 'issue_count', 'response_ms', 'clicks', 'impressions', 'position', 'sessions', 'key_events', 'bing_clicks', 'bing_impressions']);

export function listUrls(db: Db, filter: { kind?: string; status?: number; indexable?: boolean; search?: string; sort?: string; desc?: boolean; limit?: number; offset?: number } = {}): Page<UrlListRow> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.kind) { where.push('kind = ?'); params.push(filter.kind); }
  if (filter.status !== undefined) { where.push('status = ?'); params.push(filter.status); }
  if (filter.indexable !== undefined) { where.push('indexable = ?'); params.push(filter.indexable ? 1 : 0); }
  if (filter.search) { where.push(`(url LIKE ? OR title LIKE ?)`); params.push(`%${filter.search}%`, `%${filter.search}%`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sort = filter.sort && SORTABLE.has(filter.sort) ? filter.sort : 'id';
  const limit = Math.min(filter.limit ?? 100, 1000);
  const offset = filter.offset ?? 0;
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM (${LIST_SQL}) ${clause}`).get(...params) as { n: number };
  const items = db.prepare(`SELECT * FROM (${LIST_SQL}) ${clause} ORDER BY ${sort} ${filter.desc ? 'DESC' : 'ASC'} NULLS LAST LIMIT ? OFFSET ?`).all(...params, limit, offset) as UrlListRow[];
  return { total: n, offset, limit, items };
}

export function urlInfo(db: Db, url: string) {
  const row = db.prepare(`SELECT * FROM (${LIST_SQL}) WHERE url = ?`).get(url) as (UrlListRow & { id: number }) | undefined;
  if (!row) return null;
  const elements = db.prepare('SELECT titles, meta_descriptions, h1s, h2s, meta_robots, canonicals FROM page_elements WHERE url_id = ?').get(row.id) as Record<string, string | null> | undefined;
  const parsed = elements ? Object.fromEntries(Object.entries(elements).map(([k, v]) => [k, v === null ? null : JSON.parse(v)])) : null;
  return {
    ...row,
    elements: parsed,
    rendering: db.prepare('SELECT rendered, raw_word_count, js_only_links, render_error FROM page_elements WHERE url_id = ?').get(row.id) ?? null,
    hreflang: db.prepare('SELECT lang, href FROM hreflang WHERE url_id = ?').all(row.id),
    structured_data_blocks: (db.prepare('SELECT COUNT(*) AS n FROM structured_data WHERE url_id = ?').get(row.id) as { n: number }).n,
    redirect_chain: db.prepare('SELECT hop, url, status FROM redirect_hops WHERE start_id = ? ORDER BY hop').all(row.id),
    issues: db.prepare('SELECT type, severity, detail FROM issues WHERE url = ?').all(url),
    pagespeed: db.prepare('SELECT strategy, performance, lcp_ms, cls, inp_ms, ttfb_ms FROM pagespeed WHERE url = ?').all(url),
    top_queries: db.prepare('SELECT query, clicks, impressions, ctr, position FROM gsc_queries WHERE url = ? ORDER BY clicks DESC, impressions DESC').all(url),
    inspection: db.prepare('SELECT verdict, coverage_state, indexing_state, robots_state, page_fetch_state, last_crawl_time, google_canonical, user_canonical, error, fetched_at FROM url_inspection WHERE url = ?').get(url) ?? null,
  };
}

export interface LinkRow {
  url: string;
  type: string;
  anchor: string | null;
  nofollow: number;
  status: number | null;
}

export function urlLinks(db: Db, url: string, direction: 'in' | 'out', options: { limit?: number; offset?: number } = {}): Page<LinkRow> {
  const limit = Math.min(options.limit ?? 50, 1000);
  const offset = options.offset ?? 0;
  const [mine, other] = direction === 'in' ? ['target_id', 'source_id'] : ['source_id', 'target_id'];
  const from = `FROM links l JOIN urls me ON me.id = l.${mine} JOIN urls o ON o.id = l.${other} LEFT JOIN responses r ON r.url_id = o.id WHERE me.url = ?`;
  const { n } = db.prepare(`SELECT COUNT(*) AS n ${from}`).get(url) as { n: number };
  const items = db.prepare(`SELECT o.url, l.type, l.anchor, l.nofollow, r.status ${from} ORDER BY o.url LIMIT ? OFFSET ?`).all(url, limit, offset) as LinkRow[];
  return { total: n, offset, limit, items };
}

export interface TrafficPull {
  source: string;
  account: string | null;
  property: string | null;
  days: number | null;
  start_date: string | null;
  end_date: string | null;
  fetched_at: string;
  status: string;
  row_count: number;
  matched: number;
  dropped: number;
  note: string | null;
  error: string | null;
}

export function trafficPulls(db: Db): TrafficPull[] {
  return db.prepare('SELECT * FROM traffic_pulls ORDER BY source').all() as TrafficPull[];
}
