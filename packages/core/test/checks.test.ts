import { describe, expect, it } from 'vitest';
import { checkContent, checkDirectives, checkHeadings, checkHreflang, checkMeta, checkStructuredData, checkTitles, runPageChecks, type PageInput } from '../src/checks/page.ts';
import { buildRedirectChains, checkLinks, checkRedirectChains, type SiteInput } from '../src/checks/site.ts';
import { pixelWidth } from '../src/checks/pixels.ts';
import { computeIndexability } from '../src/analysis.ts';
import { csvCell } from '../src/export.ts';
import { parseHtml, parseLinkHeader } from '../src/parse.ts';
import { compileFilters, normalizeUrl } from '../src/url.ts';
import type { UrlRow } from '../src/types.ts';

const URL_A = 'https://example.com/a';

const page = (overrides: Partial<PageInput> = {}): PageInput => ({
  url: URL_A, titles: ['A title with a sensible length for search'], metaDescriptions: ['x'.repeat(100)], h1s: ['Heading'],
  metaRobots: [], xRobots: null, canonicals: [URL_A], wordCount: 500, scriptCount: 0, hasEmptyAppRoot: false, hreflang: [], jsonLd: [], indexable: true, ...overrides,
});

const row = (overrides: Partial<UrlRow> = {}): UrlRow => ({
  id: 1, url: URL_A, kind: 'page', state: 'done', depth: 0, in_sitemap: 0, status: 200, content_type: 'text/html', redirect_target: null, x_robots: null,
  link_canonical: null, response_ms: 1, bytes: 1, error: null, blocked_reason: null, indexable: 1, indexability_reason: null, ...overrides,
});

const types = (findings: { type: string }[]) => findings.map((f) => f.type);

describe('url handling', () => {
  it('strips fragments and resolves relative URLs', () => {
    expect(normalizeUrl('/b/../c#top', 'https://Example.com/a')).toBe('https://example.com/c');
  });
  it('rejects non-http schemes', () => {
    expect(normalizeUrl('mailto:a@b.c')).toBeNull();
    expect(normalizeUrl('javascript:void(0)', URL_A)).toBeNull();
  });
  it('applies exclude before include', () => {
    const allowed = compileFilters(['/blog/'], ['/blog/draft']);
    expect(allowed('https://x.com/blog/a')).toBe(true);
    expect(allowed('https://x.com/blog/draft')).toBe(false);
    expect(allowed('https://x.com/shop')).toBe(false);
  });
});

describe('HTML parsing', () => {
  it('survives malformed markup', () => {
    const facts = parseHtml('<p><a href="/x">x<h1>Open<div></span><table><td>', URL_A);
    expect(facts.links.map((l) => l.url)).toContain('https://example.com/x');
  });
  it('honours base href and rel=nofollow', () => {
    const facts = parseHtml('<base href="https://other.com/dir/"><a href="p" rel="nofollow ugc">p</a>', URL_A);
    expect(facts.links[0]).toMatchObject({ url: 'https://other.com/dir/p', nofollow: true });
  });
  it('excludes script text from word count', () => {
    const facts = parseHtml('<body>one two<script>var a = "three four five";</script></body>', URL_A);
    expect(facts.wordCount).toBe(2);
  });
  it('separates words across elements but not inside formatting', () => {
    expect(parseHtml('<body><h1>Heading</h1><p>one two</p><ul><li>a</li><li>b</li></ul><a href="/x">c</a><a href="/y">d</a></body>', URL_A).wordCount).toBe(7);
    expect(parseHtml('<body><p>w<b>or</b>d</p></body>', URL_A).wordCount).toBe(1);
  });
  it('leaves nav and footer out of word count but keeps their links', () => {
    const facts = parseHtml('<body><nav><a href="/menu">Menu item</a></nav><p>one two</p><footer>Copyright text</footer></body>', URL_A);
    expect(facts.wordCount).toBe(2);
    expect(facts.links.map((l) => l.url)).toEqual(['https://example.com/menu']);
  });
  it('ignores titles inside SVG icons', () => {
    const facts = parseHtml('<head><title>Page</title></head><body><svg><title>Icon</title></svg></body>', URL_A);
    expect(facts.titles).toEqual(['Page']);
  });
  it('finds an empty app root', () => {
    expect(parseHtml('<body><div id="root"></div></body>', URL_A).hasEmptyAppRoot).toBe(true);
    expect(parseHtml('<body><div id="root">content</div></body>', URL_A).hasEmptyAppRoot).toBe(false);
  });
  it('reads canonical and hreflang from a Link header', () => {
    const parsed = parseLinkHeader('<https://e.com/c>; rel="canonical", </fr>; rel="alternate"; hreflang="fr"', URL_A);
    expect(parsed.canonical).toBe('https://e.com/c');
    expect(parsed.hreflang).toEqual([{ lang: 'fr', href: 'https://example.com/fr' }]);
  });
});

describe('title and meta checks', () => {
  it('passes a healthy page', () => {
    expect(checkTitles(page())).toEqual([]);
    expect(checkMeta(page())).toEqual([]);
  });
  it('treats an empty title as missing', () => {
    expect(types(checkTitles(page({ titles: [''] })))).toEqual(['title_missing']);
  });
  it('flags length and width', () => {
    expect(types(checkTitles(page({ titles: ['W'.repeat(70)] })))).toEqual(['title_too_long', 'title_too_wide']);
    expect(types(checkTitles(page({ titles: ['Short'] })))).toEqual(['title_too_short']);
    expect(types(checkMeta(page({ metaDescriptions: ['x'.repeat(30)] })))).toEqual(['meta_too_short']);
  });
  it('measures narrow letters as narrower than wide ones', () => {
    expect(pixelWidth('iiii', 20)).toBeLessThan(pixelWidth('WWWW', 20));
  });
});

describe('heading and directive checks', () => {
  it('flags missing and multiple H1s', () => {
    expect(types(checkHeadings(page({ h1s: [] })))).toEqual(['h1_missing']);
    expect(types(checkHeadings(page({ h1s: ['a', 'b'] })))).toEqual(['h1_multiple']);
  });
  it('reads noindex from the header as well as the tag', () => {
    expect(types(checkDirectives(page({ xRobots: 'noindex' })))).toContain('noindex');
    expect(types(checkDirectives(page({ metaRobots: ['none'] })))).toEqual(expect.arrayContaining(['noindex', 'nofollow']));
  });
  it('flags conflicting canonicals', () => {
    expect(types(checkDirectives(page({ canonicals: [URL_A, 'https://example.com/b'] })))).toEqual(['canonical_multiple']);
    expect(types(checkDirectives(page({ canonicals: [URL_A, URL_A] })))).toEqual([]);
  });
});

describe('hreflang checks', () => {
  it('accepts valid codes', () => {
    const hreflang = [{ lang: 'en-GB', href: URL_A }, { lang: 'es-419', href: 'https://e.com/es' }, { lang: 'zh-Hant-TW', href: 'https://e.com/tw' }, { lang: 'x-default', href: 'https://e.com/' }];
    expect(checkHreflang(page({ hreflang }))).toEqual([]);
  });
  it('flags bad codes, duplicates and a missing self-reference', () => {
    const hreflang = [{ lang: 'en_GB', href: 'https://e.com/a' }, { lang: 'fr', href: 'https://e.com/b' }, { lang: 'fr', href: 'https://e.com/c' }];
    expect(types(checkHreflang(page({ hreflang })))).toEqual(['hreflang_invalid', 'hreflang_duplicate', 'hreflang_missing_self']);
  });
});

describe('structured data checks', () => {
  it('flags unparseable JSON', () => {
    expect(types(checkStructuredData(page({ jsonLd: ['{oops}'] })))).toEqual(['schema_invalid_json']);
  });
  it('walks @graph and reports missing properties', () => {
    const jsonLd = [JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'Article' }, { name: 'no type' }] })];
    expect(types(checkStructuredData(page({ jsonLd })))).toEqual(['schema_missing_property', 'schema_missing_type']);
  });
  it('passes a complete node', () => {
    const jsonLd = [JSON.stringify({ '@context': 'https://schema.org', '@type': 'Article', headline: 'x' })];
    expect(checkStructuredData(page({ jsonLd }))).toEqual([]);
  });
});

describe('non-indexable pages', () => {
  it('skips snippet and content checks but keeps technical ones', () => {
    const bare = page({ indexable: false, titles: [], metaDescriptions: [], h1s: [], wordCount: 5, metaRobots: ['noindex'], jsonLd: ['{oops}'] });
    expect(types(runPageChecks(bare))).toEqual(['noindex', 'schema_invalid_json']);
    expect(types(runPageChecks({ ...bare, indexable: true }))).toContain('h1_missing');
  });
});

describe('content checks', () => {
  it('reports JS dependence instead of thin content', () => {
    expect(types(checkContent(page({ wordCount: 2, scriptCount: 4 })))).toEqual(['js_dependent']);
    expect(types(checkContent(page({ wordCount: 2, hasEmptyAppRoot: true })))).toEqual(['js_dependent']);
    expect(types(checkContent(page({ wordCount: 50 })))).toEqual(['low_word_count']);
  });
});

describe('redirect chains', () => {
  const r = (id: number, url: string, target: string | null) => row({ id, url, redirect_target: target, status: target ? 301 : 200 });
  it('reports one chain from its head', () => {
    const chains = buildRedirectChains([r(1, 'a', 'b'), r(2, 'b', 'c'), r(3, 'c', 'd'), r(4, 'd', null)]);
    expect(chains).toHaveLength(1);
    expect(types(checkRedirectChains(chains))).toEqual(['redirect_chain']);
  });
  it('does not flag a single redirect', () => {
    expect(checkRedirectChains(buildRedirectChains([r(1, 'a', 'b'), r(2, 'b', null)]))).toEqual([]);
  });
  it('terminates on a loop and reports it once', () => {
    const chains = buildRedirectChains([r(1, 'a', 'b'), r(2, 'b', 'a')]);
    expect(types(checkRedirectChains(chains))).toEqual(['redirect_loop']);
  });
  it('handles a redirect to itself', () => {
    expect(types(checkRedirectChains(buildRedirectChains([r(1, 'a', 'a')])))).toEqual(['redirect_loop']);
  });
});

describe('link checks', () => {
  const input = (target: Partial<UrlRow>): SiteInput => ({
    startUrl: URL_A, pages: [], hreflang: [],
    urls: [row({ url: 'src' }), row({ id: 2, url: 'dst', ...target })],
    links: [{ source: 'src', target: 'dst', type: 'a' }],
  });
  it('separates a refusal from a broken external link', () => {
    expect(types(checkLinks(input({ kind: 'external', status: 403 })))).toEqual(['link_external_unverified']);
    expect(types(checkLinks(input({ kind: 'external', status: 404 })))).toEqual(['link_broken_external']);
  });
  it('does not call a WAF-blocked internal page broken', () => {
    expect(checkLinks(input({ status: 403, blocked_reason: 'WAF' }))).toEqual([]);
    expect(types(checkLinks(input({ status: 404 })))).toEqual(['link_broken_internal']);
  });
});

describe('indexability', () => {
  const facts = { meta_robots: [], canonicals: [], link_canonical: null };
  it('follows the expected precedence', () => {
    expect(computeIndexability(row(), facts).indexable).toBe(1);
    expect(computeIndexability(row({ state: 'blocked_robots', status: null }), undefined).reason).toBe('blocked by robots.txt');
    expect(computeIndexability(row({ status: 404 }), undefined).reason).toBe('status 404');
    expect(computeIndexability(row(), { ...facts, meta_robots: ['noindex'] }).reason).toBe('noindex');
    expect(computeIndexability(row(), { ...facts, canonicals: ['https://example.com/b'] }).reason).toBe('canonicalised');
    expect(computeIndexability(row(), { ...facts, canonicals: [URL_A] }).indexable).toBe(1);
  });
});

describe('CSV export', () => {
  it('quotes and neutralises spreadsheet formulas', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell(-5)).toBe('-5');
  });
});
