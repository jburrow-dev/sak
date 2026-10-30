#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  compareCrawls, crawlOverview, exportCsv, isInternal, issuesSummary, listCrawls, listIssues, listUrls, newCrawlId, normalizeUrl, openCrawlDb, resumeCrawl, sakHome, startCrawl, urlInfo, urlLinks, withCrawl,
  type CrawlConfig,
} from '@sak/core';
import { dataForSeoTools } from './paid.ts';

const server = new McpServer({ name: 'sak', version: '0.1.0' }, {
  instructions: 'SAK crawls websites locally and audits technical SEO. Start with crawl_start, poll crawl_status, then read issues_summary before drilling into issues_list. Lists are paginated. Tools marked paid cost money: call them without confirm first to see the estimate, and only confirm when the user has agreed.',
});

const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const failure = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

const running = new Map<string, { controller: AbortController; error?: string }>();

function launch(id: string, run: (signal: AbortSignal) => Promise<string>) {
  const controller = new AbortController();
  const entry: { controller: AbortController; error?: string } = { controller };
  running.set(id, entry);
  run(controller.signal).catch((error) => { entry.error = String(error); }).finally(() => {
    if (!entry.error) running.delete(id);
  });
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
    crawl_subdomains: z.boolean().optional().describe('Treat subdomains of the start host as part of the site'),
    seeds: z.array(z.string()).optional().describe('Extra in-scope start URLs, for sections nothing links to'),
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
  const id = newCrawlId(startUrl);
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
  return json({ ...withCrawl(id, (db) => crawlOverview(db, id)), running_in_this_server: Boolean(entry) });
});

server.registerTool('crawl_list', { description: 'All saved crawls, newest first.' }, async () => json(listCrawls()));

server.registerTool('issues_summary', {
  description: 'Issue counts by type with severity and suggested fix. Read this before issues_list.',
  inputSchema: { id: z.string() },
}, async ({ id }) => json(withCrawl(id, (db) => issuesSummary(db))));

server.registerTool('issues_list', {
  description: 'Individual issues, filterable by type, severity or URL.',
  inputSchema: { id: z.string(), type: z.string().optional(), severity: z.enum(['error', 'warning', 'notice']).optional(), url: z.string().optional(), ...paging },
}, async ({ id, ...filter }) => json(withCrawl(id, (db) => listIssues(db, filter))));

server.registerTool('urls_list', {
  description: 'Crawled URLs with status, indexability, title and metrics.',
  inputSchema: {
    id: z.string(),
    kind: z.enum(['page', 'external', 'image']).optional(),
    status: z.number().int().optional(),
    indexable: z.boolean().optional(),
    search: z.string().optional().describe('Substring of the URL or title'),
    sort: z.enum(['url', 'status', 'depth', 'title', 'word_count', 'inlinks', 'issue_count', 'response_ms', 'clicks', 'impressions', 'sessions']).optional(),
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
