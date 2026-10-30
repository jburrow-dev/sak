import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureSite } from './fixture-site.ts';
import { compareCrawls, crawlOverview, exportCsv, issuesSummary, listCrawlIds, listIssues, listUrls, openCrawlDb, resumeCrawl, startCrawl, urlInfo, urlLinks, withCrawl, type Db, type Fetcher } from '../src/index.ts';

let server: Server;
let origin: string;
let external: string;
let home: string;
let id: string;
let db: Db;

const issueUrls = (type: string) => (db.prepare('SELECT url, detail FROM issues WHERE type = ? ORDER BY url').all(type) as { url: string; detail: string | null }[]).map((r) => r.url.replace(origin, ''));
const fast = { requestsPerSecond: 0, concurrency: 4, retries: 0, timeoutMs: 5000 };

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'sak-test-'));
  process.env.SAK_HOME = home;
  ({ server, origin, externalOrigin: external } = await startFixtureSite());
  id = await startCrawl({ startUrl: `${origin}/`, ...fast }, {}, 'fixture');
  db = openCrawlDb(id, { readonly: true });
});

afterAll(() => {
  db?.close();
  server?.close();
  rmSync(home, { recursive: true, force: true });
});

describe('crawling the fixture site', () => {
  it('finishes with nothing left in the queue', () => {
    const overview = crawlOverview(db, id);
    expect(overview.status).toBe('finished');
    expect(overview.pending).toBe(0);
  });

  it('discovers exactly the expected internal URLs', () => {
    const urls = (db.prepare(`SELECT url FROM urls WHERE kind = 'page' ORDER BY url`).all() as { url: string }[]).map((r) => r.url.replace(origin, ''));
    expect(urls).toEqual([
      '/', '/canon-bad', '/canon-other', '/chain-a', '/chain-b', '/chain-c', '/deep1', '/deep2', '/deep3', '/deep4', '/dup-a', '/dup-b', '/en', '/fr', '/good',
      '/loop-a', '/loop-b', '/missing', '/no-tags', '/noindexed', '/orphan', '/private/secret', '/redirect-one', '/schema', '/server-error', '/spa', '/thin', '/two-titles',
    ].sort());
  });

  it('records the expected status codes', () => {
    const statusOf = (path: string) => (db.prepare('SELECT r.status FROM responses r JOIN urls u ON u.id = r.url_id WHERE u.url = ?').get(origin + path) as { status: number }).status;
    expect(statusOf('/good')).toBe(200);
    expect(statusOf('/missing')).toBe(404);
    expect(statusOf('/server-error')).toBe(500);
    expect(statusOf('/redirect-one')).toBe(301);
    expect(statusOf('/chain-b')).toBe(302);
  });

  it('does not fetch URLs blocked by robots.txt', () => {
    const row = db.prepare('SELECT u.state, r.status FROM urls u LEFT JOIN responses r ON r.url_id = u.id WHERE u.url = ?').get(`${origin}/private/secret`) as { state: string; status: number | null };
    expect(row).toEqual({ state: 'blocked_robots', status: null });
    expect(issueUrls('robots_blocked')).toEqual(['/private/secret']);
  });

  it('measures click depth by shortest path', () => {
    const depthOf = (path: string) => (db.prepare('SELECT depth FROM urls WHERE url = ?').get(origin + path) as { depth: number | null }).depth;
    expect(depthOf('/')).toBe(0);
    expect(depthOf('/good')).toBe(1);
    expect(depthOf('/deep4')).toBe(4);
    expect(depthOf('/chain-c')).toBe(3);
    expect(depthOf('/orphan')).toBeNull();
  });

  it('reports each seeded fault on exactly the right URLs', () => {
    expect(issueUrls('status_4xx')).toEqual(['/missing']);
    expect(issueUrls('status_5xx')).toEqual(['/server-error']);
    expect(issueUrls('redirect_chain')).toEqual(['/chain-a']);
    expect(issueUrls('redirect_loop')).toEqual(['/loop-a']);
    expect(issueUrls('title_duplicate')).toEqual(['/dup-a', '/dup-b']);
    expect(issueUrls('meta_duplicate')).toEqual(['/dup-a', '/dup-b']);
    expect(issueUrls('duplicate_exact')).toEqual(['/dup-a', '/dup-b']);
    expect(issueUrls('noindex')).toEqual(['/noindexed']);
    expect(issueUrls('canonical_other')).toEqual(['/canon-bad', '/canon-other']);
    expect(issueUrls('canonical_target_bad')).toEqual(['/canon-bad']);
    expect(issueUrls('hreflang_invalid')).toEqual(['/fr']);
    expect(issueUrls('hreflang_no_return')).toEqual(['/en', '/fr']);
    expect(issueUrls('hreflang_missing_self')).toEqual([]);
    expect(issueUrls('schema_invalid_json')).toEqual(['/schema']);
    expect(issueUrls('schema_missing_property')).toEqual(['/schema']);
    expect(issueUrls('js_dependent')).toEqual(['/spa']);
    expect(issueUrls('low_word_count')).toEqual(['/thin']);
    expect(issueUrls('title_missing')).toEqual(['/no-tags']);
    expect(issueUrls('meta_missing')).toEqual(['/no-tags']);
    expect(issueUrls('h1_missing')).toEqual(['/no-tags', '/spa']);
    expect(issueUrls('title_multiple')).toEqual(['/two-titles']);
    expect(issueUrls('h1_multiple')).toEqual(['/two-titles']);
    expect(issueUrls('deep_page')).toEqual(['/deep4']);
    expect(issueUrls('sitemap_orphan')).toEqual(['/orphan']);
    expect(issueUrls('sitemap_non_indexable')).toEqual(['/missing', '/noindexed']);
  });

  it('attributes broken links to the page that contains them', () => {
    expect(issueUrls('link_broken_internal')).toEqual(['/', '/']);
    expect(issueUrls('image_broken')).toEqual(['/good']);
    expect(issueUrls('link_to_redirect').length).toBe(3);
    const refused = listIssues(db, { type: 'link_external_unverified' }).items;
    expect(refused.map((i) => i.detail)).toEqual([`${external}/ext-403 (403)`]);
    const broken = listIssues(db, { type: 'link_broken_external' }).items;
    expect(broken.map((i) => i.detail)).toEqual([`${external}/ext-404 (404)`]);
  });

  it('marks indexability correctly', () => {
    const indexable = listUrls(db, { kind: 'page', indexable: true, limit: 1000 }).items.map((r) => r.url.replace(origin, ''));
    expect(indexable).toContain('/good');
    for (const excluded of ['/noindexed', '/canon-other', '/missing', '/redirect-one', '/private/secret']) expect(indexable).not.toContain(excluded);
  });

  it('answers URL queries', () => {
    const info = urlInfo(db, `${origin}/chain-a`)!;
    expect(info.redirect_chain.map((h: any) => h.url.replace(origin, ''))).toEqual(['/chain-a', '/chain-b', '/chain-c', '/good']);
    const inlinks = urlLinks(db, `${origin}/good`, 'in');
    expect(inlinks.items.map((l) => l.url.replace(origin, ''))).toContain('/');
    expect(urlInfo(db, 'https://nope.example/')).toBeNull();
  });

  it('summarises with errors first', () => {
    const summary = issuesSummary(db);
    expect(summary[0].severity).toBe('error');
    expect(summary.find((s) => s.type === 'status_4xx')?.title).toBe('Internal URL returns 4xx');
  });

  it('exports CSV', async () => {
    const path = join(home, 'urls.csv');
    const count = await exportCsv(db, 'urls', path);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines.length).toBe(count + 1);
    expect(lines[0].startsWith('url,kind,status')).toBe(true);
  });
});

describe('crawl options', () => {
  it('enforces the URL budget', async () => {
    const crawl = await startCrawl({ startUrl: `${origin}/`, ...fast, maxUrls: 3, useSitemaps: false, checkExternal: false }, {}, 'budget');
    const pages = withCrawl(crawl, (d) => (d.prepare(`SELECT COUNT(*) AS n FROM urls WHERE kind = 'page'`).get() as { n: number }).n);
    expect(pages).toBe(3);
  });

  it('applies exclude patterns', async () => {
    const crawl = await startCrawl({ startUrl: `${origin}/`, ...fast, exclude: ['/deep', '/dup'], useSitemaps: false, checkExternal: false }, {}, 'exclude');
    const urls = withCrawl(crawl, (d) => (d.prepare('SELECT url FROM urls').all() as { url: string }[]).map((r) => r.url));
    expect(urls.some((u) => u.includes('/deep') || u.includes('/dup'))).toBe(false);
  });

  it('can ignore robots.txt', async () => {
    const crawl = await startCrawl({ startUrl: `${origin}/`, ...fast, robotsMode: 'ignore', useSitemaps: false, checkExternal: false }, {}, 'ignore');
    const state = withCrawl(crawl, (d) => (d.prepare('SELECT state FROM urls WHERE url = ?').get(`${origin}/private/secret`) as { state: string }).state);
    expect(state).toBe('done');
  });

  it('rejects a bad regex before crawling', async () => {
    await expect(startCrawl({ startUrl: `${origin}/`, include: ['('] }, {}, 'badregex')).rejects.toThrow();
  });

  it('pauses and resumes without losing URLs', async () => {
    const controller = new AbortController();
    let seen = 0;
    await startCrawl(
      { startUrl: `${origin}/`, ...fast, concurrency: 1, useSitemaps: false, checkExternal: false },
      { signal: controller.signal, onProgress: () => { if (++seen === 3) controller.abort(); } },
      'resume',
    );
    const paused = withCrawl('resume', (d) => crawlOverview(d, 'resume'));
    expect(paused.status).toBe('paused');
    expect(paused.pending).toBeGreaterThan(0);
    await resumeCrawl('resume');
    const done = withCrawl('resume', (d) => crawlOverview(d, 'resume'));
    expect(done.status).toBe('finished');
    expect(done.pending).toBe(0);
  });
});

describe('subdomain crawling', () => {
  // Reserved .test hosts served by a fake fetcher, since a local server has no real subdomains.
  const site: Record<string, string> = {
    'http://site.test/': '<a href="http://app.site.test/">app</a><a href="http://other.test/">other</a>',
    'http://app.site.test/': '<title>App</title><a href="/inner">inner</a>',
    'http://app.site.test/inner': '<title>Inner</title>',
    'http://hidden.site.test/': '<title>Hidden</title><a href="/deep">deep</a>',
    'http://hidden.site.test/deep': '<title>Deep</title>',
    'http://other.test/': '<title>Other</title><a href="/never">never</a>',
  };
  const fetcher: Fetcher = {
    async fetch({ url, readBody }) {
      const body = site[url];
      return { status: body ? 200 : 404, headers: new Headers({ 'content-type': 'text/html' }), body: readBody ? (body ?? '') : null, bytes: 1, elapsedMs: 1 };
    },
  };
  const base = { ...fast, requestsPerSecond: 0, useSitemaps: false, robotsMode: 'custom' as const, customRobots: '' };
  const urlsOf = (id: string, kind: string) => withCrawl(id, (d) => (d.prepare('SELECT url FROM urls WHERE kind = ? ORDER BY url').all(kind) as { url: string }[]).map((r) => r.url));

  it('treats subdomains as external by default and does not parse them', async () => {
    const id = await startCrawl({ startUrl: 'http://site.test/', ...base }, { fetcher }, 'sub-off');
    expect(urlsOf(id, 'page')).toEqual(['http://site.test/']);
    expect(urlsOf(id, 'external')).toEqual(['http://app.site.test/', 'http://other.test/']);
  });

  it('crawls linked subdomains when enabled, without leaving the site', async () => {
    const id = await startCrawl({ startUrl: 'http://site.test/', ...base, crawlSubdomains: true }, { fetcher }, 'sub-on');
    expect(urlsOf(id, 'page')).toEqual(['http://app.site.test/', 'http://app.site.test/inner', 'http://site.test/']);
    expect(urlsOf(id, 'external')).toEqual(['http://other.test/']);
  });

  it('reaches unlinked subdomains through a seed', async () => {
    const id = await startCrawl({ startUrl: 'http://site.test/', ...base, crawlSubdomains: true, seeds: ['http://hidden.site.test/'] }, { fetcher }, 'sub-seed');
    expect(urlsOf(id, 'page')).toEqual(expect.arrayContaining(['http://hidden.site.test/', 'http://hidden.site.test/deep']));
    const depth = withCrawl(id, (d) => d.prepare('SELECT depth FROM urls WHERE url = ?').get('http://hidden.site.test/deep'));
    expect(depth).toEqual({ depth: 1 });
  });

  it('rejects a seed outside the crawl before creating anything', async () => {
    await expect(startCrawl({ startUrl: 'http://site.test/', ...base, seeds: ['http://hidden.site.test/'] }, { fetcher }, 'sub-bad1')).rejects.toThrow('outside this crawl');
    await expect(startCrawl({ startUrl: 'http://site.test/', ...base, crawlSubdomains: true, seeds: ['http://other.test/'] }, { fetcher }, 'sub-bad2')).rejects.toThrow('outside this crawl');
    expect(listCrawlIds()).not.toContain('sub-bad1');
  });
});

describe('crawl comparison', () => {
  it('reports nothing between identical crawls', async () => {
    const again = await startCrawl({ startUrl: `${origin}/`, ...fast }, {}, 'fixture2');
    const other = openCrawlDb(again, { readonly: true });
    const diff = compareCrawls(db, other);
    other.close();
    expect(diff).toEqual({ urlsAdded: [], urlsRemoved: [], changed: [], issuesAdded: [], issuesResolved: [] });
  });

  it('reports the difference when the site changes', async () => {
    const partial = await startCrawl({ startUrl: `${origin}/`, ...fast, exclude: ['/deep'] }, {}, 'partial');
    const other = openCrawlDb(partial, { readonly: true });
    const diff = compareCrawls(db, other);
    other.close();
    expect(diff.urlsRemoved.map((u) => u.replace(origin, ''))).toEqual(['/deep1', '/deep2', '/deep3', '/deep4']);
    expect(diff.issuesResolved.some((i) => i.type === 'deep_page')).toBe(true);
  });
});
