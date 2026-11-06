import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { HreflangEntry, LinkOut, PageFacts, PageSignals } from './types.ts';
import { normalizeUrl } from './url.ts';

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

// Formatting tags that can sit inside a word. Every other element boundary separates words,
// so <li>one</li><li>two</li> counts as two words rather than "onetwo".
const WORD_INTERNAL_TAGS = new Set(['b', 'i', 'em', 'strong', 'span', 'u', 's', 'sub', 'sup', 'small', 'mark', 'abbr', 'code', 'font', 'wbr']);

// Elements that start a new block of text. Others, such as links, only separate words, so a
// paragraph with a link in it stays one block. <br> counts because some sites use it between paragraphs.
const BLOCK_TAGS = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'caption', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li', 'main', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul']);
// Headings that start a new section. Retrieval systems that split at headings usually stop at h3.
const SECTION_TAGS = new Set(['h1', 'h2', 'h3']);
const MINOR_HEADING_TAGS = new Set(['h4', 'h5', 'h6']);

type BlockKind = 'section' | 'heading' | 'text';
interface TextBlock {
  kind: BlockKind;
  text: string;
}

/** Visible text split into blocks, such as paragraphs, list items and headings, in document order. */
function textBlocks(nodes: AnyNode[]): TextBlock[] {
  const blocks: TextBlock[] = [];
  let parts: string[] = [];
  const flush = (kind: BlockKind) => {
    const text = clean(parts.join(''));
    parts = [];
    if (text) blocks.push({ kind, text });
  };
  const walk = (list: AnyNode[], kind: BlockKind) => {
    for (const node of list) {
      if (node.type === 'text') {
        parts.push(node.data);
      } else if (!('children' in node)) {
        continue;
      } else if (node.type === 'tag' && WORD_INTERNAL_TAGS.has(node.name)) {
        walk(node.children, kind);
      } else if (node.type === 'tag' && BLOCK_TAGS.has(node.name)) {
        const own: BlockKind = SECTION_TAGS.has(node.name) ? 'section' : MINOR_HEADING_TAGS.has(node.name) ? 'heading' : kind;
        flush(kind);
        walk(node.children, own);
        flush(own);
      } else {
        parts.push(' ');
        walk(node.children, kind);
        parts.push(' ');
      }
    }
  };
  walk(nodes, 'text');
  flush('text');
  return blocks;
}

const countWords = (text: string) => text.split(' ').length;

// A paragraph that opens with a pronoun, or points "above", doesn't say what it is about when read alone.
const BACK_REFERENCE = /^(?:it|they|he|she|its|their)\b|^(?:this|that|these|those)(?:'s\b|[,.;:]|\s+(?:is|are|was|were|means|makes|made|allows|lets|helps|can|could|will|would|should|may|might|also|has|have|had|gives|ensures|includes?|requires?|depends|works)\b)|\bas (?:mentioned|noted|discussed|described|explained|shown|stated|outlined) (?:above|earlier|before|previously)\b|\bsee (?:above|below)\b|\bthe above\b|\bmentioned (?:above|earlier)\b/i;
// "It is important to..." uses "it" as a placeholder, not to point back.
const PLACEHOLDER_IT = /^it(?:'s| is| was)\s+(?:\S+\s+){1,2}?(?:to|that)\b/i;
const PARAGRAPH_MIN_WORDS = 8;
const MAX_SECTIONS = 200;
const MAX_TEXT_BLOCKS = 1000;
const TEXT_BLOCK_MIN_WORDS = 3;

/** How the text would split into passages, how many paragraphs lean on earlier text, and block hashes for finding repeated text. */
function passageSignals(blocks: TextBlock[]): Pick<PageSignals, 'sectionWords' | 'longestSectionHeading' | 'paragraphs' | 'backReferences' | 'backReferenceSample' | 'textBlocks'> {
  const sections: { heading: string | null; words: number }[] = [];
  let current: { heading: string | null; words: number } = { heading: null, words: 0 };
  let paragraphs = 0;
  let backReferences = 0;
  let backReferenceSample: string | null = null;
  for (const block of blocks) {
    if (block.kind === 'section') {
      if (current.heading !== null || current.words > 0) sections.push(current);
      current = { heading: block.text, words: 0 };
      continue;
    }
    const words = countWords(block.text);
    current.words += words;
    if (block.kind !== 'text' || words < PARAGRAPH_MIN_WORDS) continue;
    paragraphs++;
    const text = block.text.replace(/[‘’]/g, "'");
    if (BACK_REFERENCE.test(text) && !PLACEHOLDER_IT.test(text)) {
      backReferences++;
      backReferenceSample ??= `${text.split(' ').slice(0, 8).join(' ')}…`;
    }
  }
  if (current.heading !== null || current.words > 0) sections.push(current);
  const longest = sections.reduce<{ heading: string | null; words: number } | null>((best, s) => (!best || s.words > best.words ? s : best), null);
  return {
    sectionWords: sections.slice(0, MAX_SECTIONS).map((s) => s.words),
    longestSectionHeading: longest?.heading?.slice(0, 80) ?? null,
    paragraphs,
    backReferences,
    backReferenceSample,
    textBlocks: blocks
      .filter((block) => countWords(block.text) >= TEXT_BLOCK_MIN_WORDS)
      .slice(0, MAX_TEXT_BLOCKS)
      .map((block) => [createHash('sha1').update(block.text.toLowerCase()).digest('hex').slice(0, 12), countWords(block.text)]),
  };
}

const SIMHASH_MIN_WORDS = 100;

/** A 64-bit fingerprint where similar texts differ in few bits, so near-duplicates can be found without keeping the text. */
export function simhash(text: string): string | null {
  const words = text.toLowerCase().split(' ');
  if (words.length < SIMHASH_MIN_WORDS) return null;
  const weights = new Array<number>(64).fill(0);
  for (let i = 0; i + 3 <= words.length; i++) {
    const digest = createHash('md5').update(`${words[i]} ${words[i + 1]} ${words[i + 2]}`).digest();
    for (let bit = 0; bit < 64; bit++) weights[bit] += digest[bit >> 3] & (1 << (bit & 7)) ? 1 : -1;
  }
  const bytes = Buffer.alloc(8);
  weights.forEach((weight, bit) => {
    if (weight > 0) bytes[bit >> 3] |= 1 << (bit & 7);
  });
  return bytes.toString('hex');
}

/** Dates and authors from JSON-LD, including nodes nested inside others. */
function jsonLdFacts(blocks: string[]): { dateModified: string | null; datePublished: string | null; author: string | null } {
  const found = { dateModified: null as string | null, datePublished: null as string | null, author: null as string | null };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    if (!found.dateModified && typeof node.dateModified === 'string') found.dateModified = node.dateModified;
    if (!found.datePublished && typeof node.datePublished === 'string') found.datePublished = node.datePublished;
    if (!found.author && node.author) {
      const first = Array.isArray(node.author) ? node.author[0] : node.author;
      const name = typeof first === 'string' ? first : (first as { name?: unknown } | null)?.name;
      if (typeof name === 'string') found.author = name;
    }
    Object.values(node).forEach(visit);
  };
  for (const raw of blocks) {
    try {
      visit(JSON.parse(raw));
    } catch {
      // A block that doesn't parse has its own issue.
    }
  }
  return found;
}

const QUESTION_HEADING = /\?\s*$|^(who|what|when|where|why|how|which|can|does|do|is|are|should)\b/i;

export function parseHtml(html: string, pageUrl: string): PageFacts {
  const $ = cheerio.load(html);
  const baseHref = $('base[href]').first().attr('href');
  const base = (baseHref && normalizeUrl(baseHref, pageUrl)) || pageUrl;

  const links: LinkOut[] = [];
  $('a[href]').each((_, el) => {
    const url = normalizeUrl($(el).attr('href') ?? '', base);
    // Cloudflare's stand-in for an email link, which its script restores to mailto: in the browser.
    if (!url || new URL(url).pathname === '/cdn-cgi/l/email-protection') return;
    const rel = ($(el).attr('rel') ?? '').toLowerCase();
    links.push({ url, type: 'a', anchor: clean($(el).text()).slice(0, 300), nofollow: rel.includes('nofollow') });
  });
  $('img[src]').each((_, el) => {
    const url = normalizeUrl($(el).attr('src') ?? '', base);
    if (url) links.push({ url, type: 'img', anchor: clean($(el).attr('alt') ?? '').slice(0, 300), nofollow: false });
  });
  $('link[rel~="stylesheet" i][href]').each((_, el) => {
    const url = normalizeUrl($(el).attr('href') ?? '', base);
    if (url) links.push({ url, type: 'css', anchor: '', nofollow: false });
  });
  $('script[src]').each((_, el) => {
    const url = normalizeUrl($(el).attr('src') ?? '', base);
    if (url) links.push({ url, type: 'script', anchor: '', nofollow: false });
  });

  const hreflang: HreflangEntry[] = [];
  $('link[rel~="alternate" i][hreflang]').each((_, el) => {
    const href = normalizeUrl($(el).attr('href') ?? '', base);
    if (href) hreflang.push({ lang: ($(el).attr('hreflang') ?? '').trim(), href });
  });

  const canonicals: string[] = [];
  $('link[rel~="canonical" i]').each((_, el) => {
    const href = normalizeUrl($(el).attr('href') ?? '', base);
    if (href) canonicals.push(href);
  });

  // SVG icons have their own <title> elements, which aren't page titles.
  const titles = $('title').not('svg title').toArray().map((el) => clean($(el).text()));
  const metaDescriptions = $('meta[name="description" i]').toArray().map((el) => clean($(el).attr('content') ?? ''));
  const h1s = $('h1').toArray().map((el) => clean($(el).text()));
  const h2s = $('h2').toArray().map((el) => clean($(el).text()));
  const metaRobots = $('meta[name="robots" i], meta[name="googlebot" i]').toArray().map((el) => clean($(el).attr('content') ?? '').toLowerCase());
  const jsonLd = $('script[type="application/ld+json"]').toArray().map((el) => ({ raw: $(el).text() }));
  const scriptCount = $('script[src]').length;

  const appRoot = $('#root, #app, #__next, [data-reactroot]').first();
  const hasEmptyAppRoot = appRoot.length > 0 && clean(appRoot.text()).length === 0;

  const meta = (selector: string) => clean($(selector).first().attr('content') ?? '') || null;
  const images = $('img').toArray();
  const relCount = (value: string) => $('a[href]').toArray().filter((el) => ($(el).attr('rel') ?? '').toLowerCase().split(/\s+/).includes(value)).length;
  const fromJsonLd = jsonLdFacts(jsonLd.map((block) => block.raw));
  const headingTexts = $('h2, h3, h4').toArray().map((el) => clean($(el).text()));
  const signals: Omit<PageSignals, 'simhash' | 'firstParagraphWords'> = {
    htmlLang: clean($('html').attr('lang') ?? '') || null,
    viewport: $('meta[name="viewport" i]').length > 0,
    ogTitle: $('meta[property="og:title" i]').length > 0,
    ogImage: $('meta[property="og:image" i]').length > 0,
    twitterCard: $('meta[name="twitter:card" i]').length > 0,
    images: images.length,
    // alt="" is correct for a decorative image, so only a missing attribute counts.
    imagesNoAlt: images.filter((el) => $(el).attr('alt') === undefined).length,
    imagesNoDimensions: images.filter((el) => $(el).attr('width') === undefined || $(el).attr('height') === undefined).length,
    imagesLazy: images.filter((el) => ($(el).attr('loading') ?? '').toLowerCase() === 'lazy' || $(el).attr('data-src') !== undefined).length,
    h3s: $('h3').length,
    h4to6s: $('h4, h5, h6').length,
    linksSponsored: relCount('sponsored'),
    linksUgc: relCount('ugc'),
    dateModified: fromJsonLd.dateModified ?? meta('meta[property="article:modified_time" i]'),
    datePublished: fromJsonLd.datePublished ?? meta('meta[property="article:published_time" i]'),
    author: fromJsonLd.author ?? meta('meta[name="author" i]'),
    questionHeadings: headingTexts.filter((heading) => QUESTION_HEADING.test(heading)).length,
    lists: $('ul, ol').length,
    tables: $('table').length,
    dataNosnippet: $('[data-nosnippet]').length,
  };

  // Word count and duplicate detection look at page content, so menus and footers don't count.
  $('script, style, noscript, template, nav, footer').remove();
  const blocks = textBlocks($('body').contents().toArray());
  const text = blocks.map((block) => block.text).join(' ');
  const wordCount = text ? countWords(text) : 0;
  const firstParagraph = clean($('main p, article p, body p').first().text());

  return {
    titles,
    metaDescriptions,
    h1s,
    h2s,
    metaRobots,
    canonicals,
    hreflang,
    jsonLd,
    links,
    wordCount,
    textHash: text ? createHash('sha256').update(text).digest('hex') : null,
    htmlBytes: Buffer.byteLength(html),
    scriptCount,
    hasEmptyAppRoot,
    signals: { ...signals, simhash: text ? simhash(text) : null, firstParagraphWords: firstParagraph ? firstParagraph.split(' ').length : null, ...passageSignals(blocks) },
  };
}

/** Parses an RFC 8288 Link header, used for HTTP canonicals and hreflang. */
export function parseLinkHeader(header: string | null, pageUrl: string): { canonical: string | null; hreflang: HreflangEntry[] } {
  const result = { canonical: null as string | null, hreflang: [] as HreflangEntry[] };
  if (!header) return result;
  for (const part of header.split(/,(?=\s*<)/)) {
    const match = part.match(/<([^>]*)>(.*)/);
    if (!match) continue;
    const href = normalizeUrl(match[1], pageUrl);
    if (!href) continue;
    const params = match[2];
    const rel = params.match(/rel="?([^";]+)"?/i)?.[1]?.toLowerCase();
    const lang = params.match(/hreflang="?([^";]+)"?/i)?.[1];
    if (rel === 'canonical') result.canonical = href;
    if (rel === 'alternate' && lang) result.hreflang.push({ lang, href });
  }
  return result;
}
