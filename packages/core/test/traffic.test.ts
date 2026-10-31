import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database, createCrawlDb, crawlPath, elementCatalog, elementCounts, elementCsv, listElement, listIssues, listUrls, runAnalysis, setMeta, trafficPulls, urlInfo, withCrawl, type Db } from '../src/index.ts';

let home: string;
const origin = 'https://example.com';

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'sak-traffic-'));
  process.env.SAK_HOME = home;
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

function site(id: string): Db {
  const db = createCrawlDb(id);
  setMeta(db, 'start_url', `${origin}/`);
  const page = (path: string, status: number, sitemap = 1) => {
    const { lastInsertRowid } = db.prepare(`INSERT INTO urls (url, kind, state, depth, in_sitemap) VALUES (?, 'page', 'done', 1, ?)`).run(`${origin}${path}`, sitemap);
    db.prepare(`INSERT INTO responses (url_id, status, content_type, fetched_at) VALUES (?, ?, ?, '2026-10-31')`).run(lastInsertRowid, status, 'text/html');
    if (status === 200) db.prepare(`INSERT INTO page_elements (url_id, titles, meta_descriptions, h1s, meta_robots, canonicals, word_count, html_bytes, script_count, has_empty_app_root) VALUES (?, '["T"]', '["M"]', '["H"]', ?, '[]', 500, 10, 0, 0)`).run(lastInsertRowid, path === '/noindex' ? '["noindex"]' : '[]');
  };
  page('/quiet', 200);
  page('/popular', 200);
  page('/unlisted', 200, 0);
  page('/noindex', 200);
  page('/moved', 301);
  return db;
}

const pull = (db: Db, source: string, matched = 1) => db.prepare(`INSERT OR REPLACE INTO traffic_pulls (source, fetched_at, status, row_count, matched) VALUES (?, '2026-10-31', 'ok', ?, ?)`).run(source, matched, matched);
const issueUrls = (db: Db, type: string) => listIssues(db, { type, sort: 'url' }).items.map((i) => i.url.replace(origin, ''));

describe('traffic issues', () => {
  it('stay silent without a pull, even if rows exist', () => {
    const db = site('none');
    db.prepare(`INSERT INTO search_console (url, clicks, impressions) VALUES (?, 5, 10)`).run(`${origin}/noindex`);
    runAnalysis(db);
    for (const type of ['traffic_non_indexable', 'traffic_no_impressions', 'traffic_not_in_sitemap']) expect(issueUrls(db, type)).toEqual([]);
    db.close();
  });

  it('do not flag every page when a pull matched nothing, such as a wrong property', () => {
    const db = site('wrong-property');
    pull(db, 'gsc', 0);
    runAnalysis(db);
    expect(issueUrls(db, 'traffic_no_impressions')).toEqual([]);
    db.close();
  });

  it('find traffic problems once a source was pulled', () => {
    const db = site('pulled');
    pull(db, 'gsc');
    pull(db, 'ga4');
    const gsc = db.prepare('INSERT INTO search_console (url, clicks, impressions) VALUES (?, ?, ?)');
    gsc.run(`${origin}/popular`, 40, 100);
    gsc.run(`${origin}/noindex`, 7, 20);
    gsc.run(`${origin}/moved`, 9, 30);
    gsc.run(`${origin}/unlisted`, 2, 5);
    db.prepare('INSERT INTO analytics (url, sessions) VALUES (?, 3)').run(`${origin}/noindex`);
    runAnalysis(db);
    expect(issueUrls(db, 'traffic_non_indexable')).toEqual(['/noindex']); // A redirect is already doing its job.
    expect(listIssues(db, { type: 'traffic_non_indexable' }).items[0].detail).toBe('noindex: 7 clicks (Search Console), 3 sessions (GA4)');
    expect(issueUrls(db, 'traffic_no_impressions')).toEqual(['/quiet']);
    expect(issueUrls(db, 'traffic_not_in_sitemap')).toEqual(['/unlisted']);
    db.close();
  });

  it('compare the crawl with Google index status', () => {
    const db = site('inspected');
    const inspect = db.prepare(`INSERT INTO url_inspection (url, verdict, coverage_state, google_canonical, user_canonical, error, fetched_at) VALUES (?, ?, ?, ?, ?, ?, '2026-10-31')`);
    inspect.run(`${origin}/quiet`, 'NEUTRAL', 'Discovered - currently not indexed', null, null, null);
    inspect.run(`${origin}/noindex`, 'NEUTRAL', "Excluded by 'noindex' tag", null, null, null);
    inspect.run(`${origin}/popular`, 'PASS', 'Submitted and indexed', `${origin}/other`, `${origin}/popular`, null);
    inspect.run(`${origin}/unlisted`, null, null, null, null, 'Could not inspect');
    runAnalysis(db);
    expect(issueUrls(db, 'index_not_indexed')).toEqual(['/quiet']); // /noindex is meant to be out of the index.
    expect(issueUrls(db, 'index_canonical_mismatch')).toEqual(['/popular']);
    db.close();
  });

  it('survive running analysis again', () => {
    const db = site('again');
    pull(db, 'gsc');
    runAnalysis(db);
    const first = issueUrls(db, 'traffic_no_impressions').length;
    runAnalysis(db);
    expect(issueUrls(db, 'traffic_no_impressions')).toHaveLength(first);
    db.close();
  });
});

describe('browsing traffic data', () => {
  let db: Db;

  beforeAll(() => {
    db = site('browse');
    pull(db, 'gsc');
    db.prepare(`INSERT INTO search_console (url, clicks, impressions, ctr, position) VALUES (?, 40, 100, 0.4, 2.5)`).run(`${origin}/popular`);
    db.prepare(`INSERT INTO search_console (url, clicks, impressions, ctr, position) VALUES (?, 2, 9, 0.2, 7)`).run(`${origin}/never-crawled`);
    db.prepare(`INSERT INTO analytics (url, sessions, engaged_sessions, users, views, key_events) VALUES (?, 11, 8, 9, 20, 2)`).run(`${origin}/popular`);
    db.prepare('INSERT INTO analytics (url, sessions) VALUES (?, 4)').run(`${origin}/never-crawled`);
    db.prepare('INSERT INTO bing_webmaster (url, clicks, impressions, impression_position) VALUES (?, 6, 30, 4)').run(`${origin}/popular`);
    db.prepare(`INSERT INTO gsc_queries (url, query, clicks, impressions, ctr, position) VALUES (?, 'best pest control', 12, 40, 0.3, 5)`).run(`${origin}/popular`);
    db.prepare(`INSERT INTO url_inspection (url, verdict, coverage_state, fetched_at) VALUES (?, 'PASS', 'Submitted and indexed', '2026-10-31')`).run(`${origin}/popular`);
    runAnalysis(db);
  });

  afterAll(() => db.close());

  it('adds every source to the URL list and sorts by them', () => {
    const { items } = listUrls(db, { sort: 'bing_clicks', desc: true });
    expect(items[0]).toMatchObject({ clicks: 40, impressions: 100, ctr: 0.4, position: 2.5, sessions: 11, engaged_sessions: 8, users: 9, views: 20, key_events: 2, bing_clicks: 6, bing_impressions: 30, bing_position: 4 });
  });

  it('adds queries and index status to URL details', () => {
    const info = urlInfo(db, `${origin}/popular`)!;
    expect(info.top_queries).toEqual([{ query: 'best pest control', clicks: 12, impressions: 40, ctr: 0.3, position: 5 }]);
    expect(info.inspection).toMatchObject({ verdict: 'PASS', coverage_state: 'Submitted and indexed' });
  });

  it('lists URLs with data that the crawl never reached, merged across sources', () => {
    const { items, total } = listElement(db, 'not-in-crawl');
    expect(total).toBe(1);
    expect(items[0]).toMatchObject({ url: `${origin}/never-crawled`, gsc_clicks: 2, gsc_impressions: 9, sessions: 4, bing_clicks: null });
    expect(elementCounts(db, 'not-in-crawl')).toEqual({ all: 1, 'gsc-clicks': 1, sessions: 1, 'bing-clicks': 0 });
  });

  it('counts and exports every filter of the new elements', () => {
    for (const key of ['search', 'queries', 'index-status', 'not-in-crawl']) {
      const element = elementCatalog().find((e) => e.key === key)!;
      expect(() => elementCounts(db, key)).not.toThrow();
      for (const { key: filter } of element.filters) expect(elementCsv(db, key, { filter }).split('\n')[0]).toContain('URL');
    }
    expect(elementCounts(db, 'search')).toMatchObject({ all: 5, 'gsc-clicks': 1, 'no-impressions': 2 });
    expect(elementCounts(db, 'queries')).toMatchObject({ striking: 1 });
    expect(elementCounts(db, 'index-status')).toMatchObject({ indexed: 1 });
  });
});

describe('crawls saved by an older version', () => {
  it('gain the new tables and columns when opened read-only', () => {
    const old = new Database(crawlPath('schema-2'));
    old.exec(`
      CREATE TABLE crawl_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', depth INTEGER, in_sitemap INTEGER NOT NULL DEFAULT 0, indexable INTEGER, indexability_reason TEXT);
      CREATE TABLE search_console (url TEXT PRIMARY KEY, clicks REAL, impressions REAL, ctr REAL, position REAL);
      CREATE TABLE analytics (url TEXT PRIMARY KEY, sessions REAL, engaged_sessions REAL);
      INSERT INTO urls (id, url, kind, state) VALUES (1, 'http://old.test/', 'page', 'done');
      INSERT INTO search_console (url, clicks) VALUES ('http://old.test/', 8);
      INSERT INTO analytics (url, sessions) VALUES ('http://old.test/gone', 3);
      PRAGMA user_version = 2;
    `);
    old.close();
    const items = withCrawl('schema-2', (db) => listUrls(db).items);
    expect(items[0]).toMatchObject({ clicks: 8, users: null, bing_clicks: null });
    expect(withCrawl('schema-2', (db) => trafficPulls(db))).toEqual([]);
    expect(withCrawl('schema-2', (db) => listElement(db, 'not-in-crawl').items.map((r) => r.url))).toEqual(['http://old.test/gone']);
  });
});
