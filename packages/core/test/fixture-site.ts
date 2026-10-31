import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// A small site with one known fault per page. Run directly to crawl it with another tool:
//   node packages/core/test/fixture-site.ts 4599

const filler = (seed: string) => Array.from({ length: 260 }, (_, i) => `${seed}${i % 17}`).join(' ');

interface PageOptions {
  title?: string | null;
  meta?: string | null;
  h1?: string[];
  head?: string;
  body?: string;
  text?: string;
}

function page(path: string, options: PageOptions = {}): string {
  const title = options.title === undefined ? `Fixture page for ${path} with a good length` : options.title;
  const meta = options.meta === undefined ? `A complete meta description for the page at ${path}, long enough to clear the minimum check.` : options.meta;
  const h1 = (options.h1 ?? [`Heading ${path}`]).map((h) => `<h1>${h}</h1>`).join('');
  return `<!doctype html><html lang="en"><head>
${title === null ? '' : `<title>${title}</title>`}
${meta === null ? '' : `<meta name="description" content="${meta}">`}
${options.head ?? ''}
</head><body>${h1}<p>${options.text ?? filler(path)}</p>${options.body ?? ''}</body></html>`;
}

export function startFixtureSite(port = 0): Promise<{ server: Server; origin: string; externalOrigin: string }> {
  return new Promise((resolve) => {
    let origin = '';
    const canonical = (path: string) => `<link rel="canonical" href="${origin}${path}">`;
    const link = (path: string) => `<a href="${path}">${path}</a>`;

    const server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      const html = (body: string, status = 200, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
        res.end(body);
      };
      const redirect = (to: string, status = 301) => {
        res.writeHead(status, { location: to });
        res.end();
      };

      switch (path) {
        case '/robots.txt':
          res.writeHead(200, { 'content-type': 'text/plain' });
          return res.end(`User-agent: *\nDisallow: /private/\nSitemap: ${origin}/sitemap.xml\n`);
        case '/sitemap.xml':
          res.writeHead(200, { 'content-type': 'application/xml' });
          return res.end(`<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${origin}/sitemap-pages.xml</loc></sitemap></sitemapindex>`);
        case '/sitemap-pages.xml':
          res.writeHead(200, { 'content-type': 'application/xml' });
          return res.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
            ${['/', '/good', '/orphan', '/noindexed', '/missing'].map((p) => `<url><loc>${origin}${p}</loc></url>`).join('')}</urlset>`);
        case '/':
          return html(page('/', {
            head: canonical('/'),
            body: ['/good', '/redirect-one', '/chain-a', '/loop-a', '/missing', '/server-error', '/dup-a', '/dup-b', '/noindexed', '/canon-other', '/canon-bad', '/en', '/fr', '/private/secret', '/spa', '/schema', '/thin', '/no-tags', '/two-titles', '/deep1'].map(link).join('') +
              `<a href="${origin.replace('127.0.0.1', 'localhost')}/ext-ok">ok</a><a href="${origin.replace('127.0.0.1', 'localhost')}/ext-404">gone</a><a href="${origin.replace('127.0.0.1', 'localhost')}/ext-403">refused</a>`,
          }));
        case '/good':
          return html(page(path, { head: `${canonical(path)}<link rel="stylesheet" href="/style.css">`, body: `${link('/')}<img src="/missing.png" alt="gone"><script src="/app.js"></script>` }));
        case '/style.css':
          res.writeHead(200, { 'content-type': 'text/css' });
          return res.end('body { margin: 0 }');
        case '/app.js':
          res.writeHead(200, { 'content-type': 'text/javascript' });
          return res.end('console.log(1)');
        case '/orphan':
          return html(page(path, { head: canonical(path) }));
        case '/redirect-one':
          return redirect('/good');
        case '/chain-a':
          return redirect('/chain-b');
        case '/chain-b':
          return redirect('/chain-c', 302);
        case '/chain-c':
          return redirect('/good');
        case '/loop-a':
          return redirect('/loop-b');
        case '/loop-b':
          return redirect('/loop-a');
        case '/server-error':
          return html('<h1>boom</h1>', 500);
        case '/dup-a':
        case '/dup-b':
          return html(page(path, { title: 'Shared duplicate title for two pages here', meta: 'Shared meta description used by two pages so the duplicate check has something to find.', h1: ['Same'], text: filler('dup'), head: canonical(path) }));
        case '/noindexed':
          return html(page(path, { head: `<meta name="robots" content="noindex">${canonical(path)}` }));
        case '/canon-other':
          return html(page(path, { head: canonical('/good') }));
        case '/canon-bad':
          return html(page(path, { head: canonical('/missing') }));
        case '/en':
          return html(page(path, { head: `${canonical(path)}<link rel="alternate" hreflang="en" href="${origin}/en"><link rel="alternate" hreflang="fr" href="${origin}/fr">` }));
        case '/fr':
          return html(page(path, { head: `${canonical(path)}<link rel="alternate" hreflang="fr" href="${origin}/fr"><link rel="alternate" hreflang="zz_bad" href="${origin}/good">` }));
        case '/private/secret':
          return html(page(path));
        case '/spa':
          return html(page(path, { head: canonical(path), h1: [], text: ' ', body: '<div id="root"></div><script src="/a.js"></script>' }));
        case '/schema':
          return html(page(path, { head: `${canonical(path)}<script type="application/ld+json">{not json}</script><script type="application/ld+json">{"@context":"https://schema.org","@type":"Article"}</script>` }));
        case '/thin':
          return html(page(path, { head: `${canonical(path)}<link rel="stylesheet" href="/gone.css">`, text: 'Too few words here.' }));
        case '/no-tags':
          return html(page(path, { title: null, meta: null, h1: [] }));
        case '/two-titles':
          return html(page(path, { head: `${canonical(path)}<title>A second title element on this page ok</title>`, h1: ['One', 'Two'] }));
        case '/deep1':
          return html(page(path, { head: canonical(path), body: link('/deep2') }));
        case '/deep2':
          return html(page(path, { head: canonical(path), body: link('/deep3') }));
        case '/deep3':
          return html(page(path, { head: canonical(path), body: link('/deep4') }));
        case '/deep4':
          return html(page(path, { head: canonical(path) }));
        case '/ext-ok':
          return html('ok');
        case '/ext-403':
          return html('refused', 403);
        default:
          return html('<h1>Not found</h1>', 404);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      const actual = (server.address() as AddressInfo).port;
      origin = `http://127.0.0.1:${actual}`;
      resolve({ server, origin, externalOrigin: `http://localhost:${actual}` });
    });
  });
}

if (process.argv[1]?.endsWith('fixture-site.ts')) {
  const { origin } = await startFixtureSite(Number(process.argv[2] ?? 4599));
  console.log(`Fixture site running at ${origin}`);
}
