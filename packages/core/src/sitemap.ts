import { gunzipSync } from 'node:zlib';
import * as cheerio from 'cheerio';
import { normalizeUrl } from './url.ts';

const MAX_SITEMAP_FILES = 50;

export function parseSitemap(xml: string): { urls: string[]; children: string[] } {
  const $ = cheerio.load(xml, { xml: true });
  const read = (selector: string) => $(selector).toArray().map((el) => $(el).text().trim()).filter(Boolean);
  return { urls: read('urlset > url > loc'), children: read('sitemapindex > sitemap > loc') };
}

/** What happened when one sitemap file was fetched. */
export interface SitemapReport {
  url: string;
  status: number | null;
  error: string | null;
  urls: number;
  children: number;
  lastmods: number;
  bytes: number;
}

/** Walks sitemap indexes breadth-first and returns every page URL listed. */
export async function collectSitemapUrls(
  seeds: string[],
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ urls: string[]; files: string[]; reports: SitemapReport[] }> {
  const queue = [...new Set(seeds)];
  const seen = new Set<string>();
  const urls = new Set<string>();
  const reports: SitemapReport[] = [];
  while (queue.length && seen.size < MAX_SITEMAP_FILES) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    const report: SitemapReport = { url: next, status: null, error: null, urls: 0, children: 0, lastmods: 0, bytes: 0 };
    reports.push(report);
    try {
      const response = await fetch(next, { headers, signal: AbortSignal.timeout(timeoutMs) });
      report.status = response.status;
      if (!response.ok) continue;
      let buffer: Buffer = Buffer.from(await response.arrayBuffer());
      if (buffer[0] === 0x1f && buffer[1] === 0x8b) buffer = gunzipSync(buffer);
      report.bytes = buffer.byteLength;
      const xml = buffer.toString('utf8');
      const parsed = parseSitemap(xml);
      report.urls = parsed.urls.length;
      report.children = parsed.children.length;
      report.lastmods = cheerio.load(xml, { xml: true })('urlset > url > lastmod').length;
      for (const url of parsed.urls) {
        const normalized = normalizeUrl(url);
        if (normalized) urls.add(normalized);
      }
      queue.push(...parsed.children);
    } catch (error) {
      // A broken sitemap shouldn't stop the crawl, but it is reported.
      report.error = (error as Error).message;
    }
  }
  return { urls: [...urls], files: [...seen], reports };
}
