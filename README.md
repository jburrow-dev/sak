# SSAK [Search Swiss Army Knife]

A local SEO crawler and data tool. It runs on your Mac, stores each crawl in its own SQLite file under `~/.sak`, and can be used from the command line, a localhost web UI, or Claude through MCP.

Requires Node 24 or newer, which runs the TypeScript directly.

## Setup

```bash
npm install
npm run build:web
npm link -w apps/cli
```

## Crawling

```bash
sak crawl https://example.com
sak issues <crawl-id>
sak issues <crawl-id> --type status_4xx
sak url <crawl-id> https://example.com/page
sak export <crawl-id> --kind urls --out urls.csv
sak compare <before-id> <after-id>
sak ui
```

To include subdomains, start from the parent domain. Add `--seed` for any section nothing links to:

```bash
sak crawl https://example.com --subdomains --seed https://blog.example.com/
```

Scope is based on the start URL's host, so starting from `blog.example.com` won't cover `example.com`. Without `--subdomains`, `www` and non-`www` count as one site and other subdomains are external. Sitemaps are read for the start URL and each seed, unless `--no-sitemaps` is set.

Defaults: 2 requests per second per host, robots.txt respected, sitemaps read, external links, images, CSS and scripts checked, 10,000 internal URLs. Run `sak` for all options. Ctrl-C pauses a crawl, and `sak resume <id>` continues it.

To render pages in Chrome, so content and links added by JavaScript are seen, add `--render`. It uses your installed Google Chrome with a throwaway profile, and is slower because each page is fetched and then rendered. Common analytics and ad requests are blocked, so crawling doesn't add visits to a site's reports. Results show what changed between the HTML as served and the rendered page.

`sak ui` can also start, pause and resume crawls. Its Elements tab browses pages by SEO element, with filters such as duplicate titles or missing H1s, and exports any view to CSV.

## Claude (MCP)

```bash
claude mcp add sak -- node /path/to/SAK/apps/mcp/src/main.ts
```

## Integrations

Credentials are stored in the macOS Keychain.

| Service | Setup | Then |
|---|---|---|
| DataForSEO | `sak key set dataforseo`, entering `login:password` | `sak kw`, `sak backlinks`, `sak rank`, `sak cost` |
| PageSpeed Insights | Optional: `sak key set pagespeed` | `sak psi <id>` |
| Search Console, GA4 | Create a Desktop OAuth client in Google Cloud and enable both APIs, then `sak key set google-client` (entering `client_id:client_secret`) and `sak google login` | `sak gsc <id> --property sc-domain:example.com`, `sak ga4 <id> --property 123456789` |

DataForSEO calls are cached for good and only re-fetched with `--refresh`. A call that would cost money shows an estimate and stops until you pass `--yes`.

A crawl on its own never spends. To store paid data with a crawl, turn it on in the New crawl form, or add `--backlinks`, or `--keywords "a,b"` with `--volume` and `--rank`, plus `--yes`. It runs once the crawl finishes.

`sak paid off`, or the switch in the UI's Costs tab, stops all DataForSEO calls from the CLI, the UI and Claude. Cached results still work.

Google refresh tokens expire after 7 days while the OAuth app is in testing mode.

## Limits of this version

- JavaScript rendering is off by default, and needs Google Chrome. Without it, pages that appear to need it get a `js_dependent` warning.
- Requests a page makes while rendering aren't counted by the rate limit or checked against robots.txt.
- No custom extraction, near-duplicate detection, spelling or accessibility checks.
- CSS and scripts are fetched and checked, but not parsed, so files they load themselves, such as fonts or `@import`s, aren't found.
- Structured data checks cover JSON-LD syntax and core properties, not Google's rich-result rules.
- Pixel widths are estimates based on Arial metrics.

## Development

```bash
npm test
npm run typecheck
```

`packages/core/test/fixture-site.ts` is a local site with known faults. To compare SSAK with Screaming Frog on any site, crawl it with both, export Internal > All from Screaming Frog as NDJSON, and run:

```bash
node scripts/compare-sf.ts <crawl-id> <export.ndjson>
```

Expected differences from Screaming Frog's defaults:
- SSAK reads sitemaps, so it finds orphan pages. Screaming Frog doesn't unless configured to.
- SSAK lists scripts and CSS separately from internal URLs, so they don't count toward its internal URL total.
- SSAK detects exact duplicates from visible text, and Screaming Frog from the full HTML, so SSAK also flags identical pages with different canonicals.
- SSAK reports likely JS pages as `js_dependent`, not as low content.
- Word counts are usually within 5% of Screaming Frog's, not identical. Both leave out nav and footer, but they split words differently.
