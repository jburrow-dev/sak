export type Severity = 'error' | 'warning' | 'notice';

export interface CrawlConfig {
  startUrl: string;
  maxUrls: number;
  maxDepth: number | null;
  requestsPerSecond: number;
  concurrency: number;
  timeoutMs: number;
  retries: number;
  userAgent: string;
  headers: Record<string, string>;
  include: string[];
  exclude: string[];
  robotsMode: 'respect' | 'ignore' | 'custom';
  customRobots: string | null;
  useSitemaps: boolean;
  checkExternal: boolean;
  checkImages: boolean;
  /** Fetch linked stylesheets and scripts. */
  checkResources: boolean;
  /** Render pages in Chrome, so content and links added by JavaScript are seen. */
  renderJs: boolean;
  /** Treat subdomains of the start URL's host as part of the site. */
  crawlSubdomains: boolean;
  /** Extra in-scope URLs to start from, for sections nothing links to. */
  seeds: string[];
  /** Request the start URL once as each AI bot's user agent. Only for sites you may test this way. */
  probeAiBots: boolean;
}

export const DEFAULT_CONFIG: Omit<CrawlConfig, 'startUrl'> = {
  maxUrls: 10_000,
  maxDepth: null,
  requestsPerSecond: 2,
  concurrency: 2,
  timeoutMs: 20_000,
  retries: 2,
  userAgent: 'SAK-SEO-Spider/0.1',
  headers: {},
  include: [],
  exclude: [],
  robotsMode: 'respect',
  customRobots: null,
  useSitemaps: true,
  checkExternal: true,
  checkImages: true,
  checkResources: true,
  renderJs: false,
  crawlSubdomains: false,
  seeds: [],
  probeAiBots: false,
};

export type UrlKind = 'page' | 'external' | 'image' | 'css' | 'script';
export type UrlState = 'pending' | 'in_progress' | 'done' | 'blocked_robots';

export interface LinkOut {
  url: string;
  type: 'a' | 'img' | 'css' | 'script';
  anchor: string;
  nofollow: boolean;
}

export interface HreflangEntry {
  lang: string;
  href: string;
}

export interface JsonLdBlock {
  raw: string;
}

/** Smaller facts about a page, stored together because checks read them one at a time. */
export interface PageSignals {
  htmlLang: string | null;
  viewport: boolean;
  ogTitle: boolean;
  ogImage: boolean;
  twitterCard: boolean;
  images: number;
  imagesNoAlt: number;
  imagesNoDimensions: number;
  imagesLazy: number;
  h3s: number;
  h4to6s: number;
  linksSponsored: number;
  linksUgc: number;
  simhash: string | null;
  dateModified: string | null;
  datePublished: string | null;
  author: string | null;
  questionHeadings: number;
  lists: number;
  tables: number;
  firstParagraphWords: number | null;
  dataNosnippet: number;
  /** SEO elements that differ between the HTML as served and the rendered page. */
  renderChanges?: string[];
}

/** Everything extracted from one HTML document. */
export interface PageFacts {
  titles: string[];
  metaDescriptions: string[];
  h1s: string[];
  h2s: string[];
  metaRobots: string[];
  canonicals: string[];
  hreflang: HreflangEntry[];
  jsonLd: JsonLdBlock[];
  links: LinkOut[];
  wordCount: number;
  textHash: string | null;
  htmlBytes: number;
  scriptCount: number;
  hasEmptyAppRoot: boolean;
  signals: PageSignals;
}

/** One row of crawl data as read back for checks and queries. */
export interface UrlRow {
  id: number;
  url: string;
  kind: UrlKind;
  state: UrlState;
  depth: number | null;
  in_sitemap: number;
  status: number | null;
  content_type: string | null;
  redirect_target: string | null;
  x_robots: string | null;
  link_canonical: string | null;
  response_ms: number | null;
  bytes: number | null;
  error: string | null;
  blocked_reason: string | null;
  indexable: number | null;
  indexability_reason: string | null;
  content_encoding?: string | null;
  cache_control?: string | null;
  hsts?: string | null;
  truncated?: number | null;
}

export interface PageRow {
  url_id: number;
  url: string;
  titles: string[];
  meta_descriptions: string[];
  h1s: string[];
  meta_robots: string[];
  canonicals: string[];
  word_count: number;
  text_hash: string | null;
  html_bytes: number;
  script_count: number;
  has_empty_app_root: number;
  rendered: number;
  raw_word_count: number | null;
  js_only_links: number | null;
  render_error: string | null;
  signals: PageSignals | null;
}

export interface IssueFinding {
  type: string;
  url: string;
  detail?: string;
}
