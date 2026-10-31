import type { Db } from './db.ts';
import { csvCell } from './export.ts';
import type { Page } from './query.ts';

export type ElementColumnType = 'url' | 'text' | 'number' | 'status' | 'bytes' | 'yesno';

export interface ElementColumn {
  key: string;
  label: string;
  type: ElementColumnType;
}

export interface ElementFilter {
  key: string;
  label: string;
  /** A SQL condition over the element's source columns. Empty means every row. */
  where: string;
}

interface ElementDefinition {
  key: string;
  label: string;
  source: string;
  search: string[];
  columns: ElementColumn[];
  filters: ElementFilter[];
}

const PAGE_SOURCE = `SELECT u.id, u.url, u.state, u.depth, u.indexable, u.indexability_reason, u.in_sitemap,
    r.status, r.content_type, r.response_ms, r.bytes, r.redirect_target, r.x_robots, r.error, r.blocked_reason,
    p.url_id IS NOT NULL AS is_html,
    json_extract(p.titles, '$[0]') AS title, json_array_length(p.titles) AS title_count, length(json_extract(p.titles, '$[0]')) AS title_length,
    json_extract(p.meta_descriptions, '$[0]') AS meta, json_array_length(p.meta_descriptions) AS meta_count, length(json_extract(p.meta_descriptions, '$[0]')) AS meta_length,
    json_extract(p.h1s, '$[0]') AS h1, json_array_length(p.h1s) AS h1_count, length(json_extract(p.h1s, '$[0]')) AS h1_length,
    json_extract(p.h2s, '$[0]') AS h2, json_array_length(p.h2s) AS h2_count, length(json_extract(p.h2s, '$[0]')) AS h2_length,
    COALESCE(json_extract(p.canonicals, '$[0]'), r.link_canonical) AS canonical,
    TRIM(COALESCE(json_extract(p.meta_robots, '$[0]'), '') || ' ' || COALESCE(r.x_robots, '')) AS directives,
    p.word_count, p.html_bytes, p.script_count, p.rendered, p.raw_word_count, p.js_only_links, p.render_error,
    (SELECT COUNT(DISTINCT l.source_id) FROM links l WHERE l.target_id = u.id AND l.type = 'a') AS inlinks,
    (SELECT group_concat(h.lang, ', ') FROM hreflang h WHERE h.url_id = u.id) AS hreflang_codes,
    (SELECT COUNT(*) FROM structured_data s WHERE s.url_id = u.id) AS schema_blocks
  FROM urls u LEFT JOIN responses r ON r.url_id = u.id LEFT JOIN page_elements p ON p.url_id = u.id
  WHERE u.kind = 'page'`;

const htmlPages = (extra = '') => `SELECT * FROM (${PAGE_SOURCE}) WHERE is_html${extra}`;

const assetSource = (kind: string) => `SELECT u.id, u.url, u.state, r.status, r.content_type, r.response_ms, r.bytes, r.error, r.blocked_reason,
    (SELECT COUNT(DISTINCT l.source_id) FROM links l WHERE l.target_id = u.id) AS inlinks,
    (SELECT COUNT(*) FROM links l WHERE l.target_id = u.id AND COALESCE(l.anchor, '') = '') AS without_anchor
  FROM urls u LEFT JOIN responses r ON r.url_id = u.id
  WHERE u.kind = '${kind}'`;

const LINK_SOURCE = `SELECT l.rowid AS id, s.url AS source, t.url, t.kind AS target_kind, l.anchor, l.nofollow, r.status, r.error, r.blocked_reason
  FROM links l JOIN urls s ON s.id = l.source_id JOIN urls t ON t.id = l.target_id LEFT JOIN responses r ON r.url_id = t.id
  WHERE l.type = 'a'`;

const column = (key: string, label: string, type: ElementColumnType = 'text'): ElementColumn => ({ key, label, type });
const filter = (key: string, label: string, where: string): ElementFilter => ({ key, label, where });
const ALL = filter('all', 'All', '');

/** Reuses a check's result, so filters agree with the Issues tab on things like pixel widths. */
const hasIssue = (...types: string[]) => `EXISTS (SELECT 1 FROM issues i WHERE i.url = x.url AND i.type IN (${types.map((t) => `'${t}'`).join(', ')}))`;
const issueFilter = (key: string, label: string, ...types: string[]) => filter(key, label, hasIssue(...types));

const URL_COLUMN = column('url', 'URL', 'url');
const STATUS_COLUMN = column('status', 'Status', 'status');

const statusFilters = [
  filter('2xx', '2xx', 'status >= 200 AND status < 300'),
  filter('3xx', '3xx', 'status >= 300 AND status < 400'),
  filter('4xx', '4xx', 'status >= 400 AND status < 500'),
  filter('5xx', '5xx', 'status >= 500'),
  filter('refused', 'Refused', 'blocked_reason IS NOT NULL'),
  filter('failed', 'No response', 'error IS NOT NULL'),
];

const textElement = (key: string, label: string, name: string, longest: number, shortest: number | null, issues: { duplicate?: string; wide?: string }): ElementDefinition => ({
  key,
  label,
  source: htmlPages(),
  search: ['url', name],
  columns: [URL_COLUMN, column(name, label), column(`${name}_length`, 'Characters', 'number'), column(`${name}_count`, 'Count', 'number'), column('indexable', 'Indexable', 'yesno')],
  filters: [
    ALL,
    filter('missing', 'Missing', `COALESCE(${name}, '') = '' AND ${name}_count IS NOT NULL`),
    filter('multiple', 'Multiple', `${name}_count > 1`),
    ...(issues.duplicate ? [issueFilter('duplicate', 'Duplicate', issues.duplicate)] : []),
    filter('long', `Over ${longest} characters`, `${name}_length > ${longest}`),
    ...(shortest ? [filter('short', `Under ${shortest} characters`, `${name}_length < ${shortest}`)] : []),
    ...(issues.wide ? [issueFilter('wide', 'Over pixel width', issues.wide)] : []),
  ],
});

const resourceElement = (key: string, label: string, kind: string): ElementDefinition => ({
  key,
  label,
  source: assetSource(kind),
  search: ['url'],
  columns: [URL_COLUMN, STATUS_COLUMN, column('content_type', 'Type'), column('bytes', 'Size', 'bytes'), column('response_ms', 'Response ms', 'number'), column('inlinks', 'Used by pages', 'number')],
  filters: [
    ALL,
    ...statusFilters,
    filter('large', 'Over 500 KB', 'bytes > 512000'),
    ...(kind === 'image' ? [filter('no-alt', 'Missing alt text', 'without_anchor > 0')] : []),
  ],
});

const ELEMENTS: ElementDefinition[] = [
  {
    key: 'internal',
    label: 'Internal',
    source: PAGE_SOURCE,
    search: ['url', 'title'],
    columns: [URL_COLUMN, STATUS_COLUMN, column('content_type', 'Type'), column('indexable', 'Indexable', 'yesno'), column('indexability_reason', 'Reason'), column('title', 'Title'), column('word_count', 'Words', 'number'), column('depth', 'Depth', 'number'), column('inlinks', 'Inlinks', 'number'), column('response_ms', 'Response ms', 'number'), column('bytes', 'Size', 'bytes')],
    filters: [ALL, filter('html', 'HTML', 'is_html'), filter('non-html', 'Non-HTML', 'NOT is_html'), filter('indexable', 'Indexable', 'indexable = 1'), filter('non-indexable', 'Non-indexable', 'indexable = 0')],
  },
  {
    key: 'external',
    label: 'External',
    source: `SELECT * FROM (${assetSource('external')})`,
    search: ['url'],
    columns: [URL_COLUMN, STATUS_COLUMN, column('content_type', 'Type'), column('response_ms', 'Response ms', 'number'), column('inlinks', 'Linked from', 'number')],
    filters: [ALL, ...statusFilters],
  },
  {
    key: 'response',
    label: 'Response codes',
    source: PAGE_SOURCE,
    search: ['url', 'redirect_target'],
    columns: [URL_COLUMN, STATUS_COLUMN, column('redirect_target', 'Redirects to', 'url'), column('response_ms', 'Response ms', 'number'), column('inlinks', 'Inlinks', 'number'), column('error', 'Error')],
    filters: [ALL, ...statusFilters, filter('robots', 'Blocked by robots.txt', `state = 'blocked_robots'`), issueFilter('chain', 'Redirect chain', 'redirect_chain'), issueFilter('loop', 'Redirect loop', 'redirect_loop')],
  },
  textElement('title', 'Page titles', 'title', 60, 30, { duplicate: 'title_duplicate', wide: 'title_too_wide' }),
  textElement('meta', 'Meta descriptions', 'meta', 155, 70, { duplicate: 'meta_duplicate', wide: 'meta_too_wide' }),
  textElement('h1', 'H1', 'h1', 70, null, {}),
  textElement('h2', 'H2', 'h2', 70, null, {}),
  {
    key: 'canonical',
    label: 'Canonicals',
    source: htmlPages(),
    search: ['url', 'canonical'],
    columns: [URL_COLUMN, column('canonical', 'Canonical', 'url'), column('indexable', 'Indexable', 'yesno'), column('indexability_reason', 'Reason')],
    filters: [ALL, filter('self', 'Self-referencing', 'canonical = url'), filter('other', 'Canonicalised elsewhere', 'canonical <> url'), filter('missing', 'Missing', 'canonical IS NULL'), issueFilter('multiple', 'Conflicting', 'canonical_multiple'), issueFilter('bad', 'Target not indexable', 'canonical_target_bad')],
  },
  {
    key: 'directives',
    label: 'Directives',
    source: htmlPages(),
    search: ['url', 'directives'],
    columns: [URL_COLUMN, column('directives', 'Robots directives'), column('indexable', 'Indexable', 'yesno')],
    filters: [ALL, filter('any', 'Has directives', `directives <> ''`), filter('noindex', 'Noindex', `directives LIKE '%noindex%' OR directives LIKE '%none%'`), filter('nofollow', 'Nofollow', `directives LIKE '%nofollow%' OR directives LIKE '%none%'`)],
  },
  {
    key: 'hreflang',
    label: 'Hreflang',
    source: htmlPages(),
    search: ['url', 'hreflang_codes'],
    columns: [URL_COLUMN, column('hreflang_codes', 'Languages'), column('indexable', 'Indexable', 'yesno')],
    filters: [ALL, filter('contains', 'Has hreflang', 'hreflang_codes IS NOT NULL'), filter('none', 'No hreflang', 'hreflang_codes IS NULL'), issueFilter('invalid', 'Invalid code', 'hreflang_invalid'), issueFilter('self', 'No self-reference', 'hreflang_missing_self'), issueFilter('return', 'No return tag', 'hreflang_no_return'), issueFilter('target', 'Target not 200', 'hreflang_target_bad')],
  },
  {
    key: 'schema',
    label: 'Structured data',
    source: htmlPages(),
    search: ['url'],
    columns: [URL_COLUMN, column('schema_blocks', 'JSON-LD blocks', 'number'), column('indexable', 'Indexable', 'yesno')],
    filters: [ALL, filter('contains', 'Has JSON-LD', 'schema_blocks > 0'), filter('none', 'No JSON-LD', 'schema_blocks = 0'), issueFilter('invalid', 'Does not parse', 'schema_invalid_json'), issueFilter('property', 'Missing core property', 'schema_missing_property', 'schema_missing_type')],
  },
  {
    key: 'content',
    label: 'Content',
    source: htmlPages(),
    search: ['url', 'title'],
    columns: [URL_COLUMN, column('word_count', 'Words', 'number'), column('html_bytes', 'HTML size', 'bytes'), column('title', 'Title'), column('indexable', 'Indexable', 'yesno')],
    filters: [ALL, filter('thin', 'Under 200 words', 'word_count < 200'), issueFilter('duplicate', 'Exact duplicates', 'duplicate_exact')],
  },
  {
    key: 'javascript',
    label: 'JavaScript',
    source: htmlPages(),
    search: ['url', 'render_error'],
    columns: [URL_COLUMN, column('rendered', 'Rendered', 'yesno'), column('raw_word_count', 'Words as served', 'number'), column('word_count', 'Words', 'number'), column('js_only_links', 'JS-only links', 'number'), column('script_count', 'Scripts', 'number'), column('render_error', 'Render error')],
    filters: [ALL, filter('rendered', 'Rendered', 'rendered = 1'), filter('not-rendered', 'Not rendered', 'rendered = 0'), issueFilter('content', 'Most content needs JS', 'js_only_content'), issueFilter('links', 'JS-only links', 'js_only_links'), issueFilter('failed', 'Render failed', 'render_failed'), issueFilter('dependent', 'May need rendering', 'js_dependent')],
  },
  resourceElement('images', 'Images', 'image'),
  resourceElement('css', 'CSS', 'css'),
  resourceElement('scripts', 'Scripts', 'script'),
  {
    key: 'links',
    label: 'Links',
    source: LINK_SOURCE,
    search: ['source', 'url', 'anchor'],
    columns: [column('source', 'From', 'url'), column('url', 'To', 'url'), column('anchor', 'Anchor'), column('nofollow', 'Nofollow', 'yesno'), STATUS_COLUMN],
    filters: [ALL, filter('internal', 'Internal', `target_kind = 'page'`), filter('external', 'External', `target_kind = 'external'`), filter('no-anchor', 'No anchor text', `COALESCE(anchor, '') = ''`), filter('nofollow', 'Nofollow', 'nofollow = 1'), filter('redirect', 'To a redirect', 'status >= 300 AND status < 400'), filter('broken', 'Broken', 'status >= 400 OR error IS NOT NULL')],
  },
];

const definitionOf = (key: string): ElementDefinition => {
  const definition = ELEMENTS.find((e) => e.key === key);
  if (!definition) throw Object.assign(new Error(`Unknown element: ${key}`), { status: 404 });
  return definition;
};

export interface ElementInfo {
  key: string;
  label: string;
  columns: ElementColumn[];
  filters: { key: string; label: string }[];
}

export function elementCatalog(): ElementInfo[] {
  return ELEMENTS.map(({ key, label, columns, filters }) => ({ key, label, columns, filters: filters.map((f) => ({ key: f.key, label: f.label })) }));
}

/** Counts every filter of one element in a single pass over its rows. */
export function elementCounts(db: Db, key: string): Record<string, number> {
  const { source, filters } = definitionOf(key);
  const sums = filters.map((f, i) => `COALESCE(SUM(CASE WHEN ${f.where || '1'} THEN 1 ELSE 0 END), 0) AS c${i}`).join(', ');
  const row = db.prepare(`SELECT ${sums} FROM (${source}) x`).get() as Record<string, number>;
  return Object.fromEntries(filters.map((f, i) => [f.key, row[`c${i}`]]));
}

export interface ElementQuery {
  filter?: string;
  search?: string;
  sort?: string;
  desc?: boolean;
  limit?: number;
  offset?: number;
}

type ElementRow = Record<string, unknown>;

function elementClause({ search: searchable, filters }: ElementDefinition, query: ElementQuery): { clause: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  const chosen = filters.find((f) => f.key === query.filter);
  if (chosen?.where) where.push(`(${chosen.where})`);
  if (query.search) {
    where.push(`(${searchable.map((name) => `${name} LIKE ?`).join(' OR ')})`);
    params.push(...searchable.map(() => `%${query.search}%`));
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

function elementOrder({ columns }: ElementDefinition, query: ElementQuery): string {
  const sort = columns.some((c) => c.key === query.sort) ? query.sort : 'id';
  return `ORDER BY ${sort} ${query.desc ? 'DESC' : 'ASC'} NULLS LAST, id`;
}

export function listElement(db: Db, key: string, query: ElementQuery = {}): Page<ElementRow> {
  const definition = definitionOf(key);
  const { clause, params } = elementClause(definition, query);
  const limit = Math.min(query.limit ?? 100, 1000);
  const offset = query.offset ?? 0;
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM (${definition.source}) x ${clause}`).get(...params) as { n: number };
  const items = db.prepare(`SELECT * FROM (${definition.source}) x ${clause} ${elementOrder(definition, query)} LIMIT ? OFFSET ?`).all(...params, limit, offset) as ElementRow[];
  return { total: n, offset, limit, items };
}

export function elementCsv(db: Db, key: string, query: ElementQuery = {}): string {
  const definition = definitionOf(key);
  const { clause, params } = elementClause(definition, query);
  const lines = [definition.columns.map((c) => csvCell(c.label)).join(',')];
  for (const row of db.prepare(`SELECT * FROM (${definition.source}) x ${clause} ${elementOrder(definition, query)}`).iterate(...params) as Iterable<ElementRow>) {
    lines.push(definition.columns.map((c) => csvCell(row[c.key])).join(','));
  }
  return `${lines.join('\n')}\n`;
}
