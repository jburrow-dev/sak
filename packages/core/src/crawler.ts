import type { CrawlConfig, PageFacts, UrlKind } from './types.ts';
import { DEFAULT_CONFIG } from './types.ts';
import { createCrawlDb, getMeta, openCrawlDb, setMeta, type Db } from './db.ts';
import { compileFilters, isInternal, normalizeUrl, siteHost } from './url.ts';
import { parseHtml, parseLinkHeader } from './parse.ts';
import { HttpFetcher, type Fetcher, type FetchResult } from './fetcher.ts';
import { ChromeRenderer, RenderingFetcher } from './render.ts';
import { RobotsCache } from './robots.ts';
import { collectSitemapUrls } from './sitemap.ts';
import { runAnalysis } from './analysis.ts';

export interface CrawlProgress {
  id: string;
  fetched: number;
  pending: number;
  url: string;
  status: number | null;
}

export interface CrawlOptions {
  fetcher?: Fetcher;
  onProgress?: (progress: CrawlProgress) => void;
  signal?: AbortSignal;
}

export function newCrawlId(startUrl: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${siteHost(startUrl).replace(/[^\w.-]/g, '_')}-${stamp}`;
}

/** Spaces out request starts per host so concurrency can't exceed the rate limit. */
class HostRateLimiter {
  private next = new Map<string, number>();
  private intervalMs: number;

  constructor(requestsPerSecond: number) {
    this.intervalMs = requestsPerSecond > 0 ? 1000 / requestsPerSecond : 0;
  }

  async wait(url: string): Promise<void> {
    const host = new URL(url).hostname;
    const now = Date.now();
    const at = Math.max(now, this.next.get(host) ?? 0);
    this.next.set(host, at + this.intervalMs);
    if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
  }
}

/** Status codes that usually mean the crawler was refused, not that the page is broken. */
function detectBlock(result: FetchResult): string | null {
  const server = (result.headers.get('server') ?? '').toLowerCase();
  const wafHeader = result.headers.has('cf-mitigated') || result.headers.has('x-sucuri-block') || result.headers.has('x-datadome');
  if (result.status === 429) return 'rate limited (429)';
  if (wafHeader) return `WAF challenge (${result.status})`;
  if ((result.status === 403 || result.status === 503) && /cloudflare|sucuri|akamai|imperva|incapsula/.test(server)) {
    return `possible WAF block by ${server} (${result.status})`;
  }
  return null;
}

class Crawl {
  private id: string;
  private db: Db;
  private config: CrawlConfig;
  private fetcher: Fetcher;
  private robots: RobotsCache;
  private limiter: HostRateLimiter;
  private allowed: (url: string) => boolean;
  private options: CrawlOptions;
  private fetched = 0;
  private statements;

  constructor(id: string, db: Db, config: CrawlConfig, options: CrawlOptions) {
    this.id = id;
    this.db = db;
    this.config = config;
    this.options = options;
    this.fetcher = options.fetcher ?? (config.renderJs ? new RenderingFetcher(new HttpFetcher(), new ChromeRenderer(config.userAgent)) : new HttpFetcher());
    this.robots = new RobotsCache(config, this.fetcher);
    this.limiter = new HostRateLimiter(config.requestsPerSecond);
    this.allowed = compileFilters(config.include, config.exclude);
    this.statements = {
      findUrl: db.prepare('SELECT id, depth, kind FROM urls WHERE url = ?'),
      insertUrl: db.prepare('INSERT INTO urls (url, kind, depth) VALUES (?, ?, ?)'),
      updateDepth: db.prepare('UPDATE urls SET depth = ? WHERE id = ? AND (depth IS NULL OR depth > ?)'),
      nextPending: db.prepare(`SELECT id, url, kind, depth FROM urls WHERE state = 'pending' ORDER BY kind = 'page' DESC, depth IS NULL, depth, id LIMIT 1`),
      setState: db.prepare('UPDATE urls SET state = ? WHERE id = ?'),
      countAll: db.prepare(`SELECT COUNT(*) AS n FROM urls WHERE kind = 'page'`),
      countPending: db.prepare(`SELECT COUNT(*) AS n FROM urls WHERE state IN ('pending', 'in_progress')`),
      insertResponse: db.prepare(`INSERT OR REPLACE INTO responses (url_id, status, content_type, redirect_target, x_robots, link_canonical, response_ms, bytes, error, blocked_reason, fetched_at)
        VALUES (@urlId, @status, @contentType, @redirectTarget, @xRobots, @linkCanonical, @responseMs, @bytes, @error, @blockedReason, @fetchedAt)`),
      insertLink: db.prepare('INSERT INTO links (source_id, target_id, type, anchor, nofollow) VALUES (?, ?, ?, ?, ?)'),
      deleteLinks: db.prepare('DELETE FROM links WHERE source_id = ?'),
      insertPage: db.prepare(`INSERT OR REPLACE INTO page_elements (url_id, titles, meta_descriptions, h1s, h2s, meta_robots, canonicals, word_count, text_hash, html_bytes, script_count, has_empty_app_root, rendered, raw_word_count, js_only_links, render_error)
        VALUES (@urlId, @titles, @metaDescriptions, @h1s, @h2s, @metaRobots, @canonicals, @wordCount, @textHash, @htmlBytes, @scriptCount, @hasEmptyAppRoot, @rendered, @rawWordCount, @jsOnlyLinks, @renderError)`),
      deleteHreflang: db.prepare('DELETE FROM hreflang WHERE url_id = ?'),
      insertHreflang: db.prepare('INSERT INTO hreflang (url_id, lang, href) VALUES (?, ?, ?)'),
      deleteJsonLd: db.prepare('DELETE FROM structured_data WHERE url_id = ?'),
      insertJsonLd: db.prepare('INSERT INTO structured_data (url_id, raw) VALUES (?, ?)'),
    };
  }

  private inScope(url: string): boolean {
    return isInternal(url, this.config.startUrl, this.config.crawlSubdomains);
  }

  /** Registers a URL, returning its id, or null when out of scope or over the URL budget. */
  private enqueue(url: string, depth: number | null): number | null {
    const existing = this.statements.findUrl.get(url) as { id: number } | undefined;
    if (existing) {
      if (depth !== null) this.statements.updateDepth.run(depth, existing.id, depth);
      return existing.id;
    }
    const internal = this.inScope(url);
    if (internal) {
      if (!this.allowed(url)) return null;
      if (this.config.maxDepth !== null && depth !== null && depth > this.config.maxDepth) return null;
      const { n } = this.statements.countAll.get() as { n: number };
      if (n >= this.config.maxUrls) return null;
    } else if (!this.config.checkExternal) {
      return null;
    }
    const kind: UrlKind = internal ? 'page' : 'external';
    return Number(this.statements.insertUrl.run(url, kind, depth).lastInsertRowid);
  }

  private enqueueAsset(url: string, kind: 'image' | 'css' | 'script'): number | null {
    const existing = this.statements.findUrl.get(url) as { id: number } | undefined;
    if (existing) return existing.id;
    if (!(kind === 'image' ? this.config.checkImages : this.config.checkResources)) return null;
    return Number(this.statements.insertUrl.run(url, kind, null).lastInsertRowid);
  }

  private async seed(): Promise<void> {
    const starts = [this.config.startUrl, ...this.config.seeds];
    for (const start of starts) this.enqueue(start, 0);
    if (!this.config.useSitemaps) return;
    const sitemaps: string[] = [];
    for (const origin of new Set(starts.map((start) => new URL(start).origin))) {
      const robots = await this.robots.forUrl(origin);
      sitemaps.push(...(robots.sitemaps.length ? robots.sitemaps : [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`]));
    }
    const headers = { ...this.config.headers, 'user-agent': this.config.userAgent };
    const { urls, files } = await collectSitemapUrls(sitemaps, headers, this.config.timeoutMs);
    setMeta(this.db, 'sitemap_files', JSON.stringify(files));
    const mark = this.db.prepare('UPDATE urls SET in_sitemap = 1 WHERE id = ?');
    this.db.transaction(() => {
      for (const url of urls) {
        if (!this.inScope(url)) continue;
        const id = this.enqueue(url, null);
        if (id !== null) mark.run(id);
      }
    })();
  }

  private store(urlId: number, kind: UrlKind, depth: number | null, url: string, result: FetchResult): void {
    const contentType = result.headers.get('content-type');
    const location = result.headers.get('location');
    const isRedirect = result.status >= 300 && result.status < 400 && location;
    const redirectTarget = isRedirect ? normalizeUrl(location, url) : null;
    const linkHeader = parseLinkHeader(result.headers.get('link'), url);
    const facts: PageFacts | null = result.body !== null && result.status < 300 ? parseHtml(result.body, result.finalUrl ?? url) : null;
    const raw = facts && result.rawBody !== undefined ? parseHtml(result.rawBody, url) : null;
    const rawLinks = new Set(raw?.links.map((link) => link.url));

    this.db.transaction(() => {
      this.statements.insertResponse.run({
        urlId,
        status: result.status,
        contentType,
        redirectTarget,
        xRobots: result.headers.get('x-robots-tag'),
        linkCanonical: linkHeader.canonical,
        responseMs: result.elapsedMs,
        bytes: result.bytes,
        error: null,
        blockedReason: detectBlock(result),
        fetchedAt: new Date().toISOString(),
      });
      if (redirectTarget && kind === 'page') {
        // Each hop adds one to depth, matching Screaming Frog.
        const targetId = this.enqueue(redirectTarget, depth === null ? null : depth + 1);
        if (targetId !== null) this.statements.insertLink.run(urlId, targetId, 'redirect', null, 0);
      }
      if (!facts) return;
      this.statements.deleteLinks.run(urlId);
      this.statements.insertPage.run({
        urlId,
        titles: JSON.stringify(facts.titles),
        metaDescriptions: JSON.stringify(facts.metaDescriptions),
        h1s: JSON.stringify(facts.h1s),
        h2s: JSON.stringify(facts.h2s),
        metaRobots: JSON.stringify(facts.metaRobots),
        canonicals: JSON.stringify(facts.canonicals),
        wordCount: facts.wordCount,
        textHash: facts.textHash,
        htmlBytes: facts.htmlBytes,
        scriptCount: facts.scriptCount,
        hasEmptyAppRoot: facts.hasEmptyAppRoot ? 1 : 0,
        rendered: raw ? 1 : 0,
        rawWordCount: raw?.wordCount ?? null,
        jsOnlyLinks: raw ? new Set(facts.links.filter((link) => link.type === 'a' && !rawLinks.has(link.url)).map((link) => link.url)).size : null,
        renderError: result.renderError ?? null,
      });
      const nextDepth = depth === null ? null : depth + 1;
      const followLinks = !this.hasNofollow(facts, result.headers.get('x-robots-tag'));
      for (const link of facts.links) {
        const targetId = link.type !== 'a'
          ? this.enqueueAsset(link.url, link.type === 'img' ? 'image' : link.type)
          : followLinks && !link.nofollow ? this.enqueue(link.url, nextDepth) : this.knownId(link.url);
        if (targetId !== null) this.statements.insertLink.run(urlId, targetId, link.type, link.anchor, link.nofollow ? 1 : 0);
      }
      const hreflang = [...facts.hreflang, ...linkHeader.hreflang];
      this.statements.deleteHreflang.run(urlId);
      for (const entry of hreflang) {
        this.statements.insertHreflang.run(urlId, entry.lang, entry.href);
        this.enqueue(entry.href, nextDepth);
      }
      this.statements.deleteJsonLd.run(urlId);
      for (const block of facts.jsonLd) this.statements.insertJsonLd.run(urlId, block.raw);
      const canonicals = [...facts.canonicals, ...(linkHeader.canonical ? [linkHeader.canonical] : [])];
      for (const canonical of canonicals) {
        const targetId = this.enqueue(canonical, nextDepth);
        if (targetId !== null && targetId !== urlId) this.statements.insertLink.run(urlId, targetId, 'canonical', null, 0);
      }
    })();
  }

  private knownId(url: string): number | null {
    const existing = this.statements.findUrl.get(url) as { id: number } | undefined;
    return existing?.id ?? null;
  }

  private hasNofollow(facts: PageFacts, xRobots: string | null): boolean {
    return [...facts.metaRobots, xRobots ?? ''].some((v) => /\b(nofollow|none)\b/i.test(v));
  }

  private storeError(urlId: number, message: string): void {
    this.statements.insertResponse.run({
      urlId, status: null, contentType: null, redirectTarget: null, xRobots: null, linkCanonical: null,
      responseMs: null, bytes: null, error: message, blockedReason: null, fetchedAt: new Date().toISOString(),
    });
  }

  private async fetchWithRetry(url: string, kind: UrlKind): Promise<FetchResult> {
    const headers = { accept: 'text/html,application/xhtml+xml,*/*;q=0.8', ...this.config.headers, 'user-agent': this.config.userAgent };
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.retries; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
      await this.limiter.wait(url);
      try {
        const result = await this.fetcher.fetch({
          url,
          headers,
          timeoutMs: this.config.timeoutMs,
          readBody: kind === 'page',
          measureBody: kind === 'css' || kind === 'script',
          pace: () => this.limiter.wait(url),
        });
        const retryable = result.status >= 500 && attempt < this.config.retries;
        if (!retryable) return result;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error('request failed');
  }

  private async processOne(row: { id: number; url: string; kind: UrlKind; depth: number | null }): Promise<void> {
    let status: number | null = null;
    try {
      if (row.kind === 'page') {
        const robots = await this.robots.forUrl(row.url);
        if (!robots.isAllowed(row.url)) {
          this.statements.setState.run('blocked_robots', row.id);
          return;
        }
      }
      const result = await this.fetchWithRetry(row.url, row.kind);
      status = result.status;
      this.store(row.id, row.kind, row.depth, row.url, result);
    } catch (error) {
      this.storeError(row.id, error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error));
    }
    this.statements.setState.run('done', row.id);
    this.fetched += 1;
    const { n } = this.statements.countPending.get() as { n: number };
    this.options.onProgress?.({ id: this.id, fetched: this.fetched, pending: n, url: row.url, status });
  }

  async run(): Promise<void> {
    await this.fetcher.prepare?.();
    try {
      await this.seed();
      const inFlight = new Set<Promise<void>>();
      while (!this.options.signal?.aborted) {
        while (inFlight.size < this.config.concurrency) {
          const row = this.statements.nextPending.get() as { id: number; url: string; kind: UrlKind; depth: number | null } | undefined;
          if (!row) break;
          this.statements.setState.run('in_progress', row.id);
          const task: Promise<void> = this.processOne(row).finally(() => inFlight.delete(task));
          inFlight.add(task);
        }
        if (inFlight.size === 0) break;
        await Promise.race(inFlight);
      }
      await Promise.all(inFlight);
    } finally {
      await this.fetcher.close?.();
    }
  }
}

function runCrawl(id: string, db: Db, config: CrawlConfig, options: CrawlOptions): Promise<void> {
  setMeta(db, 'status', 'running');
  return new Crawl(id, db, config, options).run().then(
    () => {
      if (options.signal?.aborted) {
        setMeta(db, 'status', 'paused');
      } else {
        runAnalysis(db);
        setMeta(db, 'status', 'finished');
        setMeta(db, 'finished_at', new Date().toISOString());
      }
    },
    (error) => {
      setMeta(db, 'status', 'failed');
      setMeta(db, 'error', String(error));
      throw error;
    },
  );
}

/** Applies defaults and rejects bad input, before anything is created. */
export function resolveCrawlConfig(input: Partial<CrawlConfig> & { startUrl: string }): CrawlConfig {
  const startUrl = normalizeUrl(input.startUrl);
  if (!startUrl) throw new Error(`Not a valid http(s) URL: ${input.startUrl}`);
  const config: CrawlConfig = { ...DEFAULT_CONFIG, ...input, startUrl };
  compileFilters(config.include, config.exclude); // Fail on a bad regex before creating anything.
  config.seeds = config.seeds.map((seed) => {
    const url = normalizeUrl(seed);
    if (!url) throw new Error(`Not a valid http(s) URL: ${seed}`);
    if (!isInternal(url, startUrl, config.crawlSubdomains)) {
      throw new Error(`Seed ${url} is outside this crawl. Start from a parent domain and use subdomain crawling.`);
    }
    return url;
  });
  return config;
}

export async function startCrawl(input: Partial<CrawlConfig> & { startUrl: string }, options: CrawlOptions = {}, id?: string): Promise<string> {
  const config = resolveCrawlConfig(input);
  const crawlId = id ?? newCrawlId(config.startUrl);
  const db = createCrawlDb(crawlId);
  try {
    setMeta(db, 'config', JSON.stringify(config));
    setMeta(db, 'start_url', config.startUrl);
    setMeta(db, 'started_at', new Date().toISOString());
    await runCrawl(crawlId, db, config, options);
  } finally {
    db.close();
  }
  return crawlId;
}

export async function resumeCrawl(id: string, options: CrawlOptions = {}): Promise<string> {
  const db = openCrawlDb(id);
  try {
    const raw = getMeta(db, 'config');
    if (!raw) throw new Error(`Crawl ${id} has no saved configuration`);
    db.prepare(`UPDATE urls SET state = 'pending' WHERE state = 'in_progress'`).run();
    // Crawls saved by an older version may lack newer settings.
    await runCrawl(id, db, { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as CrawlConfig) }, options);
  } finally {
    db.close();
  }
  return id;
}
