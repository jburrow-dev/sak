# SAK

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

Defaults: 2 requests per second per host, robots.txt respected, sitemaps read, external links and images checked, 10,000 internal URLs. Run `sak` for all options. Ctrl-C pauses a crawl, and `sak resume <id>` continues it.

## Claude (MCP)

```bash
claude mcp add sak -- node /Users/jamesburrow/SAK/apps/mcp/src/main.ts
```

## Integrations

Credentials are stored in the macOS Keychain.

| Service | Setup | Then |
|---|---|---|
| DataForSEO | `sak key set dataforseo`, entering `login:password` | `sak kw`, `sak backlinks`, `sak rank`, `sak cost` |
| PageSpeed Insights | Optional: `sak key set pagespeed` | `sak psi <id>` |
| Search Console, GA4 | Create a Desktop OAuth client in Google Cloud and enable both APIs, then `sak key set google-client` (entering `client_id:client_secret`) and `sak google login` | `sak gsc <id> --property sc-domain:example.com`, `sak ga4 <id> --property 123456789` |

DataForSEO calls are cached for good and only re-fetched with `--refresh`. A call that would cost money shows an estimate and stops until you pass `--yes`.

Google refresh tokens expire after 7 days while the OAuth app is in testing mode.

## Limits of this version

- No JavaScript rendering. Pages that appear to need it get a `js_dependent` warning, so check those with another tool.
- No custom extraction, near-duplicate detection, spelling or accessibility checks.
- CSS and scripts aren't crawled, so a broken stylesheet or script won't be reported.
- Structured data checks cover JSON-LD syntax and core properties, not Google's rich-result rules.
- Pixel widths are estimates based on Arial metrics.

## Development

```bash
npm test
npm run typecheck
```

`packages/core/test/fixture-site.ts` is a local site with known faults. To compare SAK with Screaming Frog on any site, crawl it with both, export Internal > All from Screaming Frog as NDJSON, and run:

```bash
node scripts/compare-sf.ts <crawl-id> <export.ndjson>
```

Expected differences from Screaming Frog's defaults:
- SAK reads sitemaps, so it finds orphan pages. Screaming Frog doesn't unless configured to.
- Screaming Frog crawls scripts and CSS as URLs. SAK doesn't.
- SAK detects exact duplicates from visible text, and Screaming Frog from the full HTML, so SAK also flags identical pages with different canonicals.
- SAK reports likely JS pages as `js_dependent`, not as low content.
- Word counts are usually within 5% of Screaming Frog's, not identical. Both leave out nav and footer, but they split words differently.
