import type { Db } from '@sak/core';
import { bingCall, resolveBingAccount } from './connections.ts';
import type { ImportResult, PropertyOption } from './google.ts';
import { crawlResolver, groupRows, weightedAverage } from './match.ts';
import { recordPull } from './pulls.ts';
import type { SecretStore } from './secrets.ts';

const DAY_MS = 86_400_000;

/** Bing's JSON dates look like /Date(1316156400000-0700)/. The first number is already UTC. */
export function parseBingDate(value: unknown): number | null {
  const match = typeof value === 'string' ? value.match(/\/Date\((-?\d+)/) : null;
  return match ? Number(match[1]) : null;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

interface BingRow {
  Query: string;
  Clicks: number;
  Impressions: number;
  AvgClickPosition: number;
  AvgImpressionPosition: number;
  Date?: string;
}

/**
 * Bing takes no date range, so the window is applied here from the dates on its rows. If they
 * can't narrow the data, it stores what Bing reported and says so, rather than claiming a window.
 */
export function bingWindow(rows: BingRow[], days: number, now: Date = new Date()): { rows: BingRow[]; days: number | null; startDate: string | null; endDate: string | null; note: string } {
  const dates = [...new Set(rows.map((r) => parseBingDate(r.Date)).filter((d): d is number => d !== null))].sort((a, b) => a - b);
  const newest = dates.at(-1);
  if (newest === undefined || dates.length < 2) {
    return { rows, days: null, startDate: null, endDate: newest === undefined ? null : day(newest), note: `Bing reported ${newest === undefined ? 'no dates for this data' : 'a single period for this data'}, so it could not be narrowed to ${days} days. It covers Bing's own reporting period.` };
  }
  const start = now.getTime() - days * DAY_MS;
  const inside = rows.filter((r) => (parseBingDate(r.Date) ?? 0) >= start);
  const oldest = inside.reduce((low, r) => Math.min(low, parseBingDate(r.Date) ?? low), newest);
  const short = dates[0] > start ? ` Bing only returned data from ${day(dates[0])}.` : '';
  return { rows: inside, days, startDate: day(oldest), endDate: day(newest), note: `Bing updates this weekly and groups it by period, so the ${days} days are approximate.${short}` };
}

export async function listBingSites(secrets: SecretStore, account?: string, fetchImpl: typeof fetch = fetch): Promise<PropertyOption[]> {
  const sites = await bingCall(secrets, resolveBingAccount(account), 'GetUserSites', {}, fetchImpl);
  return (Array.isArray(sites) ? sites : [])
    .filter((site: any) => site.IsVerified !== false)
    .map((site: any) => ({ id: site.Url, label: site.Url }));
}

export async function importBing(db: Db, secrets: SecretStore, site: string, days: number, fetchImpl: typeof fetch = fetch, account?: string, now: Date = new Date()): Promise<ImportResult> {
  const chosen = resolveBingAccount(account);
  const data = await bingCall(secrets, chosen, 'GetPageStats', { siteUrl: site }, fetchImpl);
  const all = (Array.isArray(data) ? data : []) as BingRow[];
  const window = bingWindow(all, days, now);
  const grouped = groupRows(window.rows, (row) => row.Query, crawlResolver(db), (row) => ({ clicks: row.Clicks, impressions: row.Impressions, clickPosition: row.AvgClickPosition, impressionPosition: row.AvgImpressionPosition }), (bucket, row) => {
    bucket.clickPosition = weightedAverage(bucket.clickPosition, bucket.clicks, row.AvgClickPosition, row.Clicks);
    bucket.impressionPosition = weightedAverage(bucket.impressionPosition, bucket.impressions, row.AvgImpressionPosition, row.Impressions);
    bucket.clicks += row.Clicks;
    bucket.impressions += row.Impressions;
  });
  db.transaction(() => {
    db.exec('DELETE FROM bing_webmaster');
    const insert = db.prepare('INSERT INTO bing_webmaster (url, clicks, impressions, click_position, impression_position, source_url) VALUES (?, ?, ?, ?, ?, ?)');
    for (const [url, { bucket, source }] of grouped.groups) insert.run(url, bucket.clicks, bucket.impressions, bucket.clickPosition, bucket.impressionPosition, source);
    recordPull(db, { source: 'bing', account: chosen, property: site, days: window.days, startDate: window.startDate, endDate: window.endDate, rows: window.rows.length, matched: grouped.matched, dropped: grouped.dropped, note: window.note });
  })();
  return { rows: window.rows.length, matched: grouped.matched, unmatched: grouped.unmatched, dropped: grouped.dropped };
}
