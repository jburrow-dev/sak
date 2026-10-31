#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import {
  compareCrawls, crawlOverview, createCrawlDb, exportCsv, issuesSummary, listCrawls, listIssues, newCrawlId, openCrawlDb, readSettings, resolveCrawlConfig, resumeCrawl, startCrawl, urlInfo, withCrawl,
  type CrawlConfig, type CrawlProgress, type ExportKind,
} from '@sak/core';
import { PaidApisDisabled, emptyPlan, estimatePlan, savePaidPlan, saveTrafficPlan, type PaidPlan } from '@sak/integrations';
import { printPaidData, runIntegrationCommand, runPaidPlan, runTraffic, trafficPlanFromFlags } from './integrations.ts';

const USAGE = `sak: local SEO crawler

Crawling
  sak crawl <url> [--max-urls N] [--max-depth N] [--rate N] [--concurrency N]
                  [--include REGEX]... [--exclude REGEX]... [--user-agent UA] [--header "K: V"]...
                  [--robots respect|ignore] [--robots-file PATH] [--no-sitemaps] [--no-external] [--no-images]
                  [--no-resources] [--render] [--subdomains] [--seed URL]...
                  [--backlinks] [--keywords "a,b" --volume --rank] [--yes]
                  [--gsc PROPERTY] [--ga4 ID] [--bing SITE] [--days 30|60|90] [--account EMAIL] [--bing-key NAME]
                  [--top-queries] [--inspect N]
  sak resume <id>
  sak list

Results
  sak issues <id> [--type TYPE] [--limit N]
  sak url <id> <url>
  sak export <id> --kind urls|issues|links --out PATH
  sak compare <before-id> <after-id>
  sak ui [--port N]

Integrations
  sak key set <dataforseo|pagespeed|google-client>
  sak key status
  sak connections
  sak google login
  sak google logout --account EMAIL
  sak bing key add --label NAME
  sak bing key remove --label NAME
  sak properties <gsc|ga4|bing> [--account NAME] [--url URL]
  sak traffic <id> [--days 30|60|90] [--gsc PROPERTY] [--ga4 ID] [--bing SITE] [--account EMAIL] [--bing-key NAME] [--top-queries] [--inspect N]
  sak inspect <id> [--limit 500]
  sak gsc <id> --property sc-domain:example.com [--days 90] [--account EMAIL]
  sak ga4 <id> --property 123456789 [--days 90] [--account EMAIL]
  sak psi <id> [--strategy mobile|desktop] [--limit 10] [--url URL]...
  sak kw <keyword>... [--location 2840] [--language en] [--refresh] [--yes]
  sak backlinks <domain> [--refresh] [--yes]
  sak rank <domain> <keyword>... [--location 2840] [--language en] [--refresh] [--yes]
  sak cost
  sak paid [on|off]

A crawl can be stopped with Ctrl-C and continued later with sak resume.
--backlinks, --volume and --rank collect paid DataForSEO data once the crawl finishes.
--gsc, --ga4 and --bing collect free search and analytics data once the crawl finishes, over 30 days by default.`;

function progressLine(progress: CrawlProgress) {
  process.stderr.write(`\r\x1b[K${progress.fetched} fetched, ${progress.pending} queued  ${progress.status ?? '---'} ${progress.url.slice(0, 80)}`);
}

function stopOnInterrupt() {
  const controller = new AbortController();
  process.once('SIGINT', () => {
    process.stderr.write('\nStopping after in-flight requests finish...\n');
    controller.abort();
  });
  return controller.signal;
}

function printFinished(id: string) {
  process.stderr.write('\n');
  const { overview, summary } = withCrawl(id, (db) => ({ overview: crawlOverview(db, id), summary: issuesSummary(db) }));
  console.log(`Crawl ${id}: ${overview.status}, ${overview.pages} internal URLs, ${overview.issues} issues`);
  if (overview.status === 'paused') console.log(`Continue with: sak resume ${id}`);
  for (const row of summary) console.log(`${row.severity.padEnd(8)} ${String(row.count).padStart(6)}  ${row.title} (${row.type})`);
}

// A closed pipe, such as `sak list | head -1`, means the reader has what it wants.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      'max-urls': { type: 'string' }, 'max-depth': { type: 'string' }, rate: { type: 'string' }, concurrency: { type: 'string' },
      include: { type: 'string', multiple: true }, exclude: { type: 'string', multiple: true },
      'user-agent': { type: 'string' }, header: { type: 'string', multiple: true },
      robots: { type: 'string' }, 'robots-file': { type: 'string' },
      'no-sitemaps': { type: 'boolean' }, 'no-external': { type: 'boolean' }, 'no-images': { type: 'boolean' }, 'no-resources': { type: 'boolean' }, render: { type: 'boolean' }, subdomains: { type: 'boolean' }, seed: { type: 'string', multiple: true },
      backlinks: { type: 'boolean' }, keywords: { type: 'string' }, volume: { type: 'boolean' }, rank: { type: 'boolean' },
      type: { type: 'string' }, limit: { type: 'string' }, kind: { type: 'string' }, out: { type: 'string' }, port: { type: 'string' },
      property: { type: 'string' }, days: { type: 'string' }, strategy: { type: 'string' }, url: { type: 'string', multiple: true },
      location: { type: 'string' }, language: { type: 'string' }, refresh: { type: 'boolean' }, yes: { type: 'boolean' },
      gsc: { type: 'string' }, ga4: { type: 'string' }, bing: { type: 'string' }, account: { type: 'string' }, 'bing-key': { type: 'string' }, 'top-queries': { type: 'boolean' }, inspect: { type: 'string' }, label: { type: 'string' },
    },
  });

  switch (command) {
    case 'crawl': {
      const startUrl = positionals[0];
      if (!startUrl) throw new Error('Usage: sak crawl <url>');
      const config: Partial<CrawlConfig> & { startUrl: string } = { startUrl };
      if (values['max-urls']) config.maxUrls = Number(values['max-urls']);
      if (values['max-depth']) config.maxDepth = Number(values['max-depth']);
      if (values.rate) config.requestsPerSecond = Number(values.rate);
      if (values.concurrency) config.concurrency = Number(values.concurrency);
      if (values.include) config.include = values.include;
      if (values.exclude) config.exclude = values.exclude;
      if (values['user-agent']) config.userAgent = values['user-agent'];
      if (values.header) {
        config.headers = Object.fromEntries(values.header.map((h) => {
          const at = h.indexOf(':');
          if (at < 1) throw new Error(`Header must look like "Name: value": ${h}`);
          return [h.slice(0, at).trim().toLowerCase(), h.slice(at + 1).trim()];
        }));
      }
      if (values.robots === 'ignore') config.robotsMode = 'ignore';
      if (values['robots-file']) {
        config.robotsMode = 'custom';
        config.customRobots = readFileSync(values['robots-file'], 'utf8');
      }
      if (values['no-sitemaps']) config.useSitemaps = false;
      if (values['no-external']) config.checkExternal = false;
      if (values['no-images']) config.checkImages = false;
      if (values['no-resources']) config.checkResources = false;
      if (values.render) config.renderJs = true;
      if (values.subdomains) config.crawlSubdomains = true;
      if (values.seed) config.seeds = values.seed;
      const resolved = resolveCrawlConfig(config);
      const plan: PaidPlan = {
        backlinks: Boolean(values.backlinks),
        volume: Boolean(values.volume),
        rank: Boolean(values.rank),
        keywords: (values.keywords ?? '').split(',').map((k) => k.trim()).filter(Boolean),
        location: values.location ? Number(values.location) : undefined,
        language: values.language,
      };
      const traffic = await trafficPlanFromFlags(values);
      const id = newCrawlId(resolved.startUrl);
      if (!emptyPlan(plan)) {
        if (!readSettings().paidApis) throw new PaidApisDisabled();
        if (!values.yes) {
          console.log(`This crawl's paid data will cost up to $${estimatePlan(plan).toFixed(3)}. Nothing was crawled. Re-run with --yes to spend it.`);
          return;
        }
        const db = createCrawlDb(id);
        savePaidPlan(db, plan);
        db.close();
      }
      if (traffic) {
        const db = createCrawlDb(id);
        saveTrafficPlan(db, traffic);
        db.close();
      }
      printFinished(await startCrawl(resolved, { onProgress: progressLine, signal: stopOnInterrupt() }, id));
      await runPaidPlan(id);
      printPaidData(id);
      await runTraffic(id);
      return;
    }
    case 'resume': {
      if (!positionals[0]) throw new Error('Usage: sak resume <id>');
      printFinished(await resumeCrawl(positionals[0], { onProgress: progressLine, signal: stopOnInterrupt() }));
      await runPaidPlan(positionals[0]);
      printPaidData(positionals[0]);
      await runTraffic(positionals[0]);
      return;
    }
    case 'list': {
      for (const crawl of listCrawls()) console.log(`${crawl.id}  ${crawl.status}  ${crawl.pages} URLs  ${crawl.issues} issues  ${crawl.startUrl}`);
      return;
    }
    case 'issues': {
      const id = positionals[0];
      if (!id) throw new Error('Usage: sak issues <id>');
      withCrawl(id, (db) => {
        if (!values.type) {
          for (const row of issuesSummary(db)) console.log(`${row.severity.padEnd(8)} ${String(row.count).padStart(6)}  ${row.title} (${row.type})`);
          return;
        }
        const page = listIssues(db, { type: values.type, limit: Number(values.limit ?? 100) });
        for (const issue of page.items) console.log(`${issue.url}${issue.detail ? `  ${issue.detail}` : ''}`);
        if (page.total > page.items.length) console.log(`(${page.items.length} of ${page.total})`);
      });
      return;
    }
    case 'url': {
      if (positionals.length < 2) throw new Error('Usage: sak url <id> <url>');
      console.log(JSON.stringify(withCrawl(positionals[0], (db) => urlInfo(db, positionals[1])), null, 2));
      return;
    }
    case 'export': {
      const kind = (values.kind ?? 'urls') as ExportKind;
      if (!positionals[0] || !values.out || !['urls', 'issues', 'links'].includes(kind)) throw new Error('Usage: sak export <id> --kind urls|issues|links --out PATH');
      const db = openCrawlDb(positionals[0], { readonly: true });
      try {
        console.log(`Wrote ${await exportCsv(db, kind, values.out)} rows to ${values.out}`);
      } finally {
        db.close();
      }
      return;
    }
    case 'compare': {
      if (positionals.length < 2) throw new Error('Usage: sak compare <before-id> <after-id>');
      const before = openCrawlDb(positionals[0], { readonly: true });
      const after = openCrawlDb(positionals[1], { readonly: true });
      console.log(JSON.stringify(compareCrawls(before, after), null, 2));
      before.close();
      after.close();
      return;
    }
    case 'ui': {
      const { startUiServer } = await import('@sak/web');
      const { url } = await startUiServer(Number(values.port ?? 4600));
      console.log(`SAK UI running at ${url}`);
      return;
    }
    case undefined:
    case 'help':
    case '--help':
      console.log(USAGE);
      return;
    default:
      if (await runIntegrationCommand(command, positionals, values)) return;
      console.error(USAGE);
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
