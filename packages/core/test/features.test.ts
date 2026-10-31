import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureSite } from './fixture-site.ts';
import {
  Database, RenderingFetcher, crawlPath, createCrawlDb, elementCatalog, elementCounts, elementCsv, listElement, listIssues, listUrls, openCrawlDb, readSettings, startCrawl, urlInfo, withCrawl, writeSettings,
  type Db, type Fetcher, type Renderer,
} from '../src/index.ts';

let server: Server;
let origin: string;
let home: string;
let db: Db;
const fast = { requestsPerSecond: 0, concurrency: 4, retries: 0, timeoutMs: 5000 };

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'sak-features-'));
  process.env.SAK_HOME = home;
  ({ server, origin } = await startFixtureSite());
  await startCrawl({ startUrl: `${origin}/`, ...fast }, {}, 'features');
  db = openCrawlDb('features', { readonly: true });
});

afterAll(() => {
  db?.close();
  server?.close();
  rmSync(home, { recursive: true, force: true });
});

const paths = (rows: { url?: unknown }[]) => rows.map((r) => String(r.url).replace(origin, ''));
const issueUrls = (type: string) => paths(listIssues(db, { type, sort: 'url', limit: 100 }).items);

describe('CSS and scripts', () => {
  it('fetches them as their own kinds and measures their size', () => {
    expect(paths(listUrls(db, { kind: 'css', sort: 'url' }).items)).toEqual(['/gone.css', '/style.css']);
    expect(paths(listUrls(db, { kind: 'script', sort: 'url' }).items)).toEqual(['/a.js', '/app.js']);
    const css = listUrls(db, { kind: 'css', status: 200 }).items[0];
    expect(css.bytes).toBe('body { margin: 0 }'.length);
    expect(css.inlinks).toBe(1);
  });

  it('reports broken ones on the page that uses them', () => {
    expect(issueUrls('css_broken')).toEqual(['/thin']);
    expect(issueUrls('script_broken')).toEqual(['/spa']);
  });

  it('can be switched off', async () => {
    await startCrawl({ startUrl: `${origin}/`, ...fast, checkResources: false }, {}, 'no-resources');
    expect(withCrawl('no-resources', (d) => listUrls(d, { kind: 'css' }).total)).toBe(0);
    expect(withCrawl('no-resources', (d) => listIssues(d, { type: 'css_broken' }).total)).toBe(0);
  });
});

describe('elements', () => {
  it('counts every filter of every element without a SQL error', () => {
    for (const element of elementCatalog()) {
      const counts = elementCounts(db, element.key);
      expect(Object.keys(counts)).toEqual(element.filters.map((f) => f.key));
      for (const filter of element.filters) {
        expect(listElement(db, element.key, { filter: filter.key, limit: 1000 }).total).toBe(counts[filter.key]);
      }
    }
  });

  it('finds pages by element and agrees with the checks', () => {
    const rows = (key: string, filter: string) => paths(listElement(db, key, { filter, sort: 'url', limit: 1000 }).items);
    expect(rows('title', 'missing')).toEqual(['/no-tags']);
    expect(rows('title', 'multiple')).toEqual(['/two-titles']);
    expect(rows('title', 'duplicate')).toEqual(issueUrls('title_duplicate'));
    expect(rows('h1', 'multiple')).toEqual(['/two-titles']);
    expect(rows('canonical', 'other').sort()).toEqual(['/canon-bad', '/canon-other']);
    expect(rows('directives', 'noindex')).toEqual(['/noindexed']);
    expect(rows('css', '4xx')).toEqual(['/gone.css']);
    expect(rows('response', 'robots')).toEqual(['/private/secret']);
    expect(rows('images', 'no-alt')).toEqual([]);
  });

  it('collects H2s and lists pages that have none', () => {
    expect(listElement(db, 'h2', { filter: 'missing' }).total).toBe(listElement(db, 'h2').total);
  });

  it('sorts by a known column and ignores anything else', () => {
    const items = listElement(db, 'content', { sort: 'word_count', desc: true, limit: 1000 }).items as { word_count: number }[];
    expect(items[0].word_count).toBeGreaterThanOrEqual(items[items.length - 1].word_count);
    expect(() => listElement(db, 'content', { sort: 'url; DROP TABLE urls' })).not.toThrow();
  });

  it('searches and exports the same rows it shows', () => {
    const { total } = listElement(db, 'title', { search: 'Shared duplicate' });
    expect(total).toBe(2);
    expect(elementCsv(db, 'title', { search: 'Shared duplicate' }).trim().split('\n').length).toBe(total + 1);
  });

  it('rejects an unknown element', () => {
    expect(() => listElement(db, 'nope')).toThrow('Unknown element');
  });
});

describe('sorting issues', () => {
  it('sorts by URL in both directions', () => {
    const up = listIssues(db, { type: 'low_inlinks', sort: 'url' }).items.map((i) => i.url);
    expect(up).toEqual([...up].sort());
    expect(listIssues(db, { type: 'low_inlinks', sort: 'url', desc: true }).items.map((i) => i.url)).toEqual([...up].reverse());
  });

  it('searches details and ignores an unknown sort', () => {
    expect(listIssues(db, { search: '/gone.css' }).items.map((i) => i.type)).toEqual(['css_broken']);
    expect(() => listIssues(db, { sort: 'nonsense' })).not.toThrow();
  });
});

describe('crawls saved by an older version', () => {
  it('are upgraded when opened read-only, without reading as missing H2s', () => {
    const old = new Database(crawlPath('old-crawl'));
    old.exec(`
      CREATE TABLE crawl_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', depth INTEGER, in_sitemap INTEGER NOT NULL DEFAULT 0, indexable INTEGER, indexability_reason TEXT);
      CREATE TABLE page_elements (url_id INTEGER PRIMARY KEY, titles TEXT NOT NULL, meta_descriptions TEXT NOT NULL, h1s TEXT NOT NULL, meta_robots TEXT NOT NULL, canonicals TEXT NOT NULL, word_count INTEGER NOT NULL, text_hash TEXT, html_bytes INTEGER NOT NULL, script_count INTEGER NOT NULL, has_empty_app_root INTEGER NOT NULL);
      INSERT INTO urls (id, url, kind, state) VALUES (1, 'http://old.test/', 'page', 'done');
      INSERT INTO page_elements VALUES (1, '["Old"]', '[]', '[]', '[]', '[]', 5, NULL, 10, 0, 0);
    `);
    old.close();
    const counts = withCrawl('old-crawl', (d) => elementCounts(d, 'h2'));
    expect(counts).toMatchObject({ all: 1, missing: 0 });
    expect(withCrawl('old-crawl', (d) => urlInfo(d, 'http://old.test/'))!.elements!.h2s).toBeNull();
    expect(withCrawl('old-crawl', (d) => elementCounts(d, 'title')).all).toBe(1);
  });
});

describe('JavaScript rendering', () => {
  const site: Record<string, string> = {
    'http://app.test/': '<title>Shell</title><div id="root"></div><script src="/app.js"></script>',
    'http://app.test/moved': '<title>Moved</title>',
  };
  const http: Fetcher = {
    async fetch({ url, readBody }) {
      if (url === 'http://app.test/redirect') return { status: 301, headers: new Headers({ location: '/' }), body: null, bytes: null, elapsedMs: 1 };
      const body = site[url];
      const type = url.endsWith('.js') ? 'text/javascript' : 'text/html';
      return { status: body || url.endsWith('.js') ? 200 : 404, headers: new Headers({ 'content-type': type }), body: readBody && type === 'text/html' ? (body ?? '') : null, bytes: 1, elapsedMs: 1 };
    },
  };
  const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
  const renderer = (calls: string[]): Renderer => ({
    async render({ url }) {
      calls.push(url);
      if (url.endsWith('/moved')) throw new Error('Timeout 5000ms exceeded\nmore detail');
      return { finalUrl: url, html: `<title>Rendered</title><h1>Hello</h1><h2>Sub</h2><p>${words}</p><a href="/moved">more</a><a href="/redirect">old</a>` };
    },
  });
  const base = { ...fast, useSitemaps: false, robotsMode: 'custom' as const, customRobots: '' };

  it('uses the rendered page, compares it with the HTML, and only renders HTML that loaded', async () => {
    const calls: string[] = [];
    await startCrawl({ startUrl: 'http://app.test/', ...base }, { fetcher: new RenderingFetcher(http, renderer(calls)) }, 'rendered');
    expect(calls.sort()).toEqual(['http://app.test/', 'http://app.test/moved']);
    withCrawl('rendered', (d) => {
      const info = urlInfo(d, 'http://app.test/')!;
      expect(info.title).toBe('Rendered');
      expect(info.elements!.h2s).toEqual(['Sub']);
      expect(info.rendering).toMatchObject({ rendered: 1, raw_word_count: 0, js_only_links: 2, render_error: null });
      const types = (url: string) => (d.prepare('SELECT type FROM issues WHERE url = ?').all(url) as { type: string }[]).map((r) => r.type);
      expect(types('http://app.test/')).toEqual(expect.arrayContaining(['js_only_content', 'js_only_links']));
      expect(types('http://app.test/')).not.toContain('js_dependent');
      expect(listElement(d, 'javascript', { filter: 'rendered' }).total).toBe(1);
    });
  });

  it('falls back to the HTML when a page fails to render, and reports it', () => {
    withCrawl('rendered', (d) => {
      const info = urlInfo(d, 'http://app.test/moved')!;
      expect(info.title).toBe('Moved');
      expect(info.rendering).toMatchObject({ rendered: 0, render_error: 'Timeout 5000ms exceeded' });
      expect(listIssues(d, { type: 'render_failed' }).items.map((i) => i.url)).toEqual(['http://app.test/moved']);
    });
  });

  it('marks the crawl failed when the browser cannot start', async () => {
    const broken: Fetcher = new RenderingFetcher(http, { prepare: () => Promise.reject(new Error('no Chrome')), render: () => Promise.reject(new Error('unused')) });
    await expect(startCrawl({ startUrl: 'http://app.test/', ...base }, { fetcher: broken }, 'no-chrome')).rejects.toThrow('no Chrome');
    expect(withCrawl('no-chrome', (d) => d.prepare(`SELECT value FROM crawl_meta WHERE key = 'status'`).get())).toEqual({ value: 'failed' });
  });

  const hasChrome = existsSync('/Applications/Google Chrome.app');

  it.skipIf(!hasChrome)('renders a real page in Chrome', async () => {
    const jsSite: Server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      if (req.url === '/after') return res.end('<title>After</title>');
      if (req.url !== '/') return res.end('');
      res.end(`<title>Shell</title><div id="root"></div><script>
        document.title = 'Built by JS';
        document.getElementById('root').innerHTML = '<h1>Built</h1><a href="/after">after</a>';
      </script>`);
    });
    await new Promise<void>((resolve) => jsSite.listen(0, '127.0.0.1', () => resolve()));
    const jsOrigin = `http://127.0.0.1:${(jsSite.address() as AddressInfo).port}`;
    try {
      await startCrawl({ startUrl: `${jsOrigin}/`, ...base, renderJs: true }, {}, 'chrome');
      withCrawl('chrome', (d) => {
        const info = urlInfo(d, `${jsOrigin}/`)!;
        expect(info.title).toBe('Built by JS');
        expect(info.elements!.h1s).toEqual(['Built']);
        expect(info.rendering).toMatchObject({ rendered: 1, js_only_links: 1 });
        expect(urlInfo(d, `${jsOrigin}/after`)).not.toBeNull();
      });
    } finally {
      jsSite.close();
    }
  }, 60_000);

  it('does not render anything that is not HTML', async () => {
    const calls: string[] = [];
    const fetcher = new RenderingFetcher(http, renderer(calls));
    await fetcher.fetch({ url: 'http://app.test/app.js', headers: {}, timeoutMs: 1000, readBody: false });
    expect(calls).toEqual([]);
  });
});

describe('settings', () => {
  it('defaults to allowing paid APIs, and remembers a change', () => {
    expect(readSettings().paidApis).toBe(true);
    expect(writeSettings({ paidApis: false }).paidApis).toBe(false);
    expect(readSettings().paidApis).toBe(false);
    writeSettings({ paidApis: true });
  });

  it('new crawl databases are created at the current version', () => {
    const fresh = createCrawlDb('fresh');
    expect(fresh.pragma('user_version', { simple: true })).toBeGreaterThan(0);
    fresh.close();
  });
});
