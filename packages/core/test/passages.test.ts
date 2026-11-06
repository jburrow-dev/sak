import { describe, expect, it } from 'vitest';
import { parseHtml } from '../src/index.ts';
import { checkPassages, runPageChecks, type PageInput } from '../src/checks/page.ts';
import { checkRepeatedText, type SitePage } from '../src/checks/site.ts';
import type { PageSignals, UrlRow } from '../src/types.ts';

const words = (n: number, word = 'roof') => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ');
const signalsOf = (body: string, lang = 'en') => parseHtml(`<html lang="${lang}"><body>${body}</body></html>`, 'https://example.com/').signals;

const page = (signals: Partial<PageSignals>): PageInput => ({
  url: 'https://example.com/a', titles: ['A title'], metaDescriptions: [], h1s: ['Heading'], metaRobots: [], xRobots: null, canonicals: [], wordCount: 500,
  scriptCount: 0, hasEmptyAppRoot: false, hreflang: [], jsonLd: [], indexable: true, signals: signals as PageSignals,
});
const row = (url: string, indexable = 1): UrlRow => ({ id: 1, url, kind: 'page', state: 'done', depth: 0, in_sitemap: 0, status: 200, content_type: 'text/html', redirect_target: null, x_robots: null, link_canonical: null, response_ms: 100, bytes: 500, error: null, blocked_reason: null, indexable, indexability_reason: null });

describe('passage signals', () => {
  it('keeps a paragraph with a link in it as one block, and leaves word counts as they were', () => {
    const facts = parseHtml('<body><p>Call <a href="/x">our team</a> today for a <b>free</b> quote on your new roof.</p></body>', 'https://example.com/');
    expect(facts.signals.paragraphs).toBe(1);
    expect(facts.signals.textBlocks).toHaveLength(1);
    expect(facts.wordCount).toBe(12);
  });

  it('splits sections at h1 to h3, counting h4 text as part of its section', () => {
    const signals = signalsOf(`<p>${words(10)}</p><h2>Roof types</h2><p>${words(600)}</p><h3>Slate</h3><h4>Cost</h4><p>${words(20)}</p>`);
    expect(signals.sectionWords).toEqual([10, 600, 21]);
    expect(signals.longestSectionHeading).toBe('Roof types');
  });

  it('counts paragraphs that point back, but not "it" used as a placeholder', () => {
    const signals = signalsOf(`
      <p>It can take up to three days to replace a full roof.</p>
      <p>This means you should book well before the winter weather arrives.</p>
      <p>As mentioned above, slate costs more than asphalt shingles do.</p>
      <p>That’s why we offer a free inspection with every single quote.</p>
      <p>It is important to check your gutters twice a year at least.</p>
      <p>Asphalt shingles are the most common roofing material in the US.</p>
      <p>It works.</p>`);
    expect(signals.paragraphs).toBe(6);
    expect(signals.backReferences).toBe(4);
    expect(signals.backReferenceSample).toBe('It can take up to three days to…');
  });

  it('hashes blocks ignoring case, and skips blocks under three words', () => {
    const a = signalsOf('<p>Get a free roof quote today</p><p>Menu</p>');
    const b = signalsOf('<div>GET A FREE ROOF QUOTE TODAY</div>');
    expect(a.textBlocks).toHaveLength(1);
    expect(a.textBlocks![0]).toEqual(b.textBlocks![0]);
    expect(a.textBlocks![0][1]).toBe(6);
  });
});

describe('passage checks', () => {
  it('reports long sections with where the longest one is', () => {
    expect(checkPassages(page({ sectionWords: [40, 820], longestSectionHeading: 'Pricing' }))[0].detail).toBe('820 words under "Pricing"');
    expect(checkPassages(page({ sectionWords: [600, 900], longestSectionHeading: null }))[0].detail).toBe('2 sections, longest 900 words before the first heading');
    expect(checkPassages(page({ sectionWords: [1500], longestSectionHeading: null }))[0].detail).toBe('1500 words on a page with no h1–h3 headings');
    expect(checkPassages(page({ sectionWords: [500, 120] }))).toEqual([]);
  });

  it('reports back-references only when there are several and they are a large share', () => {
    const many = { paragraphs: 12, backReferences: 4, backReferenceSample: 'It can take…' };
    expect(checkPassages(page(many))).toEqual([{ type: 'paragraph_context_dependent', url: 'https://example.com/a', detail: '4 of 12 paragraphs, such as "It can take…"' }]);
    expect(checkPassages(page({ ...many, paragraphs: 20 }))).toEqual([]);
    expect(checkPassages(page({ paragraphs: 4, backReferences: 2 }))).toEqual([]);
  });

  it('checks back-references on English pages and pages with no language only', () => {
    const many = { paragraphs: 10, backReferences: 5, backReferenceSample: 'x' };
    expect(checkPassages(page({ ...many, htmlLang: 'en-GB' }))).toHaveLength(1);
    expect(checkPassages(page({ ...many, htmlLang: null }))).toHaveLength(1);
    expect(checkPassages(page({ ...many, htmlLang: 'fr' }))).toEqual([]);
  });

  it('stays quiet on crawls made before passage signals, and on non-indexable pages', () => {
    expect(checkPassages(page({ htmlLang: 'en' }))).toEqual([]);
    expect(runPageChecks({ ...page({ sectionWords: [900] }), indexable: false }).map((f) => f.type)).not.toContain('section_too_long');
  });
});

describe('repeated text', () => {
  const shared = `<p>${words(80, 'cta')}</p>`;
  const sitePage = (url: string, body: string): SitePage => {
    const facts = parseHtml(`<body>${body}</body>`, url);
    return { url, title: null, meta: null, textHash: facts.textHash, canonical: null, wordCount: facts.wordCount, textBlocks: facts.signals.textBlocks };
  };
  const found = (pages: SitePage[], urls = pages.map((p) => row(p.url))) => checkRepeatedText(pages, urls).map((f) => `${f.url} ${f.detail}`);

  it('reports pages that are mostly text shared with two or more other pages', () => {
    const pages = ['a', 'b', 'c'].map((name) => sitePage(`https://e/${name}`, `${shared}<p>${words(20, name)}</p>`));
    pages.push(sitePage('https://e/d', `${shared}<p>${words(200, 'd')}</p>`));
    expect(found(pages)).toEqual(['https://e/a 80% of 100 words', 'https://e/b 80% of 100 words', 'https://e/c 80% of 100 words']);
  });

  it('needs the block on three pages, and counts exact duplicates once', () => {
    const a = sitePage('https://e/a', `${shared}<p>${words(20, 'a')}</p>`);
    const b = sitePage('https://e/b', `${shared}<p>${words(20, 'b')}</p>`);
    expect(found([a, b])).toEqual([]);
    expect(found([a, b, { ...b, url: 'https://e/b-copy' }])).toEqual([]);
  });

  it('ignores non-indexable pages and pages under 100 words', () => {
    const pages = ['a', 'b', 'c'].map((name) => sitePage(`https://e/${name}`, `${shared}<p>${words(20, name)}</p>`));
    expect(found(pages, [row('https://e/a'), row('https://e/b'), row('https://e/c', 0)])).toEqual([]);
    const short = ['a', 'b', 'c'].map((name) => sitePage(`https://e/${name}`, `<p>${words(60, 'cta')}</p><p>${words(10, name)}</p>`));
    expect(found(short)).toEqual([]);
  });
});
