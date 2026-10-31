import type { IssueFinding } from '../types.ts';
import { metaWidth, titleWidth } from './pixels.ts';

export interface PageInput {
  url: string;
  titles: string[];
  metaDescriptions: string[];
  h1s: string[];
  metaRobots: string[];
  xRobots: string | null;
  canonicals: string[];
  wordCount: number;
  scriptCount: number;
  hasEmptyAppRoot: boolean;
  hreflang: { lang: string; href: string }[];
  jsonLd: string[];
  indexable: boolean;
  rendered?: boolean;
  rawWordCount?: number | null;
  jsOnlyLinks?: number | null;
  renderError?: string | null;
}

const REQUIRED_PROPERTIES: Record<string, string[]> = {
  Article: ['headline'],
  BlogPosting: ['headline'],
  NewsArticle: ['headline'],
  Organization: ['name'],
  LocalBusiness: ['name', 'address'],
  Product: ['name'],
  BreadcrumbList: ['itemListElement'],
  FAQPage: ['mainEntity'],
  Event: ['name', 'startDate'],
  Review: ['itemReviewed', 'reviewRating'],
  WebSite: ['url'],
  Person: ['name'],
};

export const HREFLANG_PATTERN = /^(x-default|[a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}|\d{3}))?)$/i;

export function checkTitles(page: PageInput): IssueFinding[] {
  const out: IssueFinding[] = [];
  const title = page.titles.find((t) => t.length > 0);
  if (!title) return [{ type: 'title_missing', url: page.url }];
  if (page.titles.length > 1) out.push({ type: 'title_multiple', url: page.url, detail: `${page.titles.length} titles` });
  if (title.length > 60) out.push({ type: 'title_too_long', url: page.url, detail: `${title.length} characters` });
  if (title.length < 30) out.push({ type: 'title_too_short', url: page.url, detail: `${title.length} characters` });
  const width = titleWidth(title);
  if (width > 561) out.push({ type: 'title_too_wide', url: page.url, detail: `about ${width}px` });
  return out;
}

export function checkMeta(page: PageInput): IssueFinding[] {
  const out: IssueFinding[] = [];
  const meta = page.metaDescriptions.find((m) => m.length > 0);
  if (!meta) return [{ type: 'meta_missing', url: page.url }];
  if (page.metaDescriptions.length > 1) out.push({ type: 'meta_multiple', url: page.url, detail: `${page.metaDescriptions.length} descriptions` });
  if (meta.length > 155) out.push({ type: 'meta_too_long', url: page.url, detail: `${meta.length} characters` });
  if (meta.length < 70) out.push({ type: 'meta_too_short', url: page.url, detail: `${meta.length} characters` });
  const width = metaWidth(meta);
  if (width > 985) out.push({ type: 'meta_too_wide', url: page.url, detail: `about ${width}px` });
  return out;
}

export function checkHeadings(page: PageInput): IssueFinding[] {
  const h1s = page.h1s.filter((h) => h.length > 0);
  if (h1s.length === 0) return [{ type: 'h1_missing', url: page.url }];
  if (h1s.length > 1) return [{ type: 'h1_multiple', url: page.url, detail: `${h1s.length} H1s` }];
  return [];
}

export function checkDirectives(page: PageInput): IssueFinding[] {
  const out: IssueFinding[] = [];
  const directives = [...page.metaRobots, page.xRobots ?? ''].join(',');
  if (/\b(noindex|none)\b/i.test(directives)) out.push({ type: 'noindex', url: page.url });
  if (/\b(nofollow|none)\b/i.test(directives)) out.push({ type: 'nofollow', url: page.url });
  const canonicals = [...new Set(page.canonicals)];
  if (canonicals.length === 0) out.push({ type: 'canonical_missing', url: page.url });
  if (canonicals.length > 1) out.push({ type: 'canonical_multiple', url: page.url, detail: canonicals.join(' | ') });
  if (canonicals.length === 1 && canonicals[0] !== page.url) out.push({ type: 'canonical_other', url: page.url, detail: canonicals[0] });
  return out;
}

export function checkHreflang(page: PageInput): IssueFinding[] {
  if (page.hreflang.length === 0) return [];
  const out: IssueFinding[] = [];
  const byLang = new Map<string, Set<string>>();
  for (const { lang, href } of page.hreflang) {
    if (!HREFLANG_PATTERN.test(lang)) out.push({ type: 'hreflang_invalid', url: page.url, detail: lang });
    const key = lang.toLowerCase();
    if (!byLang.has(key)) byLang.set(key, new Set());
    byLang.get(key)!.add(href);
  }
  for (const [lang, hrefs] of byLang) {
    if (hrefs.size > 1) out.push({ type: 'hreflang_duplicate', url: page.url, detail: `${lang}: ${[...hrefs].join(' | ')}` });
  }
  if (!page.hreflang.some((h) => h.href === page.url)) out.push({ type: 'hreflang_missing_self', url: page.url });
  return out;
}

function schemaNodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(schemaNodes);
  if (value && typeof value === 'object') {
    const node = value as Record<string, unknown>;
    if (Array.isArray(node['@graph'])) return [...schemaNodes(node['@graph'])];
    return [node];
  }
  return [];
}

export function checkStructuredData(page: PageInput): IssueFinding[] {
  const out: IssueFinding[] = [];
  for (const raw of page.jsonLd) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      out.push({ type: 'schema_invalid_json', url: page.url, detail: (error as Error).message.slice(0, 200) });
      continue;
    }
    const context = (parsed as { '@context'?: unknown } | null)?.['@context'];
    if (!Array.isArray(parsed) && typeof context === 'string' && !/schema\.org/i.test(context)) {
      out.push({ type: 'schema_bad_context', url: page.url, detail: context });
    }
    for (const node of schemaNodes(parsed)) {
      const type = node['@type'];
      if (!type) {
        out.push({ type: 'schema_missing_type', url: page.url });
        continue;
      }
      for (const name of Array.isArray(type) ? type : [type]) {
        for (const property of REQUIRED_PROPERTIES[String(name)] ?? []) {
          if (node[property] === undefined) out.push({ type: 'schema_missing_property', url: page.url, detail: `${name}: ${property}` });
        }
      }
    }
  }
  return out;
}

export function checkContent(page: PageInput): IssueFinding[] {
  // Once a page has been rendered there is nothing left to guess about.
  const jsDependent = !page.rendered && (page.hasEmptyAppRoot || (page.wordCount < 50 && page.scriptCount >= 3));
  if (jsDependent) return [{ type: 'js_dependent', url: page.url, detail: `${page.wordCount} words, ${page.scriptCount} external scripts` }];
  if (page.wordCount < 200) return [{ type: 'low_word_count', url: page.url, detail: `${page.wordCount} words` }];
  return [];
}

export function checkRendering(page: PageInput): IssueFinding[] {
  if (page.renderError) return [{ type: 'render_failed', url: page.url, detail: page.renderError }];
  if (!page.rendered) return [];
  const out: IssueFinding[] = [];
  const raw = page.rawWordCount ?? 0;
  if (page.wordCount >= 50 && raw < page.wordCount / 2) out.push({ type: 'js_only_content', url: page.url, detail: `${raw} words as served, ${page.wordCount} rendered` });
  if (page.jsOnlyLinks) out.push({ type: 'js_only_links', url: page.url, detail: `${page.jsOnlyLinks} links` });
  return out;
}

export function runPageChecks(page: PageInput): IssueFinding[] {
  // Snippet and content problems only matter on pages meant to appear in search.
  const searchChecks = page.indexable ? [checkTitles, checkMeta, checkHeadings, checkContent] : [];
  return [...searchChecks, checkDirectives, checkHreflang, checkStructuredData, checkRendering].flatMap((check) => check(page));
}
