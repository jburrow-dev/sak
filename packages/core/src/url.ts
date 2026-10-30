/** Canonical form used as the identity of a URL throughout a crawl. */
export function normalizeUrl(input: string, base?: string): string | null {
  let parsed: URL;
  try {
    parsed = base ? new URL(input.trim(), base) : new URL(input.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  parsed.hash = '';
  return parsed.toString();
}

/** www and non-www are one site; other subdomains are external. */
export function siteHost(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
}

export function isInternal(url: string, startUrl: string, crawlSubdomains = false): boolean {
  const host = siteHost(url);
  const site = siteHost(startUrl);
  return host === site || (crawlSubdomains && host.endsWith(`.${site}`));
}

export function compileFilters(include: string[], exclude: string[]) {
  const inc = include.map((p) => new RegExp(p));
  const exc = exclude.map((p) => new RegExp(p));
  return (url: string): boolean => {
    if (exc.some((r) => r.test(url))) return false;
    return inc.length === 0 || inc.some((r) => r.test(url));
  };
}
