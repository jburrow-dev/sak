import type { IssueFinding, UrlRow } from '../types.ts';

export interface SitePage {
  url: string;
  title: string | null;
  meta: string | null;
  textHash: string | null;
  canonical: string | null;
  simhash?: string | null;
}

export interface SiteLink {
  source: string;
  target: string;
  type: string;
  anchor?: string | null;
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
      if (row.status === 302 || row.status === 303 || row.status === 307) out.push({ type: 'redirect_temporary', url: row.url, detail: `${row.status} to ${row.redirect_target ?? '(no target)'}` });
    }
  }
  return out;
}

const SLOW_RESPONSE_MS = 1000;
const HEAVY_PAGE_BYTES = 1024 * 1024;
const HEAVY_ASSET_BYTES = 512_000;
const COMPRESSIBLE_BYTES = 1024;

/** Reads response headers, which are NULL on crawls saved before SAK kept them. */
export function checkDelivery(urls: UrlRow[]): IssueFinding[] {
  const out: IssueFinding[] = [];
  for (const row of urls) {
    if (row.status !== 200) continue;
    if (row.truncated) out.push({ type: 'html_truncated', url: row.url, detail: `${row.bytes} bytes` });
    if (row.kind === 'page') {
      if (row.response_ms !== null && row.response_ms > SLOW_RESPONSE_MS) out.push({ type: 'page_slow', url: row.url, detail: `${row.response_ms} ms` });
      if (row.bytes !== null && row.bytes > HEAVY_PAGE_BYTES) out.push({ type: 'page_heavy', url: row.url, detail: `${row.bytes} bytes` });
    }
    const asset = row.kind === 'image' || row.kind === 'css' || row.kind === 'script';
    if (asset && row.bytes !== null && row.bytes > HEAVY_ASSET_BYTES) out.push({ type: 'asset_heavy', url: row.url, detail: `${row.bytes} bytes` });
    const text = row.kind === 'css' || row.kind === 'script' || (row.kind === 'page' && /html/i.test(row.content_type ?? ''));
    if (text && row.content_encoding === '' && (row.bytes ?? 0) >= COMPRESSIBLE_BYTES) out.push({ type: 'no_compression', url: row.url, detail: `${row.bytes} bytes` });
    if (asset && row.cache_control !== null && row.cache_control !== undefined && (row.cache_control === '' || /no-store/i.test(row.cache_control))) out.push({ type: 'asset_no_cache', url: row.url, detail: row.cache_control || 'No Cache-Control header' });
  }
  return out;
}

export function checkMixedContent(input: SiteInput): IssueFinding[] {
  const out: IssueFinding[] = [];
  for (const link of input.links) {
    if ((link.type === 'img' || link.type === 'css' || link.type === 'script') && link.source.startsWith('https:') && link.target.startsWith('http:')) {
      out.push({ type: 'mixed_content', url: link.source, detail: link.target });
    }
  }
  return out;
}

const SESSION_PARAM = /^(sid|sessionid|session_id|phpsessid|jsessionid|aspsessionid)$/i;

export function checkUrlShape(urls: UrlRow[]): IssueFinding[] {
  const out: IssueFinding[] = [];
  for (const row of urls) {
    if (row.kind !== 'page' || row.status !== 200) continue;
    const parsed = new URL(row.url);
    const params = [...parsed.searchParams.keys()];
    if (params.some((name) => SESSION_PARAM.test(name))) out.push({ type: 'url_session_id', url: row.url });
    if (row.indexable === 1 && params.length > 0) out.push({ type: 'url_parameters', url: row.url, detail: params.join(', ') });
    if (/[A-Z]/.test(parsed.pathname)) out.push({ type: 'url_uppercase', url: row.url });
  }
  return out;
}

const hamming = (a: string, b: string) => {
  let distance = 0;
  for (let xor = BigInt(`0x${a}`) ^ BigInt(`0x${b}`); xor; xor &= xor - 1n) distance += 1;
  return distance;
};

const NEAR_DUPLICATE_BITS = 3;
const MAX_BAND_SIZE = 500;

/**
 * Two fingerprints within 3 bits must agree on at least one of four 16-bit bands, so only pages
 * sharing a band are compared. A huge band is template text, which would make this quadratic.
 */
export function checkNearDuplicates(pages: SitePage[], urls: UrlRow[]): IssueFinding[] {
  const indexable = new Set(urls.filter((u) => u.indexable === 1).map((u) => u.url));
  const candidates = pages.filter((p) => p.simhash && indexable.has(p.url));
  const bands = new Map<string, SitePage[]>();
  for (const page of candidates) {
    for (let band = 0; band < 4; band++) {
      const key = `${band}:${page.simhash!.slice(band * 4, band * 4 + 4)}`;
      if (!bands.has(key)) bands.set(key, []);
      bands.get(key)!.push(page);
    }
  }
  const closest = new Map<string, string>();
  for (const group of bands.values()) {
    if (group.length < 2 || group.length > MAX_BAND_SIZE) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [a, b] = [group[i], group[j]];
        // Exact matches have their own issue.
        if (a.textHash === b.textHash || hamming(a.simhash!, b.simhash!) > NEAR_DUPLICATE_BITS) continue;
        if (!closest.has(a.url)) closest.set(a.url, b.url);
        if (!closest.has(b.url)) closest.set(b.url, a.url);
      }
    }
  }
  return [...closest].map(([url, other]) => ({ type: 'near_duplicate', url, detail: `Very similar to ${other}` }));
}

const GENERIC_ANCHOR = /^(click here|here|read more|learn more|more|this page|link|details)$/i;

export function checkAnchors(input: SiteInput): IssueFinding[] {
  const internal = new Set(input.urls.filter((u) => u.kind === 'page').map((u) => u.url));
  const counts = new Map<string, Map<string, number>>();
  for (const link of input.links) {
    if (link.type !== 'a' || !link.anchor || !internal.has(link.target) || !GENERIC_ANCHOR.test(link.anchor.trim())) continue;
    if (!counts.has(link.source)) counts.set(link.source, new Map());
    const anchors = counts.get(link.source)!;
    anchors.set(link.anchor.trim(), (anchors.get(link.anchor.trim()) ?? 0) + 1);
  }
  return [...counts].map(([url, anchors]) => ({ type: 'link_generic_anchor', url, detail: [...anchors].map(([anchor, n]) => `"${anchor}" x${n}`).join(', ') }));
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
    if (link.type !== 'a' && link.type !== 'img' && link.type !== 'css' && link.type !== 'script') continue;
    const target = byUrl.get(link.target);
    if (!target) continue;
    const label = target.status === null ? (target.error ?? 'no response') : String(target.status);
    const detail = `${link.target} (${label})`;
    const failed = target.error !== null || (target.status !== null && target.status >= 400);
    if (link.type === 'img') {
      if (failed) out.push({ type: 'image_broken', url: link.source, detail });
    } else if (link.type === 'css' || link.type === 'script') {
      if (failed && !target.blocked_reason) out.push({ type: link.type === 'css' ? 'css_broken' : 'script_broken', url: link.source, detail });
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
    ...checkDelivery(input.urls),
    ...checkMixedContent(input),
    ...checkUrlShape(input.urls),
    ...checkNearDuplicates(input.pages, input.urls),
    ...checkAnchors(input),
  ];
}

const PAGERANK_DAMPING = 0.85;
const PAGERANK_ROUNDS = 20;

/** Internal PageRank over followed links between live pages, scaled so the strongest page is 100. */
export function linkScores(pages: string[], links: { source: string; target: string }[]): Map<string, number> {
  const index = new Map(pages.map((url, i) => [url, i]));
  const outgoing = pages.map(() => new Set<number>());
  for (const { source, target } of links) {
    const [from, to] = [index.get(source), index.get(target)];
    if (from !== undefined && to !== undefined && from !== to) outgoing[from].add(to);
  }
  const n = pages.length;
  let scores = new Array<number>(n).fill(1 / Math.max(n, 1));
  for (let round = 0; round < PAGERANK_ROUNDS; round++) {
    const next = new Array<number>(n).fill((1 - PAGERANK_DAMPING) / n);
    let dangling = 0;
    outgoing.forEach((targets, from) => {
      if (targets.size === 0) dangling += scores[from];
      else for (const to of targets) next[to] += (PAGERANK_DAMPING * scores[from]) / targets.size;
    });
    scores = next.map((score) => score + (PAGERANK_DAMPING * dangling) / n);
  }
  const max = Math.max(...scores, 0);
  return new Map(pages.map((url, i) => [url, max > 0 ? Math.round((scores[i] / max) * 1000) / 10 : 0]));
}
