import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { HreflangEntry, LinkOut, PageFacts } from './types.ts';
import { normalizeUrl } from './url.ts';

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

// Formatting tags that can sit inside a word. Every other element boundary separates words,
// so <li>one</li><li>two</li> counts as two words rather than "onetwo".
const WORD_INTERNAL_TAGS = new Set(['b', 'i', 'em', 'strong', 'span', 'u', 's', 'sub', 'sup', 'small', 'mark', 'abbr', 'code', 'font', 'wbr']);

function visibleText(nodes: AnyNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.type === 'text') {
      out.push(node.data);
    } else if ('children' in node) {
      const joinsWords = node.type === 'tag' && WORD_INTERNAL_TAGS.has(node.name);
      if (!joinsWords) out.push(' ');
      visibleText(node.children, out);
      if (!joinsWords) out.push(' ');
    }
  }
  return out;
}

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
  $('link[rel="alternate"][hreflang]').each((_, el) => {
    const href = normalizeUrl($(el).attr('href') ?? '', base);
    if (href) hreflang.push({ lang: ($(el).attr('hreflang') ?? '').trim(), href });
  });

  const canonicals: string[] = [];
  $('link[rel="canonical"]').each((_, el) => {
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

  // Word count and duplicate detection look at page content, so menus and footers don't count.
  $('script, style, noscript, template, nav, footer').remove();
  const text = clean(visibleText($('body').contents().toArray()).join(''));
  const wordCount = text ? text.split(' ').length : 0;

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
