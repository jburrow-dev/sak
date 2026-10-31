import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, collectSiteAudit, elementCatalog, elementCounts, listElement, listIssues, openCrawlDb, parseHtml, readSiteAudit, runAnalysis, simhash, startCrawl, withCrawl } from '../src/index.ts';
import { checkAiBots, checkHosts, checkLlmsFile, checkRobotsFile, checkSitemapFiles } from '../src/checks/audit.ts';
import { checkGbpProfile, readSiteBusiness, type GbpRow } from '../src/checks/gbp.ts';
import { checkHead, checkImages, checkRenderChanges, checkSnippetControls, checkSoft404, checkStructuredData, schemaTypes, type PageInput } from '../src/checks/page.ts';
import { checkAnchors, checkDelivery, checkMixedContent, checkNearDuplicates, checkStatuses, checkUrlShape, linkScores, type SiteInput } from '../src/checks/site.ts';
import type { PageSignals, UrlRow } from '../src/types.ts';

const types = (findings: { type: string }[]) => findings.map((f) => f.type);

const page = (over: Partial<PageInput> = {}): PageInput => ({ url: 'https://example.com/a', titles: ['A title'], metaDescriptions: [], h1s: ['Heading'], metaRobots: [], xRobots: null, canonicals: [], wordCount: 500, scriptCount: 0, hasEmptyAppRoot: false, hreflang: [], jsonLd: [], indexable: true, ...over });
const signals = (over: Partial<PageSignals> = {}): PageSignals => ({ htmlLang: 'en', viewport: true, ogTitle: true, ogImage: true, twitterCard: true, images: 0, imagesNoAlt: 0, imagesNoDimensions: 0, imagesLazy: 0, h3s: 0, h4to6s: 0, linksSponsored: 0, linksUgc: 0, simhash: null, dateModified: null, datePublished: null, author: null, questionHeadings: 0, lists: 0, tables: 0, firstParagraphWords: null, dataNosnippet: 0, ...over });
const row = (over: Partial<UrlRow> = {}): UrlRow => ({ id: 1, url: 'https://example.com/a', kind: 'page', state: 'done', depth: 0, in_sitemap: 0, status: 200, content_type: 'text/html', redirect_target: null, x_robots: null, link_canonical: null, response_ms: 100, bytes: 500, error: null, blocked_reason: null, indexable: 1, indexability_reason: null, ...over });

describe('page signals', () => {
  const html = `<html lang="en-GB"><head><title>T</title><meta name="viewport" content="x"><meta property="og:title" content="x">
    <link rel="canonical nofollow" href="/c"><link rel="ALTERNATE" hreflang="fr" href="/fr"><meta name="author" content="Sam">
    <script type="application/ld+json">{"@type":"Article","dateModified":"2026-01-02","author":{"@type":"Person","name":"Ana"}}</script></head>
    <body><main><p>First paragraph here.</p></main><h2>What is SEO?</h2><h2>Pricing</h2><h3>How it works</h3>
    <img src="/a.png"><img src="/b.png" alt="" width="1" height="1" loading="lazy">
    <a href="/s" rel="sponsored nofollow">s</a><a href="/u" rel="ugc">u</a><ul><li>x</li></ul><table></table><span data-nosnippet>x</span></body></html>`;
  const facts = parseHtml(html, 'https://example.com/');

  it('reads head tags, images and link attributes', () => {
    expect(facts.signals).toMatchObject({ htmlLang: 'en-GB', viewport: true, ogTitle: true, ogImage: false, twitterCard: false, images: 2, imagesNoAlt: 1, imagesNoDimensions: 1, imagesLazy: 1, h3s: 1, linksSponsored: 1, linksUgc: 1 });
  });

  it('prefers JSON-LD for dates and authors, and reads answer structure', () => {
    expect(facts.signals).toMatchObject({ dateModified: '2026-01-02', author: 'Ana', questionHeadings: 2, lists: 1, tables: 1, firstParagraphWords: 3, dataNosnippet: 1 });
  });

  it('finds canonicals and hreflang when rel has several values or other casing', () => {
    expect(facts.canonicals).toEqual(['https://example.com/c']);
    expect(facts.hreflang).toEqual([{ lang: 'fr', href: 'https://example.com/fr' }]);
  });

  it('keeps similar texts close and different texts apart', () => {
    const words = Array.from({ length: 400 }, (_, i) => `word${i}`);
    const edited = [...words];
    edited[200] = 'changed';
    const other = Array.from({ length: 400 }, (_, i) => `other${i}`);
    const bits = (a: string, b: string) => (BigInt(`0x${a}`) ^ BigInt(`0x${b}`)).toString(2).replace(/0/g, '').length;
    const base = simhash(words.join(' '))!;
    expect(bits(base, simhash(edited.join(' '))!)).toBeLessThanOrEqual(3);
    expect(bits(base, simhash(other.join(' '))!)).toBeGreaterThan(3);
    expect(simhash('too short')).toBeNull();
  });
});

describe('page checks', () => {
  it('stays quiet about signals on crawls that have none', () => {
    expect([...checkHead(page({ signals: null })), ...checkImages(page({ signals: null }))]).toEqual([]);
  });

  it('reports missing head tags and image attributes', () => {
    expect(types(checkHead(page({ signals: signals({ htmlLang: null, viewport: false, ogImage: false }) })))).toEqual(['html_lang_missing', 'viewport_missing', 'open_graph_missing']);
    expect(types(checkImages(page({ signals: signals({ images: 3, imagesNoAlt: 1, imagesNoDimensions: 2 }) })))).toEqual(['image_alt_missing', 'image_no_dimensions']);
  });

  it('applies LocalBusiness rules to its subtypes', () => {
    const findings = checkStructuredData(page({ jsonLd: ['{"@type":"Plumber","name":"Acme"}'] }));
    expect(findings).toEqual([{ type: 'schema_missing_property', url: page().url, detail: 'Plumber: address' }]);
  });

  it('checks nested nodes without flagging references or a nested Review', () => {
    const product = { '@type': 'Product', name: 'P', brand: { '@id': '#org' }, review: { '@type': 'Review', reviewRating: { '@type': 'Rating' } }, offers: { '@type': 'Event' } };
    expect(checkStructuredData(page({ jsonLd: [JSON.stringify(product)] })).map((f) => f.detail)).toEqual(['Event: name', 'Event: startDate']);
  });

  it('lists every schema type at any depth, and none for bad JSON', () => {
    expect(schemaTypes('{"@graph":[{"@type":"WebSite"},{"@type":["Article","BlogPosting"],"author":{"@type":"Person"}}]}').sort()).toEqual(['Article', 'BlogPosting', 'Person', 'WebSite']);
    expect(schemaTypes('{oops')).toEqual([]);
  });

  it('flags a thin page saying it was not found, but not a long article about 404s', () => {
    expect(types(checkSoft404(page({ titles: ['Page not found'], wordCount: 20 })))).toEqual(['soft_404']);
    expect(checkSoft404(page({ titles: ['How to fix a 404'], wordCount: 900 }))).toEqual([]);
  });

  it('flags snippet controls from meta and headers', () => {
    expect(checkSnippetControls(page({ metaRobots: ['nosnippet'] }))[0].detail).toBe('nosnippet');
    expect(checkSnippetControls(page({ xRobots: 'max-snippet: 0' }))[0].detail).toBe('max-snippet:0');
    expect(checkSnippetControls(page({ metaRobots: ['max-snippet:50'] }))).toEqual([]);
  });

  it('reports SEO elements changed by rendering', () => {
    expect(checkRenderChanges(page({ signals: signals({ renderChanges: ['title', 'canonical'] }) }))[0].detail).toBe('title, canonical');
  });
});

describe('site checks', () => {
  const input = (links: SiteInput['links'], urls: UrlRow[] = [row()]): SiteInput => ({ startUrl: 'https://example.com/', urls, pages: [], links, hreflang: [] });

  it('separates temporary redirects from permanent ones', () => {
    expect(types(checkStatuses([row({ status: 302, redirect_target: 'x' })]))).toContain('redirect_temporary');
    expect(types(checkStatuses([row({ status: 301, redirect_target: 'x' })]))).not.toContain('redirect_temporary');
  });

  it('reports delivery problems, and skips headers older crawls never read', () => {
    expect(types(checkDelivery([row({ response_ms: 2000, bytes: 2_000_000, content_encoding: '' })]))).toEqual(['page_slow', 'page_heavy', 'no_compression']);
    expect(checkDelivery([row({ bytes: 5000, content_encoding: null })])).toEqual([]);
    expect(checkDelivery([row({ bytes: 5000, content_encoding: 'gzip' })])).toEqual([]);
    expect(types(checkDelivery([row({ kind: 'css', bytes: 600_000, content_encoding: 'br', cache_control: '' })]))).toEqual(['asset_heavy', 'asset_no_cache']);
    expect(checkDelivery([row({ kind: 'css', bytes: 10, cache_control: null })])).toEqual([]);
    expect(types(checkDelivery([row({ truncated: 1 })]))).toEqual(['html_truncated']);
  });

  it('finds HTTP resources on HTTPS pages only', () => {
    const links = [{ source: 'https://a/x', target: 'http://a/i.png', type: 'img' }, { source: 'https://a/x', target: 'http://a/y', type: 'a' }, { source: 'http://a/x', target: 'http://a/i.png', type: 'img' }];
    expect(checkMixedContent(input(links))).toEqual([{ type: 'mixed_content', url: 'https://a/x', detail: 'http://a/i.png' }]);
  });

  it('reports URL shapes', () => {
    expect(types(checkUrlShape([row({ url: 'https://e.com/Path?PHPSESSID=1&a=2' })]))).toEqual(['url_session_id', 'url_parameters', 'url_uppercase']);
    expect(checkUrlShape([row({ url: 'https://e.com/ok' })])).toEqual([]);
    expect(types(checkUrlShape([row({ url: 'https://e.com/ok?a=1', indexable: 0 })]))).toEqual([]);
  });

  it('reports near-duplicates but leaves exact ones to their own issue', () => {
    const [a, b, c] = ['0000000000000000', '0000000000000003', 'ffffffffffffffff'];
    const pages = [
      { url: 'https://e/a', title: null, meta: null, textHash: '1', canonical: null, simhash: a },
      { url: 'https://e/b', title: null, meta: null, textHash: '2', canonical: null, simhash: b },
      { url: 'https://e/c', title: null, meta: null, textHash: '3', canonical: null, simhash: c },
      { url: 'https://e/d', title: null, meta: null, textHash: '3', canonical: null, simhash: c },
    ];
    const urls = pages.map((p, i) => row({ id: i, url: p.url }));
    expect(checkNearDuplicates(pages, urls).map((f) => f.url).sort()).toEqual(['https://e/a', 'https://e/b']);
  });

  it('counts generic anchors on internal links only', () => {
    const urls = [row({ url: 'https://e/a' }), row({ url: 'https://x/ext', kind: 'external' })];
    const links = [{ source: 'https://e/s', target: 'https://e/a', type: 'a', anchor: 'Click here' }, { source: 'https://e/s', target: 'https://x/ext', type: 'a', anchor: 'click here' }, { source: 'https://e/s', target: 'https://e/a', type: 'a', anchor: 'Pricing plans' }];
    expect(checkAnchors(input(links, urls))).toEqual([{ type: 'link_generic_anchor', url: 'https://e/s', detail: '"Click here" x1' }]);
  });

  it('scores the most linked page highest', () => {
    const scores = linkScores(['a', 'b', 'c'], [{ source: 'a', target: 'c' }, { source: 'b', target: 'c' }, { source: 'c', target: 'a' }, { source: 'a', target: 'gone' }]);
    expect(scores.get('c')).toBe(100);
    expect(scores.get('b')!).toBeLessThan(scores.get('a')!);
    expect(linkScores([], []).size).toBe(0);
  });
});

describe('site audit checks', () => {
  const base = { robots: { url: 'https://e.com/robots.txt', status: 200, error: null, sitemaps: 1, blockedSearchBots: [] as string[] }, sitemaps: null, llms: { url: 'https://e.com/llms.txt', status: 404, contentType: null, hasHeading: false }, https: null, hostTwin: null };
  const file = (url: string, over = {}) => ({ url, status: 200, error: null, urls: 5, children: 0, lastmods: 5, bytes: 100, ...over });

  it('treats a robots.txt 5xx as serious and a 404 as minor', () => {
    expect(types(checkRobotsFile({ ...base, robots: { ...base.robots, status: 503 } }))).toEqual(['robots_unreachable']);
    expect(types(checkRobotsFile({ ...base, robots: { ...base.robots, status: null, error: 'timeout' } }))).toEqual(['robots_unreachable']);
    expect(types(checkRobotsFile({ ...base, robots: { ...base.robots, status: 404 } }))).toEqual(['robots_missing']);
    expect(types(checkRobotsFile({ ...base, robots: { ...base.robots, sitemaps: 0, blockedSearchBots: ['Googlebot'] } }))).toEqual(['robots_blocks_search', 'robots_no_sitemap']);
  });

  it('does not blame the site for sitemap names SAK guessed', () => {
    const guessed = { declared: [], reports: [file('https://e.com/sitemap.xml'), file('https://e.com/sitemap_index.xml', { status: 404, urls: 0 })] };
    expect(checkSitemapFiles({ ...base, sitemaps: guessed }, 'https://e.com/')).toEqual([]);
    const nothing = { declared: [], reports: [file('https://e.com/sitemap.xml', { status: 404, urls: 0 })] };
    expect(types(checkSitemapFiles({ ...base, sitemaps: nothing }, 'https://e.com/'))).toEqual(['sitemap_missing']);
  });

  it('reports declared sitemaps that fail, are too large or lack dates', () => {
    const sitemaps = { declared: ['https://e.com/s1.xml', 'https://e.com/s2.xml'], reports: [file('https://e.com/s1.xml', { status: 500, urls: 0 }), file('https://e.com/s2.xml', { urls: 60_000, lastmods: 0 })] };
    expect(types(checkSitemapFiles({ ...base, sitemaps }, 'https://e.com/'))).toEqual(['sitemap_unreachable', 'sitemap_too_large', 'sitemap_no_lastmod']);
    expect(checkSitemapFiles(base, 'https://e.com/')).toEqual([]);
  });

  it('only calls llms.txt invalid when a real file has no heading', () => {
    const llms = (over: object) => ({ ...base, llms: { ...base.llms, status: 200, contentType: 'text/plain', ...over } });
    expect(checkLlmsFile(base)).toEqual([]);
    expect(checkLlmsFile(llms({ hasHeading: true }))).toEqual([]);
    expect(checkLlmsFile(llms({ contentType: 'text/html' }))).toEqual([]);
    expect(types(checkLlmsFile(llms({})))).toEqual(['llms_invalid']);
  });

  it('checks HTTPS and host consolidation', () => {
    const answers = (status: number | null, location: string | null = null) => ({ status, error: null, location });
    expect(checkHosts({ ...base, https: answers(301, 'https://e.com/'), hostTwin: { url: 'https://www.e.com/', ...answers(301, 'https://e.com/') } }, 'https://e.com/')).toEqual([]);
    expect(types(checkHosts({ ...base, https: answers(200), hostTwin: { url: 'https://www.e.com/', ...answers(200) } }, 'https://e.com/'))).toEqual(['https_not_enforced', 'host_not_consolidated']);
    expect(types(checkHosts({ ...base, https: answers(301, 'http://other.com/') }, 'https://e.com/'))).toEqual(['https_not_enforced']);
    expect(types(checkHosts({ ...base, https: answers(301, 'https://e.com/') }, 'https://e.com/', row({ hsts: '' })))).toEqual(['hsts_missing']);
    expect(checkHosts({ ...base, hostTwin: { url: 'https://www.e.com/', ...answers(null) } }, 'https://e.com/', row({ hsts: null }))).toEqual([]);
    expect(types(checkHosts({ ...base, hostTwin: { url: 'http://www.e.com/', ...answers(null) } }, 'http://e.com/'))).toEqual(['https_not_used']);
  });

  it('raises no issue for blocking a training bot', () => {
    const bots = [
      { name: 'GPTBot', purpose: 'training', robots_allowed: 0, probe_status: null, probe_refused: null },
      { name: 'OAI-SearchBot', purpose: 'search', robots_allowed: 0, probe_status: null, probe_refused: null },
      { name: 'ClaudeBot', purpose: 'training', robots_allowed: 1, probe_status: 403, probe_refused: 1 },
    ];
    expect(checkAiBots('r', bots, 's')).toEqual([{ type: 'ai_bot_blocked', url: 'r', detail: 'OAI-SearchBot' }, { type: 'ai_bot_refused', url: 's', detail: 'ClaudeBot: 403' }]);
  });
});

describe('collecting the site audit', () => {
  const config = { ...DEFAULT_CONFIG, startUrl: 'https://e.com/', headers: { authorization: 'Bearer secret' } };
  const answers = (table: Record<string, () => Response>) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (!table[url]) throw new Error(`no answer for ${url}`);
      return table[url]();
    };
    return { calls, fetchImpl: fetchImpl as typeof fetch };
  };
  const moved = (location: string, status = 301) => () => new Response(null, { status, headers: { location } });
  const text = (body: string) => () => new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });

  it('keeps custom headers away from plain HTTP and other hosts', async () => {
    const { calls, fetchImpl } = answers({ 'https://e.com/robots.txt': text(''), 'https://e.com/llms.txt': text('# Docs'), 'http://e.com/': moved('https://e.com/'), 'https://www.e.com/': moved('https://e.com/') });
    await collectSiteAudit(config, null, fetchImpl);
    const sent = (url: string) => calls.find((call) => call.url === url)!.init.headers as Record<string, string>;
    expect(sent('https://e.com/robots.txt').authorization).toBe('Bearer secret');
    expect(sent('http://e.com/').authorization).toBeUndefined();
    expect(sent('https://www.e.com/').authorization).toBeUndefined();
  });

  it('follows redirects for robots.txt and llms.txt, so neither reads as missing', async () => {
    const { calls, fetchImpl } = answers({ 'https://e.com/robots.txt': text('User-agent: *\nAllow: /\nSitemap: https://e.com/s.xml'), 'https://e.com/llms.txt': text('# Docs'), 'http://e.com/': moved('https://e.com/'), 'https://www.e.com/': moved('https://e.com/') });
    const { audit } = await collectSiteAudit(config, null, fetchImpl);
    expect(calls.find((call) => call.url.endsWith('/robots.txt'))!.init.redirect).toBe('follow');
    expect(calls.find((call) => call.url.endsWith('/llms.txt'))!.init.redirect).toBe('follow');
    expect(audit.robots).toMatchObject({ status: 200, sitemaps: 1 });
    expect(audit.llms.hasHeading).toBe(true);
  });

  it('judges HTTP on where it ends up, across several hops', async () => {
    const chained = answers({ 'https://e.com/robots.txt': text(''), 'https://e.com/llms.txt': text(''), 'http://e.com/': moved('http://www.e.com/'), 'http://www.e.com/': moved('https://www.e.com/'), 'https://www.e.com/': moved('https://e.com/') });
    const { audit } = await collectSiteAudit(config, null, chained.fetchImpl);
    expect(checkHosts(audit, config.startUrl).map((f) => f.type)).toEqual([]);

    const insecure = answers({ 'https://e.com/robots.txt': text(''), 'https://e.com/llms.txt': text(''), 'http://e.com/': moved('http://www.e.com/'), 'http://www.e.com/': text('ok'), 'https://www.e.com/': moved('https://e.com/') });
    const second = await collectSiteAudit(config, null, insecure.fetchImpl);
    expect(checkHosts(second.audit, config.startUrl).map((f) => f.type)).toEqual(['https_not_enforced']);
  });

  it('skips host probes on local addresses', async () => {
    const { calls, fetchImpl } = answers({ 'http://127.0.0.1:9/robots.txt': text(''), 'http://127.0.0.1:9/llms.txt': text('') });
    const { audit } = await collectSiteAudit({ ...config, startUrl: 'http://127.0.0.1:9/' }, null, fetchImpl);
    expect(audit).toMatchObject({ https: null, hostTwin: null });
    expect(calls).toHaveLength(2);
  });

  it('turns a failed robots.txt fetch into a finding, not a failed crawl', async () => {
    const { fetchImpl } = answers({});
    const { audit } = await collectSiteAudit({ ...config, startUrl: 'http://127.0.0.1:9/' }, null, fetchImpl);
    expect(checkRobotsFile(audit).map((f) => f.type)).toEqual(['robots_unreachable']);
  });
});

describe('Business Profile checks', () => {
  const profile = (over: Partial<GbpRow> = {}): GbpRow => ({ key: 'k', title: 'Acme Plumbing', category: 'Plumber', description: 'd', address: '1 Main St, Raleigh, NC 27601', phone: '(919) 555-0100', url: 'https://acme.com/', domain: 'acme.com', is_claimed: 1, total_photos: 5, has_hours: 1, attributes: 2, services: 1, reviews_fetched: null, reviews_with_reply: null, latest_review: null, posts_fetched: null, latest_post: null, ...over });
  const site = readSiteBusiness(['{"@type":"Plumber","name":"Acme Plumbing Co","telephone":"+1 919-555-0100","address":{"streetAddress":"1 Main St","addressLocality":"Raleigh","addressRegion":"NC","postalCode":"27601"}}']);
  const live = [{ url: 'https://acme.com/', status: 200, indexable: 1 }];
  const now = new Date('2026-10-31T00:00:00Z');
  const check = (over: Partial<GbpRow> = {}, business = site, urls = live) => types(checkGbpProfile(profile(over), 'https://www.acme.com/', business, urls, now));

  it('passes a complete profile that matches the site, across phone formats and www', () => {
    expect(check()).toEqual([]);
  });

  it('reports claim status and missing fields', () => {
    expect(check({ is_claimed: 0 })).toEqual(['gbp_unclaimed']);
    const [finding] = checkGbpProfile(profile({ description: null, total_photos: 0, services: 0 }), 'https://acme.com/', site, live, now);
    expect(finding).toMatchObject({ type: 'gbp_incomplete', detail: 'Acme Plumbing: description, photos, services' });
  });

  it('reports a website link that points elsewhere or at a bad page', () => {
    expect(check({ domain: 'other.com' })).toEqual(['gbp_website_mismatch']);
    expect(check({ domain: 'book.acme.com' })).toEqual([]);
    expect(check({}, site, [{ url: 'https://acme.com/', status: 404, indexable: 0 }])).toEqual(['gbp_website_bad']);
  });

  it('reports name, address and phone that disagree with the schema', () => {
    expect(check({ phone: '(919) 555-9999' })).toEqual(['gbp_nap_mismatch']);
    expect(check({ address: '99 Elm Ave, Durham, NC 27701' })).toEqual(['gbp_nap_mismatch']);
    expect(check({ title: 'Zenith Heating' })).toEqual(['gbp_nap_mismatch']);
  });

  it('compares nothing when the site publishes no business details', () => {
    expect(check({ phone: '(919) 555-9999' }, readSiteBusiness([]))).toEqual([]);
  });

  it('reports unanswered and stale reviews and stale posts', () => {
    expect(check({ reviews_fetched: 10, reviews_with_reply: 2, latest_review: '2026-10-01' })).toEqual(['gbp_reviews_unanswered']);
    expect(check({ reviews_fetched: 2, reviews_with_reply: 0, latest_review: '2026-10-01' })).toEqual([]);
    expect(check({ reviews_fetched: 10, reviews_with_reply: 9, latest_review: '2026-01-01' })).toEqual(['gbp_reviews_stale']);
    expect(check({ latest_post: '2026-01-01' })).toEqual(['gbp_posts_stale']);
  });
});

describe('a crawl with site-level faults', () => {
  let home: string;
  let server: Server;
  let origin: string;
  let id: string;
  const seen: string[] = [];
  const article = (word: string) => Array.from({ length: 300 }, (_, i) => `${word}${i}`).join(' ');

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'sak-audit-'));
    process.env.SAK_HOME = home;
    server = createServer((req, res) => {
      const path = req.url ?? '/';
      seen.push(`${req.headers['user-agent']} ${path}`);
      const html = (body: string) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(body);
      };
      if (path === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('User-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n');
      }
      if (path === '/llms.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('just some text');
      }
      if (path === '/') return html(`<html><head><title>Home page with a sensible length title</title><script type="application/ld+json">{"@type":"Plumber","name":"Acme"}</script></head><body><h1>Home</h1><p>${article('home')}</p><a href="/gone">Click here</a><a href="/near-a">a</a><a href="/near-b">b</a></body></html>`);
      if (path === '/gone') return html('<html><head><title>Page not found</title></head><body><h1>Sorry</h1></body></html>');
      if (path === '/near-a') return html(`<html lang="en"><head><title>Near one</title><meta name="robots" content="nosnippet"></head><body><p>${article('same')} alpha</p></body></html>`);
      if (path === '/near-b') return html(`<html lang="en"><head><title>Near two</title></head><body><p>${article('same')} beta</p></body></html>`);
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    id = await startCrawl({ startUrl: origin, requestsPerSecond: 200, concurrency: 4, retries: 0 });
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });

  const issues = () => withCrawl(id, (db) => listIssues(db, { limit: 500 }).items);
  const typesFound = () => new Set(issues().map((issue) => issue.type));

  it('stores the audit and finds the faults end to end', () => {
    const audit = withCrawl(id, readSiteAudit)!;
    expect(audit.robots).toMatchObject({ status: 200, sitemaps: 0, blockedSearchBots: [] });
    expect(audit.https).toBeNull();
    for (const type of ['robots_no_sitemap', 'sitemap_missing', 'llms_invalid', 'ai_bot_blocked', 'soft_404', 'near_duplicate', 'html_lang_missing', 'viewport_missing', 'ai_snippet_restricted', 'schema_missing_property', 'link_generic_anchor']) {
      expect(typesFound(), type).toContain(type);
    }
  });

  it('separates blocked search bots from blocked training bots, and sends no bot requests by default', () => {
    const bots = withCrawl(id, (db) => listElement(db, 'ai-bots', { limit: 50 }).items) as { name: string; robots_allowed: number; probe_status: number | null }[];
    expect(bots.find((bot) => bot.name === 'GPTBot')!.robots_allowed).toBe(0);
    expect(bots.find((bot) => bot.name === 'ClaudeBot')!.robots_allowed).toBe(1);
    expect(issues().filter((issue) => issue.type === 'ai_bot_blocked').map((issue) => issue.detail)).toEqual(['OAI-SearchBot']);
    expect(bots.every((bot) => bot.probe_status === null)).toBe(true);
    expect(seen.some((request) => request.includes('compatible;'))).toBe(false);
  });

  it('builds a schema type table and link scores', () => {
    const home = withCrawl(id, (db) => listElement(db, 'internal', { search: `${origin}/`, sort: 'link_score', desc: true, limit: 1 }).items[0]) as { link_score: number };
    expect(home.link_score).toBeGreaterThan(0);
    expect(withCrawl(id, (db) => elementCounts(db, 'schema')).contains).toBe(1);
    const schema = withCrawl(id, (db) => listElement(db, 'schema', { filter: 'contains' }).items[0]) as { schema_types: string };
    expect(schema.schema_types).toBe('Plumber');
  });

  it('runs every filter of every element, including when empty', () => {
    withCrawl(id, (db) => {
      for (const element of elementCatalog()) {
        const counts = elementCounts(db, element.key);
        expect(Object.keys(counts).length).toBe(element.filters.length);
        for (const { key } of element.filters) expect(() => listElement(db, element.key, { filter: key, limit: 1 })).not.toThrow();
      }
    });
  });

  it('stays the same when analysed again', () => {
    const before = issues().length;
    const db = openCrawlDb(id);
    runAnalysis(db);
    db.close();
    expect(issues().length).toBe(before);
  });

  it('only requests pages as bots when asked to', async () => {
    seen.length = 0;
    await startCrawl({ startUrl: origin, requestsPerSecond: 200, concurrency: 4, retries: 0, probeAiBots: true }, {}, 'probed');
    expect(seen.filter((request) => request.includes('compatible; GPTBot'))).toHaveLength(1);
    const bots = withCrawl('probed', (db) => listElement(db, 'ai-bots', { limit: 50 }).items) as { name: string; probe_status: number }[];
    expect(bots.find((bot) => bot.name === 'GPTBot')!.probe_status).toBe(200);
  });
});
