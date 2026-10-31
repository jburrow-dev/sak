import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCrawlDb, readSettings, setMeta, writeSettings, type Db } from '@sak/core';
import { ApiCache, CostConfirmationRequired, DataForSeo, MemoryStore, PaidApisDisabled, dataForSeoBasicToken, emptyPlan, enrichCrawl, estimatePlan, readPaidData, runSavedPaidPlan, savePaidPlan, importAnalytics, importSearchConsole, pagesForSpeedTest, parsePageSpeed, runPageSpeed } from '../src/index.ts';

let home: string;
let cache: ApiCache;
let secrets: MemoryStore;

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const dfs = (result: unknown[], cost = 0.09) => ok({ status_code: 20000, cost, tasks: [{ status_code: 20000, result }] });
const where = { location: 2840, language: 'en' };

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'sak-int-'));
  process.env.SAK_HOME = home;
  cache = new ApiCache(join(home, 'cache.sqlite'));
  secrets = new MemoryStore();
  await secrets.set('dataforseo', 'login:password');
});

afterEach(() => {
  cache.close();
  rmSync(home, { recursive: true, force: true });
});

describe('DataForSEO cost control', () => {
  it('refuses to spend without confirmation and makes no request', async () => {
    const fetchImpl = vi.fn();
    const client = new DataForSeo(secrets, cache, fetchImpl as never);
    await expect(client.keywordVolume(['seo'], where)).rejects.toBeInstanceOf(CostConfirmationRequired);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('charges once, then serves from cache for free', async () => {
    const fetchImpl = vi.fn(async () => dfs([{ keyword: 'seo', search_volume: 100, competition: 'LOW', cpc: 1.5 }]));
    const client = new DataForSeo(secrets, cache, fetchImpl as never);
    const first = await client.keywordVolume(['SEO'], where, { confirmed: true });
    expect(first).toMatchObject({ cached: false, cost: 0.09 });
    const second = await client.keywordVolume(['seo'], where);
    expect(second).toMatchObject({ cached: true, cost: 0 });
    expect(second.value[0].search_volume).toBe(100);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cache.spend()).toMatchObject({ total: 0.09, calls: 1 });
  });

  it('sends Basic auth', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => dfs([]));
    await new DataForSeo(secrets, cache, fetchImpl as never).backlinkSummary('example.com', { confirmed: true });
    const headers = fetchImpl.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from('login:password').toString('base64')}`);
  });

  it('accepts a plain password or the dashboard Base64 token', () => {
    const token = Buffer.from('me@x.com:secret1234').toString('base64');
    expect(dataForSeoBasicToken('me@x.com:secret1234')).toBe(token);
    expect(dataForSeoBasicToken(token)).toBe(token);
    expect(dataForSeoBasicToken(`me@x.com:${token}`)).toBe(token);
    // A password that happens to be valid Base64 is still treated as a password.
    expect(dataForSeoBasicToken('me@x.com:abcd')).toBe(Buffer.from('me@x.com:abcd').toString('base64'));
  });

  it('re-fetches on refresh, and only then with confirmation', async () => {
    const fetchImpl = vi.fn(async () => dfs([{ target: 'e.com', backlinks: 5 }], 0.02));
    const client = new DataForSeo(secrets, cache, fetchImpl as never);
    await client.backlinkSummary('e.com', { confirmed: true });
    await expect(client.backlinkSummary('e.com', { refresh: true })).rejects.toBeInstanceOf(CostConfirmationRequired);
    await client.backlinkSummary('e.com', { refresh: true, confirmed: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(cache.spend().total).toBeCloseTo(0.04);
  });

  it('does not cache or charge a failed task', async () => {
    const fetchImpl = vi.fn(async () => ok({ status_code: 20000, cost: 0, tasks: [{ status_code: 40501, status_message: 'Invalid field' }] }));
    const client = new DataForSeo(secrets, cache, fetchImpl as never);
    await expect(client.backlinkSummary('e.com', { confirmed: true })).rejects.toThrow('40501');
    expect(cache.spend().calls).toBe(0);
    await expect(client.backlinkSummary('e.com')).rejects.toBeInstanceOf(CostConfirmationRequired);
  });

  it('explains missing credentials', async () => {
    const client = new DataForSeo(new MemoryStore(), cache, vi.fn() as never);
    await expect(client.backlinkSummary('e.com', { confirmed: true })).rejects.toThrow('sak key set dataforseo');
  });

  it('finds a domain in the SERP, including subdomains, and estimates only uncached keywords', async () => {
    const serp = [{ items: [{ type: 'paid', domain: 'example.com', rank_group: 1 }, { type: 'organic', domain: 'other.com', rank_group: 1, url: 'https://other.com' }, { type: 'organic', domain: 'blog.example.com', rank_group: 2, url: 'https://blog.example.com/x' }] }];
    const fetchImpl = vi.fn(async () => dfs(serp, 0.003));
    const client = new DataForSeo(secrets, cache, fetchImpl as never);
    const { value } = await client.rankCheck('www.example.com', ['a'], where, { confirmed: true });
    expect(value).toEqual([{ keyword: 'a', position: 2, url: 'https://blog.example.com/x' }]);
    const blocked = await client.rankCheck('www.example.com', ['a', 'b'], where).catch((e) => e);
    expect(blocked.estimate).toBeCloseTo(0.003);
    expect((await client.rankCheck('www.example.com', ['a'], where)).cost).toBe(0);
  });
});

describe('Google imports', () => {
  let db: Db;
  const origin = 'https://example.com';

  beforeEach(async () => {
    db = createCrawlDb('google');
    setMeta(db, 'start_url', `${origin}/`);
    db.prepare(`INSERT INTO urls (url, kind, indexable) VALUES (?, 'page', 1), (?, 'page', 1)`).run(`${origin}/a`, `${origin}/b`);
    await secrets.set('google-tokens', JSON.stringify({ access_token: 'token', refresh_token: 'r', expires_at: Date.now() + 3_600_000 }));
  });
  afterEach(() => db.close());

  it('joins Search Console rows to crawled URLs and counts the rest', async () => {
    const fetchImpl = vi.fn(async () => ok({ rows: [{ keys: [`${origin}/a#frag`], clicks: 3, impressions: 10, ctr: 0.3, position: 2 }, { keys: [`${origin}/not-crawled`], clicks: 1, impressions: 2, ctr: 0.5, position: 9 }] }));
    const result = await importSearchConsole(db, secrets, 'sc-domain:example.com', 90, fetchImpl as never);
    expect(result).toEqual({ rows: 2, matched: 1, unmatched: 1 });
    expect(db.prepare('SELECT clicks FROM search_console WHERE url = ?').get(`${origin}/a`)).toEqual({ clicks: 3 });
  });

  it('builds full URLs from GA4 page paths', async () => {
    const fetchImpl = vi.fn(async () => ok({ rowCount: 1, rows: [{ dimensionValues: [{ value: '/b' }], metricValues: [{ value: '7' }, { value: '5' }] }] }));
    const result = await importAnalytics(db, secrets, '123', 90, fetchImpl as never);
    expect(result).toEqual({ rows: 1, matched: 1, unmatched: 0 });
    expect(db.prepare('SELECT sessions, engaged_sessions FROM analytics WHERE url = ?').get(`${origin}/b`)).toEqual({ sessions: 7, engaged_sessions: 5 });
  });

  it('refreshes an expired token before calling the API', async () => {
    await secrets.set('google-tokens', JSON.stringify({ access_token: 'old', refresh_token: 'r', expires_at: 0 }));
    await secrets.set('google-client', 'id:secret');
    const fetchImpl = vi.fn(async (url: string) => String(url).includes('oauth2') ? ok({ access_token: 'new', expires_in: 3600 }) : ok({ rows: [] }));
    await importSearchConsole(db, secrets, 'x', 30, fetchImpl as never);
    const apiCall = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect((apiCall[1].headers as Record<string, string>).authorization).toBe('Bearer new');
  });

  it('asks for login when not signed in', async () => {
    await expect(importSearchConsole(db, new MemoryStore(), 'x', 30, vi.fn() as never)).rejects.toThrow('sak google login');
  });
});

describe('PageSpeed', () => {
  it('parses Lighthouse and field data', () => {
    const parsed = parsePageSpeed('u', 'mobile', {
      lighthouseResult: { categories: { performance: { score: 0.87 } }, audits: { 'largest-contentful-paint': { numericValue: 2100 }, 'cumulative-layout-shift': { numericValue: 0.02 }, 'server-response-time': { numericValue: 300 } } },
      loadingExperience: { metrics: { INTERACTION_TO_NEXT_PAINT: { percentile: 180 } } },
    });
    expect(parsed).toEqual({ url: 'u', strategy: 'mobile', performance: 87, lcp_ms: 2100, cls: 0.02, inp_ms: 180, ttfb_ms: 300 });
  });

  it('keeps going when one URL fails and picks the most-linked pages', async () => {
    const db = createCrawlDb('psi');
    const insert = db.prepare(`INSERT INTO urls (id, url, kind, indexable) VALUES (?, ?, 'page', 1)`);
    insert.run(1, 'https://e.com/1');
    insert.run(2, 'https://e.com/2');
    db.prepare(`INSERT INTO links (source_id, target_id, type) VALUES (1, 2, 'a')`).run();
    expect(pagesForSpeedTest(db, 1)).toEqual(['https://e.com/2']);
    // Repeat links from one page count once, so page 3 outranks page 2.
    insert.run(3, 'https://e.com/3');
    insert.run(4, 'https://e.com/4');
    const link = db.prepare(`INSERT INTO links (source_id, target_id, type) VALUES (?, ?, 'a')`);
    link.run(1, 2);
    link.run(1, 2);
    link.run(1, 3);
    link.run(4, 3);
    expect(pagesForSpeedTest(db, 1)).toEqual(['https://e.com/3']);
    const fetchImpl = vi.fn(async (url: URL) => url.search.includes('%2F1') ? new Response(JSON.stringify({ error: { message: 'Quota' } }), { status: 429 }) : ok({ lighthouseResult: { categories: { performance: { score: 1 } }, audits: {} } }));
    const results = await runPageSpeed(db, secrets, ['https://e.com/1', 'https://e.com/2'], 'mobile', fetchImpl as never);
    expect(results.map((r) => r.error ?? r.performance)).toEqual(['Quota', 100]);
    db.close();
  });
});

describe('the paid API switch', () => {
  afterEach(() => { writeSettings({ paidApis: true }); });

  it('stops every paid call before any request, even when confirmed', async () => {
    writeSettings({ paidApis: false });
    const fetchImpl = vi.fn();
    const client = new DataForSeo(secrets, cache, fetchImpl as never);
    await expect(client.keywordVolume(['seo'], where, { confirmed: true })).rejects.toBeInstanceOf(PaidApisDisabled);
    await expect(client.backlinkSummary('example.com', { confirmed: true, refresh: true })).rejects.toBeInstanceOf(PaidApisDisabled);
    await expect(client.rankCheck('example.com', ['seo'], where, { confirmed: true })).rejects.toBeInstanceOf(PaidApisDisabled);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(cache.spend().calls).toBe(0);
  });

  it('still serves cached results while off', async () => {
    const fetchImpl = vi.fn(async () => dfs([{ keyword: 'seo', search_volume: 100, competition: 'LOW', cpc: 1.5 }]));
    const client = new DataForSeo(secrets, cache, fetchImpl as never);
    await client.keywordVolume(['seo'], where, { confirmed: true });
    writeSettings({ paidApis: false });
    await expect(client.keywordVolume(['seo'], where)).resolves.toMatchObject({ cached: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('treats a damaged settings file as off', () => {
    writeFileSync(join(home, 'settings.json'), '{not json');
    expect(readSettings().paidApis).toBe(false);
  });
});

describe('per-crawl paid data', () => {
  const plan = { backlinks: true, volume: true, rank: true, keywords: ['seo', 'crawler'] };
  const crawlDb = () => {
    const db = createCrawlDb('enrich');
    setMeta(db, 'start_url', 'https://www.example.com/');
    setMeta(db, 'status', 'finished');
    return db;
  };
  const answers = vi.fn(async (url: string) => {
    if (url.includes('backlinks')) return dfs([{ target: 'example.com', backlinks: 5, referring_domains: 2, rank: 40 }], 0.02);
    if (url.includes('search_volume')) return dfs([{ keyword: 'seo', search_volume: 100 }], 0.09);
    return dfs([{ items: [{ type: 'organic', domain: 'example.com', rank_group: 3, url: 'https://example.com/' }] }], 0.003);
  });

  it('estimates the most a plan can cost', () => {
    expect(estimatePlan(plan)).toBeCloseTo(0.02 + 0.09 + 2 * 0.003);
    expect(estimatePlan({ ...plan, keywords: [], rank: false })).toBeCloseTo(0.02 + 0);
    expect(emptyPlan({ backlinks: false, volume: true, rank: true, keywords: [] })).toBe(true);
    expect(emptyPlan(plan)).toBe(false);
  });

  it('stores each result with the crawl, using the domain of the start URL', async () => {
    const db = crawlDb();
    await enrichCrawl(db, new DataForSeo(secrets, cache, answers as never), plan);
    const rows = readPaidData(db);
    expect(rows.map((r) => r.kind)).toEqual(['backlinks', 'rank', 'volume']);
    expect(rows[0]).toMatchObject({ key: 'example.com', cost: 0.02, error: null });
    expect(rows[1].value).toEqual([{ keyword: 'seo', position: 3, url: 'https://example.com/' }, { keyword: 'crawler', position: 3, url: 'https://example.com/' }]);
    db.close();
  });

  it('records the refusal and spends nothing when the switch is off', async () => {
    writeSettings({ paidApis: false });
    const fetchImpl = vi.fn();
    const db = crawlDb();
    await enrichCrawl(db, new DataForSeo(secrets, cache, fetchImpl as never), plan);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readPaidData(db).every((r) => r.error?.includes('switched off'))).toBe(true);
    db.close();
    writeSettings({ paidApis: true });
  });

  it('runs a saved plan only once, and only after the crawl finishes', async () => {
    const fetchImpl = vi.fn(answers);
    const client = new DataForSeo(secrets, cache, fetchImpl as never);
    const db = crawlDb();
    savePaidPlan(db, { backlinks: true, volume: false, rank: false, keywords: [] });
    setMeta(db, 'status', 'paused');
    await runSavedPaidPlan(db, client);
    expect(fetchImpl).not.toHaveBeenCalled();
    setMeta(db, 'status', 'finished');
    await runSavedPaidPlan(db, client);
    await runSavedPaidPlan(db, client);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    db.close();
  });
});
