import type { Browser } from 'playwright-core';
import type { Fetcher, FetchRequest, FetchResult } from './fetcher.ts';

export interface Rendered {
  html: string;
  finalUrl: string;
}

export interface Renderer {
  prepare?(): Promise<void>;
  render(request: FetchRequest): Promise<Rendered>;
  close?(): Promise<void>;
}

/**
 * Fetches over HTTP first, then renders successful HTML. The HTTP response keeps redirects,
 * status codes and headers exact, and gives the raw HTML to compare with the rendered DOM.
 */
export class RenderingFetcher implements Fetcher {
  private http: Fetcher;
  private renderer: Renderer;

  constructor(http: Fetcher, renderer: Renderer) {
    this.http = http;
    this.renderer = renderer;
  }

  prepare() {
    return this.renderer.prepare?.() ?? Promise.resolve();
  }

  close() {
    return this.renderer.close?.() ?? Promise.resolve();
  }

  async fetch(request: FetchRequest): Promise<FetchResult> {
    const result = await this.http.fetch(request);
    if (!request.readBody || result.body === null || result.status >= 300) return result;
    await request.pace?.();
    try {
      const { html, finalUrl } = await this.renderer.render(request);
      return { ...result, body: html, rawBody: result.body, finalUrl };
    } catch (error) {
      return { ...result, renderError: (error as Error).message.split('\n')[0].slice(0, 300) };
    }
  }
}

// Rendering runs a site's scripts, so without this every crawled page would count as a visit
// in the site's analytics and ad platforms.
const TRACKER_HOSTS = /(^|\.)(google-analytics\.com|analytics\.google\.com|googletagmanager\.com|doubleclick\.net|googleadservices\.com|googlesyndication\.com|cloudflareinsights\.com|facebook\.net|facebook\.com|hotjar\.com|clarity\.ms|segment\.com|segment\.io|mixpanel\.com|heap\.io|heapanalytics\.com|fullstory\.com|tiktok\.com|bing\.com|linkedin\.com|licdn\.com|adroll\.com|callrail\.com|intercom\.io)$/i;
const SKIPPED_RESOURCES = new Set(['image', 'media', 'font']);
const SETTLE_MS = 3000;

/** Renders with the installed Google Chrome, in a throwaway profile. */
export class ChromeRenderer implements Renderer {
  private userAgent: string;
  private browser: Browser | null = null;

  constructor(userAgent: string) {
    this.userAgent = userAgent;
  }

  async prepare(): Promise<void> {
    const { chromium } = await import('playwright-core');
    try {
      this.browser = await chromium.launch({ channel: 'chrome', headless: true });
    } catch (error) {
      throw new Error(`JavaScript rendering needs Google Chrome, which could not be started: ${(error as Error).message.split('\n')[0]}`);
    }
  }

  async render({ url, headers, timeoutMs }: FetchRequest): Promise<Rendered> {
    if (!this.browser) await this.prepare();
    const context = await this.browser!.newContext({ userAgent: this.userAgent, serviceWorkers: 'block' });
    try {
      const origin = new URL(url).origin;
      const { accept: _accept, 'user-agent': _userAgent, ...custom } = headers;
      await context.route('**/*', (route) => {
        const request = route.request();
        const target = new URL(request.url());
        if (SKIPPED_RESOURCES.has(request.resourceType()) || TRACKER_HOSTS.test(target.hostname)) return route.abort();
        // Custom headers can hold credentials, so they only go to the site being crawled.
        return target.origin === origin ? route.continue({ headers: { ...request.headers(), ...custom } }) : route.continue();
      });
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
      await page.waitForLoadState('networkidle', { timeout: SETTLE_MS }).catch(() => {});
      return { html: await page.content(), finalUrl: page.url() };
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
  }
}
