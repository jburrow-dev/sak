import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCrawlDb, getMeta, listIssues, setMeta, trafficPulls, type Db } from '@sak/core';
import {
  ApiError, MemoryStore, UrlMatcher, addBingKey, apiJson, bingWindow, crawlResolver, dateWindow, disconnectGoogle, emptyTrafficPlan, googleAccounts, googleLogin, importAnalytics, importBing, importSearchConsole, importTopQueries, inspectMore, inspectUrls, inspectionsLeftToday, listAnalyticsProperties, listBingSites, listSearchConsoleProperties, parseBingDate, parseTrafficPlan, propertyCovers, readConnections, removeBingKey, resolveTrafficPlan, runSavedTrafficPlan, saveTrafficPlan, suggestProperty, updateConnections,
} from '../src/index.ts';

let home: string;
let secrets: MemoryStore;
const origin = 'https://example.com';
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const tokens = JSON.stringify({ access_token: 'token', refresh_token: 'r', expires_at: Date.now() + 3_600_000 });
const noSleep = async () => undefined;

function crawl(pages: string[] = [`${origin}/a`, `${origin}/b`], id = 'traffic'): Db {
  const db = createCrawlDb(id);
  setMeta(db, 'start_url', `${origin}/`);
  setMeta(db, 'status', 'finished');
  pages.forEach((url, i) => {
    const row = db.prepare(`INSERT INTO urls (url, kind, state, depth, indexable, in_sitemap) VALUES (?, 'page', 'done', ?, 1, 0)`).run(url, i);
    db.prepare(`INSERT INTO responses (url_id, status, fetched_at) VALUES (?, 200, '2026-10-31')`).run(row.lastInsertRowid);
    db.prepare(`INSERT INTO page_elements (url_id, titles, meta_descriptions, h1s, meta_robots, canonicals, word_count, html_bytes, script_count, has_empty_app_root) VALUES (?, '["T"]', '["M"]', '["H"]', '[]', '[]', 500, 10, 0, 0)`).run(row.lastInsertRowid);
  });
  return db;
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'sak-search-'));
  process.env.SAK_HOME = home;
  secrets = new MemoryStore();
  await secrets.set('google-tokens', tokens);
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('dateWindow', () => {
  it.each([30, 60, 90])('covers exactly %i days and ends two days ago', (days) => {
    const { startDate, endDate } = dateWindow(days, new Date('2026-10-31T12:00:00Z'));
    expect(endDate).toBe('2026-10-29');
    expect((Date.parse(endDate) - Date.parse(startDate)) / 86_400_000 + 1).toBe(days);
  });
});

describe('apiJson', () => {
  const options = (fetchImpl: unknown, sleep = vi.fn(noSleep)) => ({ label: 'Test', fetchImpl: fetchImpl as typeof fetch, sleep });

  it('waits for Retry-After on a 429, then succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'retry-after': '7' } }))
      .mockResolvedValueOnce(ok({ fine: true }));
    const sleep = vi.fn(noSleep);
    await expect(apiJson('https://x.test', {}, options(fetchImpl, sleep))).resolves.toEqual({ fine: true });
    expect(sleep).toHaveBeenCalledWith(7000);
  });

  it('retries a 5xx, then reports it', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Down' } }), { status: 503 }));
    await expect(apiJson('https://x.test', {}, options(fetchImpl))).rejects.toThrow('Test error 503: Down');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('does not retry an exhausted quota', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Search Analytics load quota exceeded' } }), { status: 429 }));
    await expect(apiJson('https://x.test', {}, options(fetchImpl))).rejects.toBeInstanceOf(ApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('copes with an error body that is not JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>Bad gateway</html>', { status: 400 }));
    await expect(apiJson('https://x.test', {}, options(fetchImpl))).rejects.toThrow('Test error 400: no details given');
  });

  it('never puts the request URL in an error', async () => {
    const secretUrl = 'https://x.test/?apikey=super-secret';
    const failed = vi.fn(async () => { throw new TypeError(`fetch failed for ${secretUrl}`); });
    const refused = vi.fn(async () => new Response('{}', { status: 401 }));
    const errors = await Promise.all([apiJson(secretUrl, {}, options(failed)).catch((e) => e.message), apiJson(secretUrl, {}, options(refused)).catch((e) => e.message)]);
    for (const message of errors) expect(message).not.toContain('super-secret');
  });
});

describe('UrlMatcher', () => {
  it('prefers an exact match, then a slash variant', () => {
    const matcher = new UrlMatcher([`${origin}/a`, `${origin}/b/`]);
    expect(matcher.find(`${origin}/a`)).toBe(`${origin}/a`);
    expect(matcher.find(`${origin}/a/`)).toBe(`${origin}/a`);
    expect(matcher.find(`${origin}/b`)).toBe(`${origin}/b/`);
  });

  it('matches across scheme and www', () => {
    const matcher = new UrlMatcher(['https://www.example.com/a']);
    expect(matcher.find('http://example.com/a')).toBe('https://www.example.com/a');
    expect(matcher.find('https://example.com/a/')).toBe('https://www.example.com/a');
  });

  it('matches nothing when a URL could be either of two pages', () => {
    const matcher = new UrlMatcher(['https://www.example.com/a', 'http://example.com/a']);
    expect(matcher.find('https://example.com/a')).toBeNull();
    expect(matcher.find('http://example.com/a')).toBe('http://example.com/a');
  });

  it('never matches across different query strings', () => {
    const matcher = new UrlMatcher([`${origin}/a?page=2`]);
    expect(matcher.find(`${origin}/a`)).toBeNull();
    expect(matcher.find(`${origin}/a?page=3`)).toBeNull();
    expect(matcher.find(`${origin}/a?page=2`)).toBe(`${origin}/a?page=2`);
  });
});

describe('crawl scope', () => {
  it('drops other subdomains unless the crawl included them', () => {
    const db = crawl();
    expect(crawlResolver(db)('https://blog.example.com/x')).toBeNull();
    setMeta(db, 'config', JSON.stringify({ crawlSubdomains: true }));
    expect(crawlResolver(db)('https://blog.example.com/x')).toEqual({ url: 'https://blog.example.com/x', matched: false });
    db.close();
  });
});

describe('Search Console import', () => {
  it('adds up rows for one page, weighting position by impressions', async () => {
    const db = crawl();
    const fetchImpl = vi.fn(async () => ok({ rows: [
      { keys: [`${origin}/a`], clicks: 10, impressions: 100, ctr: 0.1, position: 2 },
      { keys: [`${origin}/a/`], clicks: 10, impressions: 300, ctr: 0.033, position: 6 },
      { keys: ['https://other.example.com/z'], clicks: 1, impressions: 1, ctr: 1, position: 1 },
    ] }));
    const result = await importSearchConsole(db, secrets, 'sc-domain:example.com', 30, fetchImpl as never);
    expect(result).toEqual({ rows: 3, matched: 2, unmatched: 0, dropped: 1 });
    expect(db.prepare('SELECT clicks, impressions, ctr, position FROM search_console').all()).toEqual([{ clicks: 20, impressions: 400, ctr: 0.05, position: 5 }]);
    expect(trafficPulls(db)[0]).toMatchObject({ source: 'gsc', status: 'ok', days: 30, row_count: 3, matched: 2, dropped: 1, account: 'default' });
    db.close();
  });

  it('asks for the same dates it records', async () => {
    const db = crawl();
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => ok({ rows: [] }));
    await importSearchConsole(db, secrets, 'x', 60, fetchImpl as never);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    expect(trafficPulls(db)[0]).toMatchObject({ start_date: body.startDate, end_date: body.endDate });
    db.close();
  });
});

describe('GA4 import', () => {
  const row = (host: string, path: string, sessions: string) => ({ dimensionValues: [{ value: host }, { value: path }], metricValues: [{ value: sessions }, { value: '1' }, { value: '2' }, { value: '3' }, { value: '4' }] });

  it('matches on the real host, so a www start URL still joins', async () => {
    const db = crawl(['https://www.example.com/a']);
    setMeta(db, 'start_url', `${origin}/`); // The crawl started on the non-www host and redirected.
    const fetchImpl = vi.fn(async () => ok({ rowCount: 1, rows: [row('www.example.com', '/a', '7')] }));
    expect(await importAnalytics(db, secrets, '1', 30, fetchImpl as never)).toEqual({ rows: 1, matched: 1, unmatched: 0, dropped: 0 });
    expect(db.prepare('SELECT url, sessions, users, views, key_events FROM analytics').get()).toEqual({ url: 'https://www.example.com/a', sessions: 7, users: 2, views: 3, key_events: 4 });
    db.close();
  });

  it('keeps subdomains apart when the crawl includes them, and drops them when it does not', async () => {
    const answer = () => ok({ rowCount: 2, rows: [row('example.com', '/a', '1'), row('blog.example.com', '/a', '9')] });
    const db = crawl([`${origin}/a`, 'https://blog.example.com/a']);
    setMeta(db, 'config', JSON.stringify({ crawlSubdomains: true }));
    await importAnalytics(db, secrets, '1', 30, vi.fn(async () => answer()) as never);
    expect(db.prepare('SELECT sessions FROM analytics WHERE url = ?').get('https://blog.example.com/a')).toEqual({ sessions: 9 });
    setMeta(db, 'config', JSON.stringify({ crawlSubdomains: false }));
    const narrow = await importAnalytics(db, secrets, '1', 30, vi.fn(async () => answer()) as never);
    expect(narrow.dropped).toBe(1);
    db.close();
  });

  it('drops rows with no usable host or path', async () => {
    const db = crawl();
    const fetchImpl = vi.fn(async () => ok({ rowCount: 2, rows: [row('(not set)', '/a', '1'), row('example.com', '(not set)', '1')] }));
    expect((await importAnalytics(db, secrets, '1', 30, fetchImpl as never)).dropped).toBe(2);
    db.close();
  });
});

describe('Bing', () => {
  const bingRow = (page: string, clicks: number, date: string) => ({ Query: page, Clicks: clicks, Impressions: clicks * 10, AvgClickPosition: 2, AvgImpressionPosition: 4, Date: `/Date(${Date.parse(date)}-0700)/` });
  const now = new Date('2026-10-31T00:00:00Z');

  beforeEach(async () => {
    await addBingKey(secrets, 'main', 'bing-secret', vi.fn(async () => ok({ d: [] })) as never);
  });

  it('parses its date format', () => {
    expect(parseBingDate('/Date(1316156400000-0700)/')).toBe(1316156400000);
    expect(parseBingDate('soon')).toBeNull();
    expect(parseBingDate(undefined)).toBeNull();
  });

  it('narrows to the window when rows carry several dates', () => {
    const rows = [bingRow('a', 1, '2026-10-24'), bingRow('a', 2, '2026-10-01'), bingRow('a', 4, '2026-08-01')];
    const window = bingWindow(rows, 30, now);
    expect(window.rows.map((r) => r.Clicks)).toEqual([1, 2]);
    expect(window).toMatchObject({ days: 30, startDate: '2026-10-01', endDate: '2026-10-24' });
    expect(window.note).toContain('approximate');
  });

  it('says so when Bing has less history than asked for', () => {
    expect(bingWindow([bingRow('a', 1, '2026-10-24'), bingRow('a', 2, '2026-10-17')], 90, now).note).toContain('only returned data from 2026-10-17');
  });

  it('never claims a window when one date means it cannot narrow the data', async () => {
    const db = crawl();
    const fetchImpl = vi.fn(async () => ok({ d: [bingRow(`${origin}/a`, 5, '2026-10-24')] }));
    await importBing(db, secrets, `${origin}/`, 30, fetchImpl as never, 'main', now);
    const pull = trafficPulls(db)[0];
    expect(pull).toMatchObject({ source: 'bing', days: null, start_date: null, end_date: '2026-10-24' });
    expect(pull.note).toContain("Bing's own reporting period");
    db.close();
  });

  it('sums periods per page and joins to crawled URLs', async () => {
    const db = crawl();
    const fetchImpl = vi.fn(async () => ok({ d: [bingRow(`${origin}/a`, 5, '2026-10-24'), bingRow(`${origin}/a`, 3, '2026-10-17'), bingRow(`${origin}/missing`, 1, '2026-10-17')] }));
    expect(await importBing(db, secrets, `${origin}/`, 30, fetchImpl as never, 'main', now)).toEqual({ rows: 3, matched: 2, unmatched: 1, dropped: 0 });
    expect(db.prepare('SELECT clicks, impressions FROM bing_webmaster WHERE url = ?').get(`${origin}/a`)).toEqual({ clicks: 8, impressions: 80 });
    db.close();
  });

  it('checks a key before saving it', async () => {
    const refused = vi.fn(async () => new Response(JSON.stringify({ Message: 'Invalid API key' }), { status: 400 }));
    await expect(addBingKey(secrets, 'bad', 'nope', refused as never)).rejects.toThrow('Invalid API key');
    expect(await secrets.get('bing-key:bad')).toBeNull();
    expect(readConnections().bing).toEqual(['main']);
  });

  it('keeps its key out of import errors', async () => {
    const db = crawl();
    const failed = vi.fn(async () => new Response('{}', { status: 401 }));
    const message = await importBing(db, secrets, `${origin}/`, 30, failed as never, 'main').catch((e) => e.message);
    expect(message).toContain('401');
    expect(message).not.toContain('bing-secret');
    db.close();
  });

  it('removes a key completely', async () => {
    await removeBingKey(secrets, 'main');
    expect(await secrets.get('bing-key:main')).toBeNull();
    expect(readConnections().bing).toEqual([]);
  });

  it('lists verified sites', async () => {
    const fetchImpl = vi.fn(async () => ok({ d: [{ Url: `${origin}/`, IsVerified: true }, { Url: 'https://other.test/', IsVerified: false }] }));
    expect(await listBingSites(secrets, 'main', fetchImpl as never)).toEqual([{ id: `${origin}/`, label: `${origin}/` }]);
  });
});

describe('Google accounts', () => {
  const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.y`;
  const signIn = (email: string) => {
    const fetchImpl = vi.fn(async () => ok({ access_token: 'a', refresh_token: `r-${email}`, expires_in: 3600, id_token: idToken(email) }));
    const openBrowser = (url: string) => {
      const auth = new URL(url);
      void fetch(`${auth.searchParams.get('redirect_uri')}?code=c&state=${auth.searchParams.get('state')}`);
    };
    return googleLogin(secrets, openBrowser, fetchImpl as never);
  };

  beforeEach(async () => {
    await secrets.set('google-client', 'id:secret');
  });

  it('asks for the account identity and read-only access', async () => {
    let scope = '';
    const fetchImpl = vi.fn(async () => ok({ access_token: 'a', refresh_token: 'r', expires_in: 3600, id_token: idToken('me@x.com') }));
    await googleLogin(secrets, (url) => {
      const auth = new URL(url);
      scope = auth.searchParams.get('scope') ?? '';
      void fetch(`${auth.searchParams.get('redirect_uri')}?code=c&state=${auth.searchParams.get('state')}`);
    }, fetchImpl as never);
    expect(scope.split(' ')).toEqual(expect.arrayContaining(['openid', 'email', 'https://www.googleapis.com/auth/webmasters.readonly', 'https://www.googleapis.com/auth/analytics.readonly']));
  });

  it('replaces an unnamed sign-in, and then keeps accounts apart', async () => {
    expect(await googleAccounts(secrets)).toEqual(['default']);
    expect(await signIn('a@x.com')).toBe('a@x.com');
    expect(await googleAccounts(secrets)).toEqual(['a@x.com']);
    await signIn('b@x.com');
    expect(await googleAccounts(secrets)).toEqual(['a@x.com', 'b@x.com']);
    expect(JSON.parse((await secrets.get('google-tokens:b@x.com'))!).refresh_token).toBe('r-b@x.com');
  });

  it('uses the chosen account, and insists on a choice when there are several', async () => {
    await signIn('a@x.com');
    await signIn('b@x.com');
    const db = crawl();
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => ok({ rows: [] }));
    await expect(importSearchConsole(db, secrets, 'x', 30, fetchImpl as never)).rejects.toThrow('Several Google accounts');
    await expect(importSearchConsole(db, secrets, 'x', 30, fetchImpl as never, 'c@x.com')).rejects.toThrow('not connected');
    await importSearchConsole(db, secrets, 'x', 30, fetchImpl as never, 'b@x.com');
    expect(trafficPulls(db)[0].account).toBe('b@x.com');
    db.close();
  });

  it('gives up when sign-in is abandoned or cancelled', async () => {
    await expect(googleLogin(secrets, () => undefined, vi.fn() as never, { timeoutMs: 10 })).rejects.toThrow('timed out');
    const cancel = new AbortController();
    const pending = googleLogin(secrets, () => cancel.abort(), vi.fn() as never, { signal: cancel.signal });
    await expect(pending).rejects.toThrow('cancelled');
  });

  it('refuses a callback with the wrong state', async () => {
    const pending = googleLogin(secrets, (url) => {
      void fetch(`${new URL(url).searchParams.get('redirect_uri')}?code=c&state=wrong`);
    }, vi.fn() as never);
    await expect(pending).rejects.toThrow('state mismatch');
  });

  it('disconnects even if revoking fails, leaving other accounts alone', async () => {
    await signIn('a@x.com');
    await signIn('b@x.com');
    await disconnectGoogle(secrets, 'a@x.com', vi.fn(async () => { throw new Error('offline'); }) as never);
    expect(await secrets.get('google-tokens:a@x.com')).toBeNull();
    expect(await googleAccounts(secrets)).toEqual(['b@x.com']);
  });

  it('revokes the token when disconnecting', async () => {
    await signIn('a@x.com');
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => ok({}));
    await disconnectGoogle(secrets, 'a@x.com', fetchImpl as never);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/revoke');
    expect(String(fetchImpl.mock.calls[0][1].body)).toContain('r-a%40x.com');
  });
});

describe('property lists', () => {
  it('hides Search Console properties the user cannot read', async () => {
    const fetchImpl = vi.fn(async () => ok({ siteEntry: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }, { siteUrl: 'https://no.test/', permissionLevel: 'siteUnverifiedUser' }] }));
    expect(await listSearchConsoleProperties(secrets, undefined, fetchImpl as never)).toEqual([{ id: 'sc-domain:example.com', label: 'sc-domain:example.com' }]);
  });

  it('follows pages of GA4 accounts and strips the property prefix', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ok({ accountSummaries: [{ displayName: 'Acme', propertySummaries: [{ property: 'properties/1', displayName: 'Site' }] }], nextPageToken: 'more' }))
      .mockResolvedValueOnce(ok({ accountSummaries: [{ displayName: 'Beta', propertySummaries: [{ property: 'properties/2', displayName: 'App' }] }] }));
    expect(await listAnalyticsProperties(secrets, undefined, fetchImpl as never)).toEqual([{ id: '1', label: 'Site (Acme, 1)' }, { id: '2', label: 'App (Beta, 2)' }]);
    expect(String(fetchImpl.mock.calls[1][0])).toContain('pageToken=more');
  });

  it('passes on Google\'s explanation when the Admin API is off', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Google Analytics Admin API has not been used in project 1' } }), { status: 403 }));
    await expect(listAnalyticsProperties(secrets, undefined, fetchImpl as never)).rejects.toThrow('Admin API has not been used');
  });

  it('suggests a domain property, then a matching prefix, then the last choice', () => {
    const options = (...ids: string[]) => ids.map((id) => ({ id, label: id }));
    expect(suggestProperty('gsc', options('https://www.example.com/', 'sc-domain:example.com', 'sc-domain:other.com'), 'https://www.example.com/')).toBe('sc-domain:example.com');
    expect(suggestProperty('gsc', options('http://www.example.com/', 'https://www.example.com/', 'https://other.com/'), 'https://www.example.com/')).toBe('https://www.example.com/');
    expect(suggestProperty('gsc', options('https://other.com/'), 'https://www.example.com/')).toBeNull();
    updateConnections((data) => { data.lastUsed['example.com'] = { ga4: { account: 'default', property: '42' } }; });
    expect(suggestProperty('ga4', options('41', '42'), 'https://www.example.com/')).toBe('42');
    expect(suggestProperty('ga4', options('41'), 'https://www.example.com/')).toBeNull();
  });

  it('warns about properties that may not cover the crawl', () => {
    expect(propertyCovers('sc-domain:example.com', 'https://blog.example.com/')).toBe(true);
    expect(propertyCovers('sc-domain:other.com', 'https://example.com/')).toBe(false);
    expect(propertyCovers('https://www.example.com/', 'https://example.com/')).toBe(true);
    expect(propertyCovers('https://www.example.com/blog/', 'https://example.com/')).toBe(false);
    expect(propertyCovers('https://www.example.com/', 'https://example.com/', true)).toBe(false);
    expect(propertyCovers('12345', 'https://example.com/')).toBe(true);
  });
});

describe('top queries', () => {
  it('keeps the top 10 for each crawled page and nothing else', async () => {
    const db = crawl();
    const rows = Array.from({ length: 12 }, (_, i) => ({ keys: [`${origin}/a`, `q${i}`], clicks: i, impressions: 100, position: 3 }));
    rows.push({ keys: [`${origin}/not-crawled`, 'skip'], clicks: 99, impressions: 100, position: 1 });
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => ok({ rows }));
    await importTopQueries(db, secrets, 'x', 30, fetchImpl as never);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body as string).dimensions).toEqual(['page', 'query']);
    const kept = db.prepare('SELECT query, url FROM gsc_queries ORDER BY clicks DESC').all() as { query: string; url: string }[];
    expect(kept).toHaveLength(10);
    expect(kept[0].query).toBe('q11');
    expect(kept.every((q) => q.url === `${origin}/a`)).toBe(true);
    db.close();
  });

  it('stops at the row cap and says so', async () => {
    const db = crawl();
    const page = { rows: Array.from({ length: 25_000 }, (_, i) => ({ keys: [`${origin}/a`, `q${i}`], clicks: 1, impressions: 1, position: 1 })) };
    const fetchImpl = vi.fn(async () => ok(page));
    await importTopQueries(db, secrets, 'x', 30, fetchImpl as never);
    expect(fetchImpl).toHaveBeenCalledTimes(8);
    expect(trafficPulls(db)[0].note).toContain('Stopped at 200,000');
    db.close();
  }, 30_000);
});

describe('URL Inspection', () => {
  const pass = (coverage = 'Submitted and indexed') => ok({ inspectionResult: { indexStatusResult: { verdict: 'PASS', coverageState: coverage, googleCanonical: `${origin}/a`, userCanonical: `${origin}/a` } } });

  it('inspects indexable pages with clicks first, up to the limit', async () => {
    const db = crawl([`${origin}/a`, `${origin}/b`, `${origin}/c`]);
    db.prepare(`INSERT INTO search_console (url, clicks) VALUES (?, 50)`).run(`${origin}/c`);
    db.prepare(`UPDATE urls SET indexable = 0 WHERE url = ?`).run(`${origin}/a`);
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => pass());
    const result = await inspectUrls(db, secrets, 'p', 2, fetchImpl as never, undefined, 0);
    const asked = fetchImpl.mock.calls.map((c) => JSON.parse(c[1].body as string).inspectionUrl);
    expect(asked).toEqual([`${origin}/c`, `${origin}/b`]);
    expect(result).toMatchObject({ inspected: 2, remaining: 1, stoppedBy: null });
    db.close();
  });

  it('continues with uninspected URLs on the next run', async () => {
    const db = crawl();
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => pass());
    await inspectUrls(db, secrets, 'p', 1, fetchImpl as never, undefined, 0);
    await inspectUrls(db, secrets, 'p', 5, fetchImpl as never, undefined, 0);
    const asked = fetchImpl.mock.calls.map((c) => JSON.parse(c[1].body as string).inspectionUrl);
    expect(asked).toEqual([`${origin}/a`, `${origin}/b`]);
    db.close();
  });

  it('stops cleanly on a quota error and keeps what it has', async () => {
    const db = crawl();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(pass())
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Quota exceeded' } }), { status: 429 }));
    const result = await inspectUrls(db, secrets, 'p', 5, fetchImpl as never, undefined, 0);
    expect(result).toMatchObject({ inspected: 1, remaining: 1 });
    expect(result.stoppedBy).toContain('Quota exceeded');
    expect(db.prepare('SELECT COUNT(*) AS n FROM url_inspection').get()).toEqual({ n: 1 });
    expect(trafficPulls(db)[0].note).toContain('Quota exceeded');
    db.close();
  });

  it('records a failure for one URL and carries on', async () => {
    const db = crawl();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'URL not in property' } }), { status: 400 }))
      .mockResolvedValueOnce(pass());
    expect(await inspectUrls(db, secrets, 'p', 5, fetchImpl as never, undefined, 0)).toMatchObject({ inspected: 1, failed: 1 });
    expect(db.prepare('SELECT error FROM url_inspection WHERE url = ?').get(`${origin}/a`)).toEqual({ error: expect.stringContaining('URL not in property') });
    db.close();
  });

  it('counts inspections per property and stops at the daily limit', async () => {
    const db = crawl();
    const fetchImpl = vi.fn(async () => pass());
    await inspectUrls(db, secrets, 'p', 1, fetchImpl as never, undefined, 0);
    expect(inspectionsLeftToday('p')).toBe(1999);
    expect(inspectionsLeftToday('other')).toBe(2000);
    updateConnections((data) => { data.inspections.p = { date: new Date().toISOString().slice(0, 10), count: 2000 }; });
    fetchImpl.mockClear();
    const result = await inspectUrls(db, secrets, 'p', 5, fetchImpl as never, undefined, 0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.stoppedBy).toContain('2,000');
    db.close();
  });
});

describe('traffic plans', () => {
  it('accepts only 30, 60 or 90 days', () => {
    for (const days of [0, 45, 91, 'soon']) expect(() => parseTrafficPlan({ days })).toThrow('30, 60 or 90');
    expect(parseTrafficPlan({ days: '60' }).days).toBe(60);
  });

  it('requires a property for each source and checks the inspection limit', () => {
    expect(() => parseTrafficPlan({ days: 30, gsc: { property: ' ' } })).toThrow('Search Console property');
    expect(() => parseTrafficPlan({ days: 30, gsc: { property: 'x', inspect: { limit: 2001 } } })).toThrow('1 to 2000');
    expect(emptyTrafficPlan(parseTrafficPlan({ days: 30 }))).toBe(true);
  });

  it('fails before crawling if an account is not connected', async () => {
    await expect(resolveTrafficPlan(new MemoryStore(), { days: 30, gsc: { property: 'x' } })).rejects.toThrow('sak google login');
    await expect(resolveTrafficPlan(secrets, { days: 30, bing: { site: 'x' } })).rejects.toThrow('sak bing key add');
    expect((await resolveTrafficPlan(secrets, { days: 30, ga4: { property: '1' } })).ga4?.account).toBe('default');
  });

  const answers = () => vi.fn(async (url: string) => {
    if (url.includes('analyticsdata')) return new Response(JSON.stringify({ error: { message: 'GA4 is down' } }), { status: 403 });
    if (url.includes('searchAnalytics')) return ok({ rows: [{ keys: [`${origin}/a`], clicks: 3, impressions: 9, ctr: 0.3, position: 2 }] });
    return ok({});
  });

  it('runs only once the crawl finishes, only once, and survives one source failing', async () => {
    const db = crawl();
    setMeta(db, 'status', 'paused');
    saveTrafficPlan(db, { days: 30, gsc: { property: 'x' }, ga4: { property: '1' } });
    const fetchImpl = answers();
    await runSavedTrafficPlan(db, secrets, fetchImpl as never);
    expect(fetchImpl).not.toHaveBeenCalled();
    setMeta(db, 'status', 'finished');
    await runSavedTrafficPlan(db, secrets, fetchImpl as never);
    const calls = fetchImpl.mock.calls.length;
    await runSavedTrafficPlan(db, secrets, fetchImpl as never);
    expect(fetchImpl).toHaveBeenCalledTimes(calls);
    expect(getMeta(db, 'traffic_status')).toBe('finished');
    const pulls = Object.fromEntries(trafficPulls(db).map((p) => [p.source, p]));
    expect(pulls.gsc.status).toBe('ok');
    expect(pulls.ga4).toMatchObject({ status: 'failed' });
    expect(pulls.ga4.error).toContain('GA4 is down');
    db.close();
  });

  it('rebuilds issues afterwards, using only sources that were pulled', async () => {
    const db = crawl();
    db.prepare('UPDATE urls SET indexable = 1').run();
    db.prepare(`INSERT INTO urls (url, kind, state, depth, indexable) VALUES (?, 'page', 'done', 9, 0)`).run(`${origin}/hidden`);
    saveTrafficPlan(db, { days: 30, gsc: { property: 'x' } });
    await runSavedTrafficPlan(db, secrets, answers() as never);
    // /b has no impressions while /a does, and no issue appears for a source that wasn't pulled.
    expect(listIssues(db, { type: 'traffic_no_impressions' }).items.map((i) => i.url)).toEqual([`${origin}/b`]);
    db.close();
  });

  it('remembers the choice for this site', async () => {
    const db = crawl();
    saveTrafficPlan(db, { days: 30, gsc: { account: 'default', property: 'sc-domain:example.com' } });
    await runSavedTrafficPlan(db, secrets, answers() as never);
    expect(readConnections().lastUsed['example.com'].gsc).toEqual({ account: 'default', property: 'sc-domain:example.com' });
    db.close();
  });

  it('allows another run when a new plan is saved, keeping old data if it fails', async () => {
    const db = crawl();
    saveTrafficPlan(db, { days: 30, gsc: { property: 'x' } });
    await runSavedTrafficPlan(db, secrets, answers() as never);
    saveTrafficPlan(db, { days: 90, gsc: { property: 'x' } });
    const failing = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Forbidden' } }), { status: 403 }));
    await runSavedTrafficPlan(db, secrets, failing as never);
    expect(failing).toHaveBeenCalled();
    expect(trafficPulls(db)[0]).toMatchObject({ status: 'ok', days: 30, error: expect.stringContaining('Forbidden') });
    expect(db.prepare('SELECT clicks FROM search_console').get()).toEqual({ clicks: 3 });
    db.close();
  });

  it('inspects more with the saved property', async () => {
    const db = crawl();
    saveTrafficPlan(db, { days: 30, gsc: { property: 'x' } });
    const fetchImpl = vi.fn(async () => ok({ inspectionResult: { indexStatusResult: { verdict: 'FAIL', coverageState: 'Crawled - currently not indexed' } } }));
    await inspectMore(db, secrets, 1, fetchImpl as never);
    expect(listIssues(db, { type: 'index_not_indexed' }).items[0]).toMatchObject({ url: `${origin}/a`, detail: 'Crawled - currently not indexed' });
    db.close();
  });
});
