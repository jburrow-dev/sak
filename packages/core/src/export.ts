import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import type { Db } from './db.ts';
import { listIssues, listUrls, type Page } from './query.ts';

export type ExportKind = 'urls' | 'issues' | 'links';

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  // Stops page-controlled text from running as a formula when the CSV opens in a spreadsheet.
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const URL_COLUMNS = ['url', 'kind', 'status', 'depth', 'indexable', 'indexability_reason', 'redirect_target', 'title', 'meta_description', 'h1', 'canonical', 'word_count', 'inlinks', 'in_sitemap', 'response_ms', 'issue_count', 'clicks', 'impressions', 'ctr', 'position', 'sessions', 'engaged_sessions', 'users', 'views', 'key_events', 'bing_clicks', 'bing_impressions', 'bing_position', 'error', 'blocked_reason'] as const;
const ISSUE_COLUMNS = ['type', 'severity', 'url', 'detail'] as const;
const PAGE_SIZE = 1000;

function pagedCsv(columns: readonly string[], load: (limit: number, offset: number) => Page<object>): string {
  const lines = [columns.map(csvCell).join(',')];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { items } = load(PAGE_SIZE, offset);
    for (const item of items) lines.push(columns.map((column) => csvCell((item as Record<string, unknown>)[column])).join(','));
    if (items.length < PAGE_SIZE) break;
  }
  return `${lines.join('\n')}\n`;
}

/** The filtered view the UI is showing, unlike exportCsv, which writes everything to a file. */
export function issuesCsv(db: Db, filter: Parameters<typeof listIssues>[1] = {}): string {
  return pagedCsv(ISSUE_COLUMNS, (limit, offset) => listIssues(db, { ...filter, limit, offset }));
}

export function urlsCsv(db: Db, filter: Parameters<typeof listUrls>[1] = {}): string {
  return pagedCsv(URL_COLUMNS, (limit, offset) => listUrls(db, { ...filter, limit, offset }));
}

function* rows(db: Db, kind: ExportKind): Generator<unknown[]> {
  if (kind === 'issues') {
    yield ['type', 'severity', 'url', 'detail'];
    for (const r of db.prepare('SELECT type, severity, url, detail FROM issues ORDER BY type, url').iterate() as Iterable<any>) yield [r.type, r.severity, r.url, r.detail];
  } else if (kind === 'links') {
    yield ['source', 'target', 'type', 'anchor', 'nofollow', 'target_status'];
    const sql = `SELECT s.url AS source, t.url AS target, l.type, l.anchor, l.nofollow, r.status FROM links l
      JOIN urls s ON s.id = l.source_id JOIN urls t ON t.id = l.target_id LEFT JOIN responses r ON r.url_id = t.id`;
    for (const r of db.prepare(sql).iterate() as Iterable<any>) yield [r.source, r.target, r.type, r.anchor, r.nofollow, r.status];
  } else {
    yield [...URL_COLUMNS];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { items } = listUrls(db, { limit: PAGE_SIZE, offset });
      for (const item of items) yield URL_COLUMNS.map((c) => item[c]);
      if (items.length < PAGE_SIZE) break;
    }
  }
}

export async function exportCsv(db: Db, kind: ExportKind, path: string): Promise<number> {
  const stream = createWriteStream(path);
  let count = -1;
  for (const row of rows(db, kind)) {
    if (!stream.write(`${row.map(csvCell).join(',')}\n`)) await new Promise<void>((resolve) => stream.once('drain', () => resolve()));
    count += 1;
  }
  stream.end();
  await finished(stream);
  return count;
}
