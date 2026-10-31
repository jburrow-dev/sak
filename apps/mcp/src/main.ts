#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  compareCrawls, crawlOverview, createCrawlDb, elementCatalog, elementCounts, exportCsv, isInternal, issuesSummary, getMeta, listCrawls, listElement, listIssues, listUrls, newCrawlId, normalizeUrl, openCrawlDb, resumeCrawl, sakHome, startCrawl, trafficPulls, urlInfo, urlLinks, withCrawl,
  type CrawlConfig,
} from '@sak/core';
import { KeychainStore, emptyTrafficPlan, parseTrafficPlan, readTrafficPlan, resolveTrafficPlan, runSavedTrafficPlan, saveTrafficPlan, type TrafficPlan } from '@sak/integrations';
import { dataForSeoTools } from './paid.ts';

const server = new McpServer({ name: 'sak', version: '0.1.0' }, {
  instructions: 'SAK crawls websites locally and audits technical SEO. Start with crawl_start, poll crawl_status, then read issues_summary before drilling into issues_list. Lists are paginated. Tools marked paid cost money: call them without confirm first to see the estimate, and only confirm when the user has agreed. To add free Search Console, GA4 or Bing data, use connections_list and properties_list, then pass traffic to crawl_start, or use traffic_refresh on a finished crawl. Only the user can sign in or add keys.',
});

const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const failure = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

const running = new Map<string, { controller: AbortController; error?: string }>();

function launch(id: string, run: (signal: AbortSignal) => Promise<string>) {
  const controller = new AbortController();
  const entry: { controller: AbortController; error?: string } = { controller };
  running.set(id, entry);
  run(controller.signal).then(() => runTrafficStep(id)).catch((error) => { entry.error = String(error); }).finally(() => {
    if (!entry.error) running.delete(id);
  });
}

async function runTrafficStep(id: string) {
  const db = openCrawlDb(id);
  try {
    await runSavedTrafficPlan(db, new KeychainStore());
  } finally {
    db.close();
  }
}

const trafficField = z.object({
  days: z.union([z.literal(30), z.literal(60), z.literal(90)]).describe('Date range'),
  gsc: z.object({
    account: z.string().optional(),
    property: z.string().describe('For example sc-domain:example.com'),
    top_queries: z.boolean().optional().describe('Also keep the top 10 queries per page. Slower on large sites.'),
    inspect: z.number().int().min(1).max(2000).optional().describe('How many URLs to check with URL Inspection. Google allows 2,000 a day per property.'),
  }).optional(),
  ga4: z.object({ account: z.string().optional(), property: z.string().describe('Numeric GA4 property id') }).optional(),
  bing: z.object({ account: z.string().optional().describe('Name of the Bing key'), site: z.string() }).optional(),
});

/** Fails before anything runs if a property is missing or an account isn't connected. */
async function trafficPlan(input: z.infer<typeof trafficField>): Promise<TrafficPlan | null> {
  const plan = parseTrafficPlan({
    days: input.days,
    gsc: input.gsc && { account: input.gsc.account, property: input.gsc.property, topQueries: input.gsc.top_queries, ...(input.gsc.inspect ? { inspect: { limit: input.gsc.inspect } } : {}) },
    ga4: input.ga4,
    bing: input.bing,
  });
  return emptyTrafficPlan(plan) ? null : resolveTrafficPlan(new KeychainStore(), plan);
}

const paging = {
  limit: z.number().int().min(1).max(1000).optional().describe('Rows to return (default 50)'),
  offset: z.number().int().min(0).optional(),
};

server.registerTool('crawl_start', {
  description: 'Start crawling a site in the background. Returns a crawl id immediately. Poll crawl_status for progress.',
  inputSchema: {
    url: z.string().describe('Start URL'),
    max_urls: z.number().int().min(1).optional().describe('Internal URL budget (default 10000)'),
    max_depth: z.number().int().min(0).optional(),
    requests_per_second: z.number().positive().max(20).optional().describe('Per-host rate limit (default 2)'),
    include: z.array(z.string()).optional().describe('Regex patterns a URL must match'),
    exclude: z.array(z.string()).optional().describe('Regex patterns that exclude a URL'),
    user_agent: z.string().optional(),
    ignore_robots: z.boolean().optional().describe('Only when the user has confirmed they control the site or have permission'),
    use_sitemaps: z.boolean().optional(),
    check_external: z.boolean().optional(),
    check_images: z.boolean().optional(),
    check_resources: z.boolean().optional().describe('Fetch linked CSS and scripts (default true)'),
    render_js: z.boolean().optional().describe('Render pages in Chrome. Slower, and needed for sites built with JavaScript.'),
    crawl_subdomains: z.boolean().optional().describe('Treat subdomains of the start host as part of the site'),
    seeds: z.array(z.string()).optional().describe('Extra in-scope start URLs, for sections nothing links to'),
    traffic: trafficField.optional().describe('Free Search Console, GA4 and Bing data to collect once the crawl finishes'),
  },
}, async (args) => {
  const startUrl = normalizeUrl(args.url);
  if (!startUrl) return failure(`Not a valid http(s) URL: ${args.url}`);
  const config: Partial<CrawlConfig> & { startUrl: string } = { startUrl };
  if (args.max_urls !== undefined) config.maxUrls = args.max_urls;
  if (args.max_depth !== undefined) config.maxDepth = args.max_depth;
  if (args.requests_per_second !== undefined) config.requestsPerSecond = args.requests_per_second;
  if (args.include) config.include = args.include;
  if (args.exclude) config.exclude = args.exclude;
  if (args.user_agent) config.userAgent = args.user_agent;
  if (args.ignore_robots) config.robotsMode = 'ignore';
  if (args.use_sitemaps !== undefined) config.useSitemaps = args.use_sitemaps;
  if (args.check_external !== undefined) config.checkExternal = args.check_external;
  if (args.check_images !== undefined) config.checkImages = args.check_images;
  if (args.check_resources !== undefined) config.checkResources = args.check_resources;
  if (args.render_js !== undefined) config.renderJs = args.render_js;
  if (args.crawl_subdomains !== undefined) config.crawlSubdomains = args.crawl_subdomains;
  if (args.seeds) {
    for (const seed of args.seeds) {
      const url = normalizeUrl(seed);
      if (!url) return failure(`Not a valid http(s) URL: ${seed}`);
      if (!isInternal(url, startUrl, args.crawl_subdomains ?? false)) return failure(`Seed ${url} is outside this crawl. Start from a parent domain and set crawl_subdomains.`);
    }
    config.seeds = args.seeds;
  }
  try {
    for (const pattern of [...(args.include ?? []), ...(args.exclude ?? [])]) new RegExp(pattern);
  } catch (error) {
    return failure(`Invalid regex: ${(error as Error).message}`);
  }
  let traffic: TrafficPlan | null = null;
  try {
    traffic = args.traffic ? await trafficPlan(args.traffic) : null;
  } catch (error) {
    return failure((error as Error).message);
  }
  const id = newCrawlId(startUrl);
  if (traffic) {
    const db = createCrawlDb(id);
    saveTrafficPlan(db, traffic);
    db.close();
  }
  launch(id, (signal) => startCrawl(config, { signal }, id));
  return json({ id, status: 'started' });
});

server.registerTool('crawl_resume', {
  description: 'Continue a paused or interrupted crawl in the background.',
  inputSchema: { id: z.string() },
}, async ({ id }) => {
  if (running.has(id) && !running.get(id)!.error) return failure(`Crawl ${id} is already running`);
  launch(id, (signal) => resumeCrawl(id, { signal }));
  return json({ id, status: 'resumed' });
});

server.registerTool('crawl_pause', {
  description: 'Stop a running crawl after in-flight requests finish. It can be continued with crawl_resume.',
  inputSchema: { id: z.string() },
}, async ({ id }) => {
  const entry = running.get(id);
  if (!entry) return failure(`Crawl ${id} is not running in this server`);
  entry.controller.abort();
  return json({ id, status: 'pausing' });
});

server.registerTool('crawl_status', {
  description: 'Progress and totals for one crawl.',
  inputSchema: { id: z.string() },
}, async ({ id }) => {
  const entry = running.get(id);
  if (entry?.error) return failure(`Crawl failed: ${entry.error}`);
  return json({ ...withCrawl(id, (db) => ({ ...crawlOverview(db, id), traffic: trafficPulls(db) })), running_in_this_server: Boolean(entry) });
});

server.registerTool('traffic_refresh', {
  description: 'Pull Search Console, GA4 and Bing data for a finished crawl in the background, without crawling again. Poll crawl_status and read its traffic field. Leave traffic out to repeat the saved sources.',
  inputSchema: { id: z.string(), traffic: trafficField.optional() },
}, async ({ id, traffic }) => {
  const entry = running.get(id);
  if (entry && !entry.error) return failure(`Crawl ${id} is still working`);
  try {
    const db = openCrawlDb(id);
    try {
      if (getMeta(db, 'status') !== 'finished') return failure('Search and analytics data can only be added to a finished crawl.');
      const plan = traffic ? await trafficPlan(traffic) : readTrafficPlan(db);
      if (!plan) return failure('This crawl has no saved sources, so pass traffic.');
      saveTrafficPlan(db, plan);
    } finally {
      db.close();
    }
  } catch (error) {
    return failure((error as Error).message);
  }
  launch(id, async () => id);
  return json({ id, status: 'pulling' });
});

server.registerTool('crawl_list', { description: 'All saved crawls, newest first.' }, async () => json(listCrawls()));

server.registerTool('issues_summary', {
  description: 'Issue counts by type with severity and suggested fix. Read this before issues_list.',
  inputSchema: { id: z.string() },
}, async ({ id }) => json(withCrawl(id, (db) => issuesSummary(db))));

server.registerTool('issues_list', {
  description: 'Individual issues, filterable by type, severity or URL, and sortable.',
  inputSchema: {
    id: z.string(),
    type: z.string().optional(),
    severity: z.enum(['error', 'warning', 'notice']).optional(),
    url: z.string().optional(),
    search: z.string().optional().describe('Substring of the URL or detail'),
    sort: z.enum(['type', 'severity', 'url', 'detail']).optional(),
    desc: z.boolean().optional(),
    ...paging,
  },
}, async ({ id, ...filter }) => json(withCrawl(id, (db) => listIssues(db, filter))));

server.registerTool('elements_list', {
  description: 'The SEO elements that can be browsed, such as page titles, H1s, canonicals, CSS and scripts, each with its filters and columns. Pass id and element to also get the count for each filter.',
  inputSchema: { id: z.string().optional(), element: z.string().optional() },
}, async ({ id, element }) => {
  if (!id || !element) return json(elementCatalog());
  return json(withCrawl(id, (db) => elementCounts(db, element)));
});

server.registerTool('element_rows', {
  description: 'Rows for one element and filter from elements_list, for example element "title" with filter "duplicate".',
  inputSchema: { id: z.string(), element: z.string(), filter: z.string().optional(), search: z.string().optional(), sort: z.string().optional().describe('A column key from elements_list'), desc: z.boolean().optional(), ...paging },
}, async ({ id, element, ...query }) => {
  try {
    return json(withCrawl(id, (db) => listElement(db, element, { ...query, limit: query.limit ?? 50 })));
  } catch (error) {
    return failure((error as Error).message);
  }
});

server.registerTool('urls_list', {
  description: 'Crawled URLs with status, indexability, title and metrics.',
  inputSchema: {
    id: z.string(),
    kind: z.enum(['page', 'external', 'image', 'css', 'script']).optional(),
    status: z.number().int().optional(),
    indexable: z.boolean().optional(),
    search: z.string().optional().describe('Substring of the URL or title'),
    sort: z.enum(['url', 'status', 'depth', 'title', 'word_count', 'inlinks', 'issue_count', 'response_ms', 'clicks', 'impressions', 'position', 'sessions', 'key_events', 'bing_clicks', 'bing_impressions']).optional(),
    desc: z.boolean().optional(),
    ...paging,
  },
}, async ({ id, ...filter }) => json(withCrawl(id, (db) => listUrls(db, { ...filter, limit: filter.limit ?? 50 }))));

server.registerTool('url_info', {
  description: 'Everything known about one URL: elements, indexability, redirect chain, hreflang, issues, PageSpeed.',
  inputSchema: { id: z.string(), url: z.string() },
}, async ({ id, url }) => {
  const info = withCrawl(id, (db) => urlInfo(db, url));
  return info ? json(info) : failure(`${url} is not in crawl ${id}`);
});

server.registerTool('url_links', {
  description: 'Inlinks or outlinks of one URL.',
  inputSchema: { id: z.string(), url: z.string(), direction: z.enum(['in', 'out']), ...paging },
}, async ({ id, url, direction, ...options }) => json(withCrawl(id, (db) => urlLinks(db, url, direction, options))));

server.registerTool('crawl_compare', {
  description: 'What changed between two crawls: URLs added and removed, field changes, issues added and resolved. Each list is capped at 200 entries, with full counts given.',
  inputSchema: { before: z.string(), after: z.string() },
}, async ({ before, after }) => {
  const a = openCrawlDb(before, { readonly: true });
  const b = openCrawlDb(after, { readonly: true });
  try {
    const diff = compareCrawls(a, b);
    const capped = Object.fromEntries(Object.entries(diff).flatMap(([key, list]) => [[key, (list as unknown[]).slice(0, 200)], [`${key}Total`, (list as unknown[]).length]]));
    return json(capped);
  } finally {
    a.close();
    b.close();
  }
});

const exportsDir = () => {
  const dir = join(sakHome(), 'exports');
  mkdirSync(dir, { recursive: true });
  return dir;
};

server.registerTool('export_csv', {
  description: 'Write a crawl to a CSV file in ~/.sak/exports and return its path.',
  inputSchema: { id: z.string(), kind: z.enum(['urls', 'issues', 'links']) },
}, async ({ id, kind }) => {
  const db = openCrawlDb(id, { readonly: true });
  try {
    const dir = resolve(exportsDir());
    const path = resolve(dir, `${id}-${kind}.csv`);
    if (!path.startsWith(dir + sep)) return failure('Invalid crawl id');
    const rows = await exportCsv(db, kind, path);
    return json({ path, rows });
  } finally {
    db.close();
  }
});

dataForSeoTools(server, json, failure);

await server.connect(new StdioServerTransport());
