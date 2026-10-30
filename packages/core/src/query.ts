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
  };
}

export function listCrawls(): CrawlOverview[] {
  return listCrawlIds().map((id) => withCrawl(id, (db) => crawlOverview(db, id)));
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

export function listIssues(db: Db, filter: { type?: string; severity?: string; url?: string; limit?: number; offset?: number } = {}): Page<IssueRow> {
  const where: string[] = [];
  const params: unknown[] = [];
  for (const column of ['type', 'severity', 'url'] as const) {
    if (filter[column]) {
      where.push(`${column} = ?`);
      params.push(filter[column]);
    }
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(filter.limit ?? 50, 1000);
  const offset = filter.offset ?? 0;
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM issues ${clause}`).get(...params) as { n: number };
  const items = db.prepare(`SELECT type, severity, url, detail FROM issues ${clause} ORDER BY id LIMIT ? OFFSET ?`).all(...params, limit, offset) as IssueRow[];
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
  sessions: number | null;
}

const LIST_SQL = `SELECT base.*,
    json_extract(p.titles, '$[0]') AS title,
    json_extract(p.meta_descriptions, '$[0]') AS meta_description,
    json_extract(p.h1s, '$[0]') AS h1,
    COALESCE(json_extract(p.canonicals, '$[0]'), base.link_canonical) AS canonical,
    p.word_count,
    (SELECT COUNT(DISTINCT l.source_id) FROM links l WHERE l.target_id = base.id AND l.type = 'a') AS inlinks,
    (SELECT COUNT(*) FROM issues i WHERE i.url = base.url) AS issue_count,
    sc.clicks, sc.impressions, an.sessions
  FROM (${URL_ROW_SQL}) base
  LEFT JOIN page_elements p ON p.url_id = base.id
  LEFT JOIN search_console sc ON sc.url = base.url
  LEFT JOIN analytics an ON an.url = base.url`;

const SORTABLE = new Set(['url', 'status', 'depth', 'title', 'word_count', 'inlinks', 'issue_count', 'response_ms', 'clicks', 'impressions', 'sessions']);

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
  const elements = db.prepare('SELECT titles, meta_descriptions, h1s, meta_robots, canonicals FROM page_elements WHERE url_id = ?').get(row.id) as Record<string, string> | undefined;
  const parsed = elements ? Object.fromEntries(Object.entries(elements).map(([k, v]) => [k, JSON.parse(v)])) : null;
  return {
    ...row,
    elements: parsed,
    hreflang: db.prepare('SELECT lang, href FROM hreflang WHERE url_id = ?').all(row.id),
    structured_data_blocks: (db.prepare('SELECT COUNT(*) AS n FROM structured_data WHERE url_id = ?').get(row.id) as { n: number }).n,
    redirect_chain: db.prepare('SELECT hop, url, status FROM redirect_hops WHERE start_id = ? ORDER BY hop').all(row.id),
    issues: db.prepare('SELECT type, severity, detail FROM issues WHERE url = ?').all(url),
    pagespeed: db.prepare('SELECT strategy, performance, lcp_ms, cls, inp_ms, ttfb_ms FROM pagespeed WHERE url = ?').all(url),
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
