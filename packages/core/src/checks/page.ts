import type { IssueFinding, PageSignals } from '../types.ts';
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
  signals?: PageSignals | null;
}

/** Common schema.org subtypes of LocalBusiness, so a Plumber gets the same checks as its parent. */
const LOCAL_BUSINESS_SUBTYPES = new Set(['AnimalShelter', 'ArchiveOrganization', 'AutomotiveBusiness', 'AutoBodyShop', 'AutoDealer', 'AutoRepair', 'ChildCare', 'Dentist', 'DryCleaningOrLaundry', 'EmergencyService', 'EmploymentAgency', 'EntertainmentBusiness', 'FinancialService', 'AccountingService', 'InsuranceAgency', 'FoodEstablishment', 'Bakery', 'BarOrPub', 'CafeOrCoffeeShop', 'Restaurant', 'GovernmentOffice', 'HealthAndBeautyBusiness', 'BeautySalon', 'DaySpa', 'HairSalon', 'HomeAndConstructionBusiness', 'Electrician', 'GeneralContractor', 'HVACBusiness', 'HousePainter', 'Locksmith', 'MovingCompany', 'Plumber', 'RoofingContractor', 'InternetCafe', 'LegalService', 'Attorney', 'Notary', 'Library', 'LodgingBusiness', 'Hotel', 'MedicalBusiness', 'Physician', 'ProfessionalService', 'RadioStation', 'RealEstateAgent', 'RecyclingCenter', 'SelfStorage', 'ShoppingCenter', 'SportsActivityLocation', 'Store', 'TelevisionStation', 'TouristInformationCenter', 'TravelAgency']);

const SOFT_404 = /\b(404|page not found|not found|page (doesn't|does not|no longer) exists?|no longer available)\b/i;
const SOFT_404_MAX_WORDS = 200;

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

/** Typed nodes inside another node, such as a Review on a Product. A bare {"@id": ...} is only a reference. */
function nestedNodes(node: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    const child = value as Record<string, unknown>;
    if (child['@type']) out.push(child);
    Object.values(child).forEach(visit);
  };
  Object.entries(node).forEach(([key, value]) => {
    if (key !== '@graph') visit(value);
  });
  return out;
}

/** Every schema.org type a JSON-LD block declares, at any depth. Blocks that don't parse give none. */
export function schemaTypes(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const names = schemaNodes(parsed).flatMap((node) => [node, ...nestedNodes(node)]).flatMap((node) => node['@type'] ?? []);
  return [...new Set(names.map(String))];
}

const requiredFor = (name: string) => REQUIRED_PROPERTIES[name] ?? (LOCAL_BUSINESS_SUBTYPES.has(name) ? REQUIRED_PROPERTIES.LocalBusiness : []);

function missingProperties(node: Record<string, unknown>, nested: boolean): string[] {
  const type = node['@type'];
  return (Array.isArray(type) ? type : [type]).flatMap((name) => requiredFor(String(name))
    // A nested Review reviews the node it sits in, so it doesn't repeat itemReviewed.
    .filter((property) => node[property] === undefined && !(nested && property === 'itemReviewed'))
    .map((property) => `${name}: ${property}`));
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
      if (!node['@type']) {
        out.push({ type: 'schema_missing_type', url: page.url });
      } else {
        for (const detail of missingProperties(node, false)) out.push({ type: 'schema_missing_property', url: page.url, detail });
      }
      for (const child of nestedNodes(node)) {
        for (const detail of missingProperties(child, true)) out.push({ type: 'schema_missing_property', url: page.url, detail });
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

export function checkSoft404(page: PageInput): IssueFinding[] {
  const heading = page.titles.find((t) => SOFT_404.test(t)) ?? page.h1s.find((h) => SOFT_404.test(h));
  return heading && page.wordCount < SOFT_404_MAX_WORDS ? [{ type: 'soft_404', url: page.url, detail: heading.slice(0, 120) }] : [];
}

/** Older crawls have no signals, so these stay quiet rather than reporting every page. */
export function checkHead(page: PageInput): IssueFinding[] {
  const signals = page.signals;
  if (!signals) return [];
  const out: IssueFinding[] = [];
  if (!signals.htmlLang) out.push({ type: 'html_lang_missing', url: page.url });
  if (!signals.viewport) out.push({ type: 'viewport_missing', url: page.url });
  if (!signals.ogTitle || !signals.ogImage) out.push({ type: 'open_graph_missing', url: page.url, detail: [!signals.ogTitle && 'og:title', !signals.ogImage && 'og:image'].filter(Boolean).join(', ') });
  return out;
}

export function checkImages(page: PageInput): IssueFinding[] {
  const signals = page.signals;
  if (!signals) return [];
  const out: IssueFinding[] = [];
  if (signals.imagesNoAlt > 0) out.push({ type: 'image_alt_missing', url: page.url, detail: `${signals.imagesNoAlt} of ${signals.images} images` });
  if (signals.imagesNoDimensions > 0) out.push({ type: 'image_no_dimensions', url: page.url, detail: `${signals.imagesNoDimensions} of ${signals.images} images` });
  return out;
}

export function checkSnippetControls(page: PageInput): IssueFinding[] {
  const directives = [...page.metaRobots, page.xRobots ?? ''].join(',');
  const restrictive = /\bnosnippet\b/i.test(directives) ? 'nosnippet' : /\bmax-snippet\s*:\s*0\b/i.test(directives) ? 'max-snippet:0' : null;
  return restrictive ? [{ type: 'ai_snippet_restricted', url: page.url, detail: restrictive }] : [];
}

export function checkRenderChanges(page: PageInput): IssueFinding[] {
  return page.signals?.renderChanges?.length ? [{ type: 'render_changes_seo', url: page.url, detail: page.signals.renderChanges.join(', ') }] : [];
}

export function runPageChecks(page: PageInput): IssueFinding[] {
  // Snippet and content problems only matter on pages meant to appear in search.
  const searchChecks = page.indexable ? [checkTitles, checkMeta, checkHeadings, checkContent, checkSoft404, checkHead, checkImages, checkSnippetControls] : [];
  return [...searchChecks, checkDirectives, checkHreflang, checkStructuredData, checkRendering, checkRenderChanges].flatMap((check) => check(page));
}
