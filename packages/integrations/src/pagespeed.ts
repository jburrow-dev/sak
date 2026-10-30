import type { Db } from '@sak/core';
import type { SecretStore } from './secrets.ts';

export interface PageSpeedResult {
  url: string;
  strategy: string;
  performance: number | null;
  lcp_ms: number | null;
  cls: number | null;
  inp_ms: number | null;
  ttfb_ms: number | null;
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
  };
}

/** The most-linked indexable pages, which is where speed fixes matter most. */
export function pagesForSpeedTest(db: Db, limit: number): string[] {
  const rows = db.prepare(`SELECT u.url FROM urls u
    LEFT JOIN links l ON l.target_id = u.id AND l.type = 'a'
    WHERE u.kind = 'page' AND u.indexable = 1
    GROUP BY u.id ORDER BY COUNT(l.source_id) DESC, u.id LIMIT ?`).all(limit) as { url: string }[];
  return rows.map((r) => r.url);
}

export async function runPageSpeed(db: Db, secrets: SecretStore, urls: string[], strategy: 'mobile' | 'desktop', fetchImpl: typeof fetch = fetch): Promise<PageSpeedResult[]> {
  const key = await secrets.get('pagespeed');
  const insert = db.prepare('INSERT OR REPLACE INTO pagespeed (url, strategy, performance, lcp_ms, cls, inp_ms, ttfb_ms) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const results: PageSpeedResult[] = [];
  for (const url of urls) {
    const endpoint = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
    endpoint.search = new URLSearchParams({ url, strategy, category: 'performance', ...(key ? { key } : {}) }).toString();
    try {
      const response = await fetchImpl(endpoint, { signal: AbortSignal.timeout(120_000) });
      const data = (await response.json()) as any;
      if (!response.ok) throw new Error(data.error?.message ?? `HTTP ${response.status}`);
      const parsed = parsePageSpeed(url, strategy, data);
      insert.run(url, strategy, parsed.performance, parsed.lcp_ms, parsed.cls, parsed.inp_ms, parsed.ttfb_ms);
      results.push(parsed);
    } catch (error) {
      results.push({ url, strategy, performance: null, lcp_ms: null, cls: null, inp_ms: null, ttfb_ms: null, error: (error as Error).message });
    }
  }
  return results;
}
