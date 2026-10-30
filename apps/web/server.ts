import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareCrawls, crawlOverview, issuesSummary, listCrawls, listIssues, listUrls, openCrawlDb, urlInfo, urlLinks, withCrawl } from '@sak/core';
import { ApiCache, DataForSeo, KeychainStore } from '@sak/integrations';

const DIST = join(dirname(fileURLToPath(import.meta.url)), 'dist');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const num = (value: string | null) => (value === null || value === '' ? undefined : Number(value));

async function costs() {
  const secrets = new KeychainStore();
  const cache = new ApiCache();
  try {
    const keys = Object.fromEntries(await Promise.all(['dataforseo', 'pagespeed', 'google-client', 'google-tokens'].map(async (name) => [name, Boolean(await secrets.get(name))])));
    let balance: number | null = null;
    let balanceError: string | null = null;
    if (keys.dataforseo) {
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

async function handleApi(path: string, params: URLSearchParams): Promise<unknown> {
  if (path === '/api/crawls') return listCrawls();
  if (path === '/api/costs') return costs();
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
  const match = path.match(/^\/api\/crawls\/([\w.-]+)(?:\/(issues|urls|url|links))?$/);
  if (!match) throw Object.assign(new Error('Not found'), { status: 404 });
  const [, id, section] = match;
  return withCrawl(id, (db) => {
    const paging = { limit: num(params.get('limit')), offset: num(params.get('offset')) };
    switch (section) {
      case 'issues':
        return listIssues(db, { type: params.get('type') ?? undefined, severity: params.get('severity') ?? undefined, ...paging });
      case 'urls':
        return listUrls(db, {
          kind: params.get('kind') ?? undefined,
          status: num(params.get('status')),
          indexable: params.has('indexable') ? params.get('indexable') === 'true' : undefined,
          search: params.get('search') ?? undefined,
          sort: params.get('sort') ?? undefined,
          desc: params.get('desc') === 'true',
          ...paging,
        });
      case 'url':
        return urlInfo(db, params.get('url') ?? '');
      case 'links':
        return urlLinks(db, params.get('url') ?? '', params.get('direction') === 'out' ? 'out' : 'in', paging);
      default:
        return { overview: crawlOverview(db, id), summary: issuesSummary(db) };
    }
  });
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
      if (req.method !== 'GET') {
        res.writeHead(405).end();
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        handleApi(url.pathname, url.searchParams).then(
          (data) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(data));
          },
          (error) => {
            res.writeHead(error.status ?? 500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
          },
        );
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
