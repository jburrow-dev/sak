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
};

export type UrlKind = 'page' | 'external' | 'image';
export type UrlState = 'pending' | 'in_progress' | 'done' | 'blocked_robots';

export interface LinkOut {
  url: string;
  type: 'a' | 'img';
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

/** Everything extracted from one HTML document. */
export interface PageFacts {
  titles: string[];
  metaDescriptions: string[];
  h1s: string[];
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
}

export interface IssueFinding {
  type: string;
  url: string;
  detail?: string;
}
