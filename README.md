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

`sak ui` can also start, pause and resume crawls, and connect Google and Bing. Its Elements tab browses pages by SEO element, with filters such as duplicate titles or missing H1s, and exports any view to CSV.

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
| Search Console, GA4 | See [Search and analytics data](#search-and-analytics-data) | `sak crawl <url> --gsc sc-domain:example.com --ga4 123456789`, `sak traffic <id>` |
| Bing Webmaster Tools | `sak bing key add --label NAME`, or the UI's Connections screen | `sak crawl <url> --bing https://www.example.com/` |

DataForSEO calls are cached for good and only re-fetched with `--refresh`. A call that would cost money shows an estimate and stops until you pass `--yes`.

A crawl on its own never spends. To store paid data with a crawl, turn it on in the New crawl form, or add `--backlinks`, or `--keywords "a,b"` with `--volume` and `--rank`, plus `--yes`. It runs once the crawl finishes.

`sak paid off`, or the switch in the UI's Costs tab, stops all DataForSEO calls from the CLI, the UI and Claude. Cached results still work.

### Search and analytics data

These services are free to call, so the spending switch doesn't affect them. Turn each one on per crawl in the New crawl form, and choose 30, 60 or 90 days. SAK collects the data once the crawl finishes, so a paused crawl collects it after you resume. If a source fails, the crawl and the other sources are unaffected.

**Google setup**, once per install:

1. In a Google Cloud project, enable the Search Console API, Google Analytics Data API and Google Analytics Admin API.
2. Create an OAuth client of type Desktop app.
3. Set the OAuth consent screen to In production. In Testing mode, sign-ins expire after 7 days. Google shows an "unverified app" warning at sign-in, because this is your own client.
4. Save the client in the UI's Connections screen, or with `sak key set google-client`, entering `client_id:client_secret`.
5. Sign in from the Connections screen, or with `sak google login`. Repeat for each Google account.

Without the Admin API, SAK can't list GA4 properties, but you can still type a numeric property ID.

**Bing setup:** create a key in Bing Webmaster Tools under Settings, then API Access, and add it in the Connections screen or with `sak bing key add --label NAME`. Add one key per Bing login. Bing OAuth isn't supported yet.

**To add or change data on a finished crawl**, use the UI's coverage table above the tabs, or:

```bash
sak traffic <crawl-id> --days 60
sak traffic <crawl-id> --gsc sc-domain:example.com --top-queries
sak inspect <crawl-id> --limit 500
```

**What you get:**

- Metrics in the URLs table, URL details, CSV exports and the Elements tab. Rows are matched to crawled URLs across `http`/`https`, `www` and trailing slashes, unless a URL could mean two different crawled pages.
- **Not in crawl**, an Elements view of URLs with data that the crawl never reached. Crawl limits and exclude rules can also put pages here.
- **Top queries**, optional: the top 10 per page, from up to 200,000 rows. Google leaves out rare queries, so these won't add up to page totals.
- **URL Inspection**, optional: Google's index status per URL. Google allows 2,000 a day per property, so SAK counts them and picks up where it stopped.
- Traffic-based issues, such as non-indexable pages getting traffic. These only run for sources that were actually pulled.

**Date ranges:** Search Console and GA4 cover exactly the days chosen, ending two days ago, because their data arrives late. Bing's API takes no date range and updates weekly. SAK narrows Bing's data using the dates on its rows when it can. Otherwise it stores what Bing reports and labels it as Bing's own period. Bing positions are stored as Bing reports them.

## Limits of this version

- JavaScript rendering is off by default, and needs Google Chrome. Without it, pages that appear to need it get a `js_dependent` warning.
- Requests a page makes while rendering aren't counted by the rate limit or checked against robots.txt.
- Bing query data per page isn't collected, because it needs one request per URL. Traffic isn't included in `sak compare`. The UI's date ranges are presets only.
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
