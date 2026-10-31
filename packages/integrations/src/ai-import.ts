import type { Db } from '@sak/core';
import { crawlResolver } from './match.ts';
import { recordPull } from './pulls.ts';

export type AiExportSource = 'gsc' | 'bing';

/** Handles quoted fields, doubled quotes, Windows line endings and a byte order mark, as spreadsheet exports use them. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const body = text.replace(/^﻿/, '');
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (quoted) {
      if (char === '"' && body[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((value) => value.trim()));
}

const number = (value: string | undefined) => {
  if (value === undefined) return null;
  const parsed = Number(value.replace(/[,%\s]/g, ''));
  return value.trim() === '' || Number.isNaN(parsed) ? null : parsed;
};

const findColumn = (headers: string[], pattern: RegExp) => headers.findIndex((header) => pattern.test(header));

export interface AiImportResult {
  kind: 'pages' | 'queries';
  rows: number;
  in_crawl: number;
  columns: Record<string, string | null>;
}

/**
 * Loads a Search Console Generative AI or Bing AI Performance export, because neither service has
 * a documented API for these reports. Columns are found by name, since the export formats may change.
 */
export function importAiExport(db: Db, source: AiExportSource, csv: string): AiImportResult {
  const [rawHeaders, ...rows] = parseCsv(csv);
  if (!rawHeaders) throw new Error('This file has no rows');
  const headers = rawHeaders.map((header) => header.trim().toLowerCase());
  const label = (index: number) => (index >= 0 ? rawHeaders[index].trim() : null);
  const queryAt = findColumn(headers, /quer|prompt/);
  const pageAt = findColumn(headers, /page|url/);
  const shareAt = findColumn(headers, /share/);
  const citationsAt = headers.findIndex((header, index) => /citation|cited/.test(header) && index !== shareAt);
  const impressionsAt = findColumn(headers, /impression/);
  const pulledAt = { source: `ai_${source}`, account: null, property: null, days: null, startDate: null, endDate: null, dropped: 0 };

  if (queryAt >= 0) {
    db.transaction(() => {
      db.prepare('DELETE FROM ai_search_queries WHERE source = ?').run(source);
      const insert = db.prepare('INSERT OR REPLACE INTO ai_search_queries (source, query, citations, citation_share) VALUES (?, ?, ?, ?)');
      for (const row of rows) insert.run(source, row[queryAt].trim(), number(row[citationsAt]), number(row[shareAt]));
      recordPull(db, { ...pulledAt, source: `ai_${source}_queries`, rows: rows.length, matched: rows.length, note: 'Imported from an exported file.' });
    })();
    return { kind: 'queries', rows: rows.length, in_crawl: 0, columns: { query: label(queryAt), citations: label(citationsAt), share: label(shareAt) } };
  }
  if (pageAt < 0) throw new Error(`Couldn't find a page or query column. This file has: ${rawHeaders.join(', ')}`);
  const resolve = crawlResolver(db);
  let inCrawl = 0;
  db.transaction(() => {
    db.prepare('DELETE FROM ai_search_pages WHERE source = ?').run(source);
    const insert = db.prepare('INSERT OR REPLACE INTO ai_search_pages (source, url, impressions, citations, in_crawl) VALUES (?, ?, ?, ?, ?)');
    for (const row of rows) {
      const raw = row[pageAt].trim();
      let resolved = null;
      try {
        resolved = resolve(raw);
      } catch {
        // A row that isn't a URL, such as a totals line, is kept as written.
      }
      if (resolved?.matched) inCrawl += 1;
      insert.run(source, resolved?.url ?? raw, number(row[impressionsAt]), number(row[citationsAt]), resolved?.matched ? 1 : 0);
    }
    recordPull(db, { ...pulledAt, rows: rows.length, matched: inCrawl, note: 'Imported from an exported file.' });
  })();
  return { kind: 'pages', rows: rows.length, in_crawl: inCrawl, columns: { page: label(pageAt), impressions: label(impressionsAt), citations: label(citationsAt) } };
}
