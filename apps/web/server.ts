import { execFile } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareCrawls, createCrawlDb, crawlOverview, deleteCrawl, elementCatalog, elementCounts, elementCsv, issuesCsv, issuesSummary, getMeta, listCrawls, listElement, listIssues, listUrls, newCrawlId, openCrawlDb, readSettings, resolveCrawlConfig, resumeCrawl, startCrawl, trafficPulls, urlInfo, urlLinks, urlsCsv, withCrawl, writeSettings,
  type CrawlConfig,
} from '@sak/core';
import {
  ApiCache, DEFAULT_INSPECTIONS, DataForSeo, ESTIMATED_COST, INSPECTIONS_PER_DAY, KeychainStore, TRAFFIC_DAYS, addBingKey, disconnectGoogle, emptyPlan, emptyTrafficPlan, googleAccounts, googleLogin, inspectMore, listAnalyticsProperties, listBingSites, listSearchConsoleProperties, parseTrafficPlan, propertyCovers, readConnections, readPaidData, readTrafficPlan, removeBingKey, resolveBingAccount, resolveGoogleAccount, resolveTrafficPlan, runSavedPaidPlan, runSavedTrafficPlan, savePaidPlan, saveTrafficPlan, suggestProperty,
  type PaidPlan, type PropertyOption, type TrafficPlan, type TrafficSource,
} from '@sak/integrations';

const DIST = join(dirname(fileURLToPath(import.meta.url)), 'dist');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const MAX_BODY_BYTES = 1024 * 1024;

const num = (value: string | null) => (value === null || value === '' ? undefined : Number(value));
const badRequest = (message: string, status = 400) => Object.assign(new Error(message), { status });

class Download {
  body: string;
  filename: string;
  constructor(body: string, filename: string) {
    this.body = body;
    this.filename = filename;
  }
}

const running = new Map<string, AbortController>();

/** Crawls run in this process, so one that is "running" but absent here was interrupted or belongs to the CLI. */
function launch(id: string, run: (signal: AbortSignal) => Promise<string>) {
  const controller = new AbortController();
  running.set(id, controller);
  run(controller.signal)
    .then(() => runPaidStep(id))
    .then(() => runTrafficStep(id))
    .catch((error) => console.error(`Crawl ${id}: ${error}`)) // The crawl records its own failure for the UI.
    .finally(() => running.delete(id));
}

async function runPaidStep(id: string) {
  const db = openCrawlDb(id);
  const cache = new ApiCache();
  try {
    await runSavedPaidPlan(db, new DataForSeo(new KeychainStore(), cache));
  } finally {
    cache.close();
    db.close();
  }
}

async function runTrafficStep(id: string) {
  const db = openCrawlDb(id);
  try {
    await runSavedTrafficPlan(db, new KeychainStore());
  } finally {
    db.close();
  }
}

/** Sign-in runs in the background while the browser is away at Google, and the UI polls for the outcome. */
let googleSignIn: { state: 'pending' | 'done' | 'failed'; account?: string; error?: string; cancel?: AbortController } | null = null;

function startGoogleSignIn() {
  if (googleSignIn?.state === 'pending') throw badRequest('A Google sign-in is already waiting. Finish it or cancel it first.', 409);
  const cancel = new AbortController();
  googleSignIn = { state: 'pending', cancel };
  googleLogin(new KeychainStore(), (url) => execFile('open', [url]), fetch, { signal: cancel.signal }).then(
    (account) => { googleSignIn = { state: 'done', account }; },
    (error) => { googleSignIn = { state: 'failed', error: error.message }; },
  );
  return { state: 'pending' };
}

async function connections() {
  const secrets = new KeychainStore();
  const [client, google, dataforseo, pagespeed] = await Promise.all([secrets.get('google-client'), googleAccounts(secrets), secrets.get('dataforseo'), secrets.get('pagespeed')]);
  return {
    google: { clientConfigured: Boolean(client), accounts: google, signIn: googleSignIn && { state: googleSignIn.state, account: googleSignIn.account, error: googleSignIn.error } },
    bing: { accounts: readConnections().bing },
    other: { dataforseo: Boolean(dataforseo), pagespeed: Boolean(pagespeed) },
    days: TRAFFIC_DAYS,
    inspections: { default: DEFAULT_INSPECTIONS, max: INSPECTIONS_PER_DAY },
  };
}

async function properties(params: URLSearchParams) {
  const source = params.get('source');
  const account = params.get('account') || undefined;
  const secrets = new KeychainStore();
  const load: Record<string, () => Promise<PropertyOption[]>> = {
    gsc: () => listSearchConsoleProperties(secrets, account),
    ga4: () => listAnalyticsProperties(secrets, account),
    bing: () => listBingSites(secrets, account),
  };
  if (!source || !load[source]) throw badRequest('Unknown source');
  const options = await load[source]();
  const url = params.get('url') ?? '';
  const subdomains = params.get('subdomains') === 'true';
  return {
    properties: options.map((option) => ({ ...option, covers: url ? propertyCovers(option.id, url, subdomains) : true })),
    suggested: url ? suggestProperty(source as TrafficSource, options, url, subdomains) : null,
  };
}

async function trafficFromForm(input: unknown): Promise<TrafficPlan | null> {
  if (!input) return null;
  let plan: TrafficPlan;
  try {
    plan = parseTrafficPlan(input);
    if (emptyTrafficPlan(plan)) return null;
    return await resolveTrafficPlan(new KeychainStore(), plan);
  } catch (error) {
    throw badRequest((error as Error).message);
  }
}

async function costs() {
  const secrets = new KeychainStore();
  const cache = new ApiCache();
  try {
    const keys = Object.fromEntries(await Promise.all(['dataforseo', 'pagespeed', 'google-client', 'google-tokens'].map(async (name) => [name, Boolean(await secrets.get(name))])));
    let balance: number | null = null;
    let balanceError: string | null = null;
    // Switched off means SAK doesn't contact DataForSEO at all.
    if (keys.dataforseo && readSettings().paidApis) {
      try {
        balance = await new DataForSeo(secrets, cache).balance();
      } catch (error) {
        balanceError = (error as Error).message;
      }
    }
    return { ...cache.spend(), balance, balanceError, keys };
  } finally {
    cache.close();
  }
}

function strings(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw badRequest(`${name} must be a list of strings`);
  return value.map((item: string) => item.trim()).filter(Boolean);
}

function positiveNumber(value: unknown, name: string, max: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > max) throw badRequest(`${name} must be between 0 and ${max}`);
  return parsed;
}

async function startFromForm(body: any) {
  if (typeof body?.url !== 'string') throw badRequest('A start URL is required');
  const input: Partial<CrawlConfig> & { startUrl: string } = {
    startUrl: body.url,
    crawlSubdomains: Boolean(body.crawlSubdomains),
    useSitemaps: body.useSitemaps !== false,
    checkExternal: body.checkExternal !== false,
    checkImages: body.checkImages !== false,
    checkResources: body.checkResources !== false,
    renderJs: Boolean(body.renderJs),
    seeds: strings(body.seeds, 'Seeds'),
    include: strings(body.include, 'Include patterns'),
    exclude: strings(body.exclude, 'Exclude patterns'),
  };
  const maxUrls = positiveNumber(body.maxUrls, 'Maximum URLs', 1_000_000);
  if (maxUrls) input.maxUrls = maxUrls;
  const rate = positiveNumber(body.requestsPerSecond, 'Requests per second', 20);
  if (rate) input.requestsPerSecond = rate;

  let config: CrawlConfig;
  try {
    config = resolveCrawlConfig(input);
  } catch (error) {
    throw badRequest((error as Error).message);
  }

  const plan: PaidPlan | null = body.paid ? {
    backlinks: Boolean(body.paid.backlinks),
    volume: Boolean(body.paid.volume),
    rank: Boolean(body.paid.rank),
    keywords: strings(body.paid.keywords, 'Keywords'),
  } : null;
  const spends = plan !== null && !emptyPlan(plan);
  if (spends && !readSettings().paidApis) throw badRequest('Paid APIs are switched off, so this crawl cannot collect paid data.', 409);
  if (spends && body.confirmed !== true) throw badRequest('Agree to the estimated cost before starting this crawl.');
  const traffic = await trafficFromForm(body.traffic);

  const id = newCrawlId(config.startUrl);
  const db = createCrawlDb(id);
  try {
    if (spends) savePaidPlan(db, plan);
    if (traffic) saveTrafficPlan(db, traffic);
  } finally {
    db.close();
  }
  launch(id, (signal) => startCrawl(config, { signal }, id));
  return { id };
}

async function handlePost(path: string, body: any): Promise<unknown> {
  if (path === '/api/settings') {
    if (typeof body?.paidApis !== 'boolean') throw badRequest('paidApis must be true or false');
    return writeSettings({ paidApis: body.paidApis });
  }
  if (path === '/api/crawls') return startFromForm(body);
  if (path === '/api/connections/google/client') {
    const id = typeof body?.clientId === 'string' ? body.clientId.trim() : '';
    const secret = typeof body?.clientSecret === 'string' ? body.clientSecret.trim() : '';
    if (!id || !secret) throw badRequest('Enter both the client ID and the client secret');
    await new KeychainStore().set('google-client', `${id}:${secret}`);
    return connections();
  }
  if (path === '/api/connections/google/login') return startGoogleSignIn();
  if (path === '/api/connections/google/login/cancel') {
    googleSignIn?.cancel?.abort();
    return connections();
  }
  if (path === '/api/connections/bing/key') {
    try {
      return await addBingKey(new KeychainStore(), String(body?.label ?? ''), String(body?.key ?? ''));
    } catch (error) {
      throw badRequest((error as Error).message);
    }
  }
  const disconnect = path.match(/^\/api\/connections\/(google|bing)\/([^/]+)\/disconnect$/);
  if (disconnect) {
    const account = decodeURIComponent(disconnect[2]);
    if (disconnect[1] === 'google') await disconnectGoogle(new KeychainStore(), await resolveGoogleAccount(new KeychainStore(), account));
    else await removeBingKey(new KeychainStore(), resolveBingAccount(account));
    return connections();
  }
  const match = path.match(/^\/api\/crawls\/([\w.-]+)\/(pause|resume|traffic|inspect|delete)$/);
  if (!match) throw badRequest('Not found', 404);
  const [, id, action] = match;
  if (action === 'delete') {
    if (running.has(id)) throw badRequest('Pause this crawl before deleting it.', 409);
    // Could be interrupted, or still going in the CLI, and this process can't tell which.
    if (withCrawl(id, (db) => getMeta(db, 'status')) === 'running') throw badRequest('This crawl may still be running in another window. If it was interrupted, resume it here and pause it, then delete it.', 409);
    deleteCrawl(id);
    return { id, status: 'deleted' };
  }
  if (action === 'traffic' || action === 'inspect') {
    if (running.has(id)) throw badRequest('This crawl is still working. Wait for it to finish.', 409);
    if (withCrawl(id, (db) => getMeta(db, 'status')) !== 'finished') throw badRequest('Search and analytics data can only be added to a finished crawl.', 409);
    if (action === 'traffic') {
      const plan = await trafficFromForm(body?.traffic);
      if (!plan) throw badRequest('Choose at least one source');
      const db = openCrawlDb(id);
      try {
        saveTrafficPlan(db, plan);
      } finally {
        db.close();
      }
      launch(id, async () => id);
      return { id, status: 'pulling' };
    }
    const limit = Number(body?.limit ?? DEFAULT_INSPECTIONS);
    if (!Number.isInteger(limit) || limit < 1 || limit > INSPECTIONS_PER_DAY) throw badRequest(`Choose 1 to ${INSPECTIONS_PER_DAY} URLs`);
    launch(id, async () => {
      const db = openCrawlDb(id);
      try {
        await inspectMore(db, new KeychainStore(), limit);
      } finally {
        db.close();
      }
      return id;
    });
    return { id, status: 'inspecting' };
  }
  if (action === 'pause') {
    const controller = running.get(id);
    if (!controller) throw badRequest('This crawl is not running in this window', 409);
    controller.abort();
    return { id, status: 'pausing' };
  }
  if (running.has(id)) throw badRequest('This crawl is already running', 409);
  withCrawl(id, () => null); // Reports a missing crawl before going to the background.
  launch(id, (signal) => resumeCrawl(id, { signal }));
  return { id, status: 'resumed' };
}

async function handleApi(path: string, params: URLSearchParams): Promise<unknown> {
  if (path === '/api/crawls') return listCrawls().map((crawl) => ({ ...crawl, running: running.has(crawl.id) }));
  if (path === '/api/costs') return costs();
  if (path === '/api/settings') return { ...readSettings(), prices: ESTIMATED_COST };
  if (path === '/api/elements') return elementCatalog();
  if (path === '/api/connections') return connections();
  if (path === '/api/properties') return properties(params);
  if (path === '/api/compare') {
    const before = openCrawlDb(params.get('before') ?? '', { readonly: true });
    const after = openCrawlDb(params.get('after') ?? '', { readonly: true });
    try {
      return compareCrawls(before, after);
    } finally {
      before.close();
      after.close();
    }
  }
  const paging = { limit: num(params.get('limit')), offset: num(params.get('offset')) };
  const sorting = { search: params.get('search') ?? undefined, sort: params.get('sort') ?? undefined, desc: params.get('desc') === 'true' };

  const element = path.match(/^\/api\/crawls\/([\w.-]+)\/elements\/([\w-]+?)(\.csv)?$/);
  if (element) {
    const [, id, key, csv] = element;
    const query = { filter: params.get('filter') ?? undefined, ...sorting };
    return withCrawl(id, (db) => (csv
      ? new Download(elementCsv(db, key, query), `${id}-${key}-${query.filter ?? 'all'}.csv`)
      : { counts: elementCounts(db, key), page: listElement(db, key, { ...query, ...paging }) }));
  }

  const urlFilter = () => ({
    kind: params.get('kind') ?? undefined,
    status: num(params.get('status')),
    indexable: params.has('indexable') ? params.get('indexable') === 'true' : undefined,
    ...sorting,
  });
  const issueFilter = () => ({ type: params.get('type') ?? undefined, severity: params.get('severity') ?? undefined, ...sorting });

  const csv = path.match(/^\/api\/crawls\/([\w.-]+)\/(issues|urls)\.csv$/);
  if (csv) {
    const [, id, kind] = csv;
    return withCrawl(id, (db) => new Download(kind === 'issues' ? issuesCsv(db, issueFilter()) : urlsCsv(db, urlFilter()), `${id}-${kind}.csv`));
  }

  const match = path.match(/^\/api\/crawls\/([\w.-]+)(?:\/(issues|urls|url|links|paid|traffic|config))?$/);
  if (!match) throw badRequest('Not found', 404);
  const [, id, section] = match;
  return withCrawl(id, (db) => {
    switch (section) {
      case 'issues':
        return listIssues(db, { ...issueFilter(), ...paging });
      case 'urls':
        return listUrls(db, { ...urlFilter(), ...paging });
      case 'url':
        return urlInfo(db, params.get('url') ?? '');
      case 'links':
        return urlLinks(db, params.get('url') ?? '', params.get('direction') === 'out' ? 'out' : 'in', paging);
      case 'paid':
        return readPaidData(db);
      case 'traffic':
        return { pulls: trafficPulls(db), plan: readTrafficPlan(db), subdomains: Boolean((JSON.parse(getMeta(db, 'config') ?? '{}') as Partial<CrawlConfig>).crawlSubdomains) };
      case 'config':
        return { config: JSON.parse(getMeta(db, 'config') ?? '{}') as Partial<CrawlConfig>, traffic: readTrafficPlan(db) };
      default:
        return { overview: { ...crawlOverview(db, id), running: running.has(id) }, summary: issuesSummary(db) };
    }
  });
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(badRequest('Request is too large', 413));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(badRequest('Request body must be JSON'));
      }
    });
  });
}

/** Stops other web pages from starting crawls or changing settings through the user's browser. */
function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin || !/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function startUiServer(port = 4600): Promise<{ server: Server; url: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      // Refuses other hostnames so a malicious web page can't reach this server through DNS rebinding.
      const host = (req.headers.host ?? '').split(':')[0];
      if (host !== '127.0.0.1' && host !== 'localhost') {
        res.writeHead(403).end();
        return;
      }
      const respond = (work: Promise<unknown>) => work.then(
        (data) => {
          if (data instanceof Download) {
            res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${data.filename}"` });
            res.end(data.body);
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(data));
        },
        (error) => {
          res.writeHead(error.status ?? 500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        },
      );
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        if (!isSameOrigin(req)) {
          res.writeHead(403).end();
          return;
        }
        respond(readJson(req).then((body) => handlePost(url.pathname, body)));
        return;
      }
      if (req.method !== 'GET') {
        res.writeHead(405).end();
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        respond(handleApi(url.pathname, url.searchParams));
        return;
      }
      const relative = normalize(url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      const file = join(DIST, relative);
      const servable = file.startsWith(DIST + sep) && existsSync(file) && statSync(file).isFile();
      const target = servable ? file : join(DIST, 'index.html');
      if (!existsSync(target)) {
        res.writeHead(503, { 'content-type': 'text/plain' }).end('The UI has not been built. Run: npm run build:web');
        return;
      }
      res.writeHead(200, { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream' });
      createReadStream(target).pipe(res);
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}
