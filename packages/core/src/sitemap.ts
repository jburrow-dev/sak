import { gunzipSync } from 'node:zlib';
import * as cheerio from 'cheerio';
import { normalizeUrl } from './url.ts';

const MAX_SITEMAP_FILES = 50;

export function parseSitemap(xml: string): { urls: string[]; children: string[] } {
  const $ = cheerio.load(xml, { xml: true });
  const read = (selector: string) => $(selector).toArray().map((el) => $(el).text().trim()).filter(Boolean);
  return { urls: read('urlset > url > loc'), children: read('sitemapindex > sitemap > loc') };
}

/** Walks sitemap indexes breadth-first and returns every page URL listed. */
export async function collectSitemapUrls(
  seeds: string[],
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ urls: string[]; files: string[] }> {
  const queue = [...new Set(seeds)];
  const seen = new Set<string>();
  const urls = new Set<string>();
  while (queue.length && seen.size < MAX_SITEMAP_FILES) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    try {
      const response = await fetch(next, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) continue;
      let buffer: Buffer = Buffer.from(await response.arrayBuffer());
      if (buffer[0] === 0x1f && buffer[1] === 0x8b) buffer = gunzipSync(buffer);
      const parsed = parseSitemap(buffer.toString('utf8'));
      for (const url of parsed.urls) {
        const normalized = normalizeUrl(url);
        if (normalized) urls.add(normalized);
      }
      queue.push(...parsed.children);
    } catch {
      // A broken sitemap shouldn't stop the crawl.
    }
  }
  return { urls: [...urls], files: [...seen] };
}
