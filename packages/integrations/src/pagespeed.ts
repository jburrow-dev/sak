import { getMeta, type Db } from '@sak/core';
import type { SecretStore } from './secrets.ts';

export interface PageSpeedResult {
  url: string;
  strategy: string;
  performance: number | null;
  lcp_ms: number | null;
  cls: number | null;
  inp_ms: number | null;
  ttfb_ms: number | null;
  /** From real users, when Google has enough of them. The figures above are a single lab test. */
  field_lcp_ms: number | null;
  field_cls: number | null;
  error?: string;
}

export function parsePageSpeed(url: string, strategy: string, data: any): PageSpeedResult {
  const audits = data.lighthouseResult?.audits ?? {};
  const field = data.loadingExperience?.metrics ?? {};
  const score = data.lighthouseResult?.categories?.performance?.score;
  return {
    url,
    strategy,
    performance: typeof score === 'number' ? Math.round(score * 100) : null,
    lcp_ms: audits['largest-contentful-paint']?.numericValue ?? null,
    cls: audits['cumulative-layout-shift']?.numericValue ?? null,
    // INP only exists as real-user data, so a page without field data has none.
    inp_ms: field.INTERACTION_TO_NEXT_PAINT?.percentile ?? null,
    ttfb_ms: audits['server-response-time']?.numericValue ?? null,
    field_lcp_ms: field.LARGEST_CONTENTFUL_PAINT_MS?.percentile ?? null,
    // PageSpeed reports CLS multiplied by 100 in this field.
    field_cls: typeof field.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile === 'number' ? field.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100 : null,
  };
}

/** The most-linked indexable pages, which is where speed fixes matter most. */
export function pagesForSpeedTest(db: Db, limit: number): string[] {
  const rows = db.prepare(`SELECT u.url FROM urls u
    LEFT JOIN links l ON l.target_id = u.id AND l.type = 'a'
    WHERE u.kind = 'page' AND u.indexable = 1
    GROUP BY u.id ORDER BY COUNT(DISTINCT l.source_id) DESC, u.id LIMIT ?`).all(limit) as { url: string }[];
  return rows.map((r) => r.url);
}

export async function runPageSpeed(db: Db, secrets: SecretStore, urls: string[], strategy: 'mobile' | 'desktop', fetchImpl: typeof fetch = fetch): Promise<PageSpeedResult[]> {
  const key = await secrets.get('pagespeed');
  const insert = db.prepare('INSERT OR REPLACE INTO pagespeed (url, strategy, performance, lcp_ms, cls, inp_ms, ttfb_ms, field_lcp_ms, field_cls) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const results: PageSpeedResult[] = [];
  for (const url of urls) {
    const endpoint = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
    endpoint.search = new URLSearchParams({ url, strategy, category: 'performance', ...(key ? { key } : {}) }).toString();
    try {
      const response = await fetchImpl(endpoint, { signal: AbortSignal.timeout(120_000) });
      const data = (await response.json()) as any;
      if (!response.ok) throw new Error(data.error?.message ?? `HTTP ${response.status}`);
      const parsed = parsePageSpeed(url, strategy, data);
      insert.run(url, strategy, parsed.performance, parsed.lcp_ms, parsed.cls, parsed.inp_ms, parsed.ttfb_ms, parsed.field_lcp_ms, parsed.field_cls);
      results.push(parsed);
    } catch (error) {
      results.push({ url, strategy, performance: null, lcp_ms: null, cls: null, inp_ms: null, ttfb_ms: null, field_lcp_ms: null, field_cls: null, error: (error as Error).message });
    }
  }
  return results;
}

export interface CruxRow {
  scope: string;
  form_factor: string;
  lcp_ms: number | null;
  cls: number | null;
  inp_ms: number | null;
}

/** Site-wide real-user data. The API has none for sites with little traffic, which isn't an error. */
export async function runCrux(db: Db, secrets: SecretStore, fetchImpl: typeof fetch = fetch): Promise<CruxRow[]> {
  const startUrl = getMeta(db, 'start_url');
  if (!startUrl) throw new Error('This crawl has no start URL');
  const key = await secrets.get('pagespeed');
  if (!key) throw new Error('The Chrome UX Report API needs a Google API key with that API enabled. Run: sak key set pagespeed');
  const origin = new URL(startUrl).origin;
  const insert = db.prepare('INSERT OR REPLACE INTO crux (scope, form_factor, lcp_ms, cls, inp_ms, fetched_at) VALUES (?, ?, ?, ?, ?, ?)');
  const rows: CruxRow[] = [];
  for (const formFactor of ['PHONE', 'DESKTOP']) {
    const response = await fetchImpl(`https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ origin, formFactor }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404) continue;
    const data = (await response.json()) as any;
    // The message is Google's own and doesn't repeat the key, unlike the request URL.
    if (!response.ok) throw new Error(`Chrome UX Report: ${data.error?.message ?? `HTTP ${response.status}`}`);
    const p75 = (name: string) => {
      const value = data.record?.metrics?.[name]?.percentiles?.p75;
      return value === undefined || value === null ? null : Number(value);
    };
    const row: CruxRow = { scope: origin, form_factor: formFactor, lcp_ms: p75('largest_contentful_paint'), cls: p75('cumulative_layout_shift'), inp_ms: p75('interaction_to_next_paint') };
    insert.run(row.scope, row.form_factor, row.lcp_ms, row.cls, row.inp_ms, new Date().toISOString());
    rows.push(row);
  }
  return rows;
}
