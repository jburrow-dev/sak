import { getMeta, isInternal, normalizeUrl, type Db } from '@sak/core';

const withoutSlash = (path: string) => (path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path);

/** Ignores the scheme, www and a trailing slash. Query strings still have to match. */
function looseKey(url: URL): string {
  return `${url.hostname.toLowerCase().replace(/^www\./, '')}${withoutSlash(url.pathname)}${url.search}`;
}

export interface ResolvedUrl {
  url: string;
  matched: boolean;
}

export class UrlMatcher {
  private exact: Set<string>;
  private loose = new Map<string, string[]>();

  constructor(urls: Iterable<string>) {
    this.exact = new Set(urls);
    for (const url of this.exact) {
      const key = looseKey(new URL(url));
      this.loose.set(key, [...(this.loose.get(key) ?? []), url]);
    }
  }

  /** The crawled URL this one refers to, or null. A URL that could be either of two pages matches neither. */
  find(url: string): string | null {
    if (this.exact.has(url)) return url;
    const parsed = new URL(url);
    if (parsed.pathname !== '/') {
      const toggled = new URL(url);
      toggled.pathname = parsed.pathname.endsWith('/') ? withoutSlash(parsed.pathname) : `${parsed.pathname}/`;
      if (this.exact.has(toggled.toString())) return toggled.toString();
    }
    const candidates = this.loose.get(looseKey(parsed)) ?? [];
    return candidates.length === 1 ? candidates[0] : null;
  }
}

/**
 * Maps a URL from an outside source onto the crawl. Returns null for anything outside the crawl's
 * scope: a domain property reports every subdomain, and those aren't pages this crawl missed.
 */
export function crawlResolver(db: Db): (raw: string) => ResolvedUrl | null {
  const startUrl = getMeta(db, 'start_url');
  const config = getMeta(db, 'config');
  const subdomains = config ? Boolean((JSON.parse(config) as { crawlSubdomains?: boolean }).crawlSubdomains) : false;
  const matcher = new UrlMatcher((db.prepare(`SELECT url FROM urls WHERE kind = 'page'`).all() as { url: string }[]).map((r) => r.url));
  return (raw) => {
    const url = normalizeUrl(raw);
    if (!url) return null;
    if (startUrl && !isInternal(url, startUrl, subdomains)) return null;
    const found = matcher.find(url);
    return found ? { url: found, matched: true } : { url, matched: false };
  };
}

export interface GroupedRows<T> {
  groups: Map<string, { bucket: T; source: string | null }>;
  matched: number;
  unmatched: number;
  dropped: number;
}

/** Adds up rows that resolve to one URL, so a URL with and without its slash can't overwrite each other. */
export function groupRows<R, T>(rows: R[], urlOf: (row: R) => string | null, resolve: (raw: string) => ResolvedUrl | null, start: (row: R) => T, merge: (bucket: T, row: R) => void): GroupedRows<T> {
  const result: GroupedRows<T> = { groups: new Map(), matched: 0, unmatched: 0, dropped: 0 };
  for (const row of rows) {
    const raw = urlOf(row);
    const resolved = raw ? resolve(raw) : null;
    if (!raw || !resolved) {
      result.dropped += 1;
      continue;
    }
    if (resolved.matched) result.matched += 1;
    else result.unmatched += 1;
    const existing = result.groups.get(resolved.url);
    if (existing) merge(existing.bucket, row);
    else result.groups.set(resolved.url, { bucket: start(row), source: raw === resolved.url ? null : raw });
  }
  return result;
}

export const weightedAverage = (a: number, aWeight: number, b: number, bWeight: number) => (aWeight + bWeight > 0 ? (a * aWeight + b * bWeight) / (aWeight + bWeight) : a);
