import type { IssueFinding, UrlRow } from '../types.ts';

export interface SitePage {
  url: string;
  title: string | null;
  meta: string | null;
  textHash: string | null;
  canonical: string | null;
}

export interface SiteLink {
  source: string;
  target: string;
  type: string;
}

export interface SiteInput {
  startUrl: string;
  urls: UrlRow[];
  pages: SitePage[];
  links: SiteLink[];
  hreflang: { url: string; lang: string; href: string }[];
}

export interface RedirectChain {
  start: string;
  hops: { url: string; status: number | null }[];
  loop: boolean;
}

/** Follows stored redirect targets. Only chain heads are returned, so a chain reports once. */
export function buildRedirectChains(urls: UrlRow[]): RedirectChain[] {
  const byUrl = new Map(urls.map((u) => [u.url, u]));
  const redirecting = urls.filter((u) => u.kind === 'page' && u.redirect_target);
  const targets = new Set(redirecting.map((u) => u.redirect_target));
  const chains: RedirectChain[] = [];
  for (const head of redirecting) {
    const hops: RedirectChain['hops'] = [];
    const seen = new Set<string>();
    let current: UrlRow | undefined = head;
    let loop = false;
    while (current) {
      if (seen.has(current.url)) {
        loop = true;
        break;
      }
      seen.add(current.url);
      hops.push({ url: current.url, status: current.status });
      if (!current.redirect_target) break;
      if (!byUrl.has(current.redirect_target)) {
        hops.push({ url: current.redirect_target, status: null });
        break;
      }
      current = byUrl.get(current.redirect_target);
    }
    // A pure loop has no head, so keep the lowest id as its representative.
    const isHead = !targets.has(head.url);
    const isLoopRepresentative = loop && head === redirecting.find((u) => seen.has(u.url));
    if (isHead || isLoopRepresentative) chains.push({ start: head.url, hops, loop });
  }
  return chains;
}

export function checkStatuses(urls: UrlRow[]): IssueFinding[] {
  const out: IssueFinding[] = [];
  for (const row of urls) {
    if (row.kind !== 'page') continue;
    if (row.state === 'blocked_robots') {
      out.push({ type: 'robots_blocked', url: row.url });
    } else if (row.blocked_reason) {
      out.push({ type: 'status_blocked', url: row.url, detail: row.blocked_reason });
    } else if (row.error) {
      out.push({ type: 'status_failed', url: row.url, detail: row.error });
    } else if (row.status !== null) {
      if (row.status >= 500) out.push({ type: 'status_5xx', url: row.url, detail: String(row.status) });
      else if (row.status >= 400) out.push({ type: 'status_4xx', url: row.url, detail: String(row.status) });
      else if (row.status >= 300) out.push({ type: 'status_3xx', url: row.url, detail: `${row.status} to ${row.redirect_target ?? '(no target)'}` });
    }
  }
  return out;
}

export function checkRedirectChains(chains: RedirectChain[]): IssueFinding[] {
  return chains.flatMap((chain) => {
    const path = chain.hops.map((h) => h.url).join(' -> ');
    if (chain.loop) return [{ type: 'redirect_loop', url: chain.start, detail: path }];
    return chain.hops.length > 2 ? [{ type: 'redirect_chain', url: chain.start, detail: `${chain.hops.length - 1} redirects: ${path}` }] : [];
  });
}

const EXTERNAL_REFUSAL = new Set([401, 403, 405, 406, 429, 451, 999]);

export function checkLinks(input: SiteInput): IssueFinding[] {
  const byUrl = new Map(input.urls.map((u) => [u.url, u]));
  const out: IssueFinding[] = [];
  for (const link of input.links) {
    if (link.type !== 'a' && link.type !== 'img') continue;
    const target = byUrl.get(link.target);
    if (!target) continue;
    const label = target.status === null ? (target.error ?? 'no response') : String(target.status);
    const detail = `${link.target} (${label})`;
    const failed = target.error !== null || (target.status !== null && target.status >= 400);
    if (link.type === 'img') {
      if (failed) out.push({ type: 'image_broken', url: link.source, detail });
    } else if (target.kind === 'external') {
      if (target.status !== null && (EXTERNAL_REFUSAL.has(target.status) || target.blocked_reason)) out.push({ type: 'link_external_unverified', url: link.source, detail });
      else if (failed) out.push({ type: 'link_broken_external', url: link.source, detail });
    } else if (!target.blocked_reason) {
      if (failed) out.push({ type: 'link_broken_internal', url: link.source, detail });
      else if (target.status !== null && target.status >= 300 && target.status < 400) out.push({ type: 'link_to_redirect', url: link.source, detail: `${link.target} (${target.status})` });
    }
  }
  return out;
}

function groupDuplicates(pages: SitePage[], key: (p: SitePage) => string | null, type: string): IssueFinding[] {
  const groups = new Map<string, string[]>();
  for (const page of pages) {
    const value = key(page);
    if (!value) continue;
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value)!.push(page.url);
  }
  const out: IssueFinding[] = [];
  for (const urls of groups.values()) {
    if (urls.length < 2) continue;
    for (const url of urls) out.push({ type, url, detail: `${urls.length} pages share this` });
  }
  return out;
}

export function checkDuplicates(pages: SitePage[], urls: UrlRow[]): IssueFinding[] {
  const indexable = new Set(urls.filter((u) => u.indexable === 1).map((u) => u.url));
  const candidates = pages.filter((p) => indexable.has(p.url));
  return [
    ...groupDuplicates(candidates, (p) => p.title, 'title_duplicate'),
    ...groupDuplicates(candidates, (p) => p.meta, 'meta_duplicate'),
    ...groupDuplicates(candidates, (p) => p.textHash, 'duplicate_exact'),
  ];
}

export function checkCanonicalTargets(input: SiteInput): IssueFinding[] {
  const byUrl = new Map(input.urls.map((u) => [u.url, u]));
  const out: IssueFinding[] = [];
  for (const page of input.pages) {
    if (!page.canonical || page.canonical === page.url) continue;
    const target = byUrl.get(page.canonical);
    if (!target) continue;
    const noindex = target.indexability_reason === 'noindex';
    const bad = target.state === 'blocked_robots' || noindex || target.error !== null || (target.status !== null && target.status !== 200);
    if (bad) {
      const why = target.state === 'blocked_robots' ? 'blocked by robots.txt' : noindex ? 'noindex' : (target.error ?? String(target.status));
      out.push({ type: 'canonical_target_bad', url: page.url, detail: `${page.canonical} (${why})` });
    }
  }
  return out;
}

export function checkHreflangTargets(input: SiteInput): IssueFinding[] {
  const byUrl = new Map(input.urls.map((u) => [u.url, u]));
  const declared = new Map<string, Set<string>>();
  for (const { url, href } of input.hreflang) {
    if (!declared.has(url)) declared.set(url, new Set());
    declared.get(url)!.add(href);
  }
  const out: IssueFinding[] = [];
  const seen = new Set<string>();
  for (const { url, lang, href } of input.hreflang) {
    if (href === url || seen.has(`${url} ${href}`)) continue;
    seen.add(`${url} ${href}`);
    const target = byUrl.get(href);
    if (!target) continue;
    if (target.status !== 200) {
      out.push({ type: 'hreflang_target_bad', url, detail: `${lang}: ${href} (${target.status ?? target.error ?? target.state})` });
    } else if (!declared.get(href)?.has(url)) {
      out.push({ type: 'hreflang_no_return', url, detail: `${lang}: ${href}` });
    }
  }
  return out;
}

export function checkLinkGraph(input: SiteInput): IssueFinding[] {
  const inlinks = new Map<string, Set<string>>();
  for (const link of input.links) {
    if (link.type !== 'a' || link.source === link.target) continue;
    if (!inlinks.has(link.target)) inlinks.set(link.target, new Set());
    inlinks.get(link.target)!.add(link.source);
  }
  const out: IssueFinding[] = [];
  for (const row of input.urls) {
    if (row.kind !== 'page') continue;
    const count = inlinks.get(row.url)?.size ?? 0;
    const live = row.status === 200;
    if (row.in_sitemap && row.url !== input.startUrl) {
      if (row.indexable !== 1) out.push({ type: 'sitemap_non_indexable', url: row.url, detail: row.indexability_reason ?? undefined });
      if (live && count === 0) out.push({ type: 'sitemap_orphan', url: row.url });
    }
    if (live && row.indexable === 1) {
      if (row.depth !== null && row.depth >= 4) out.push({ type: 'deep_page', url: row.url, detail: `depth ${row.depth}` });
      if (count === 1 && row.url !== input.startUrl) out.push({ type: 'low_inlinks', url: row.url });
    }
  }
  return out;
}

export function runSiteChecks(input: SiteInput, chains: RedirectChain[]): IssueFinding[] {
  return [
    ...checkStatuses(input.urls),
    ...checkRedirectChains(chains),
    ...checkLinks(input),
    ...checkDuplicates(input.pages, input.urls),
    ...checkCanonicalTargets(input),
    ...checkHreflangTargets(input),
    ...checkLinkGraph(input),
  ];
}
