import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { getMeta, openCrawlDb, readSettings, readSiteAudit, runAnalysis, trafficPulls, withCrawl, writeSettings, type Db } from '@sak/core';
import { ApiCache, CostConfirmationRequired, DEFAULT_INSPECTIONS, DataForSeo, KeychainStore, addBingKey, budgetStatus, checkBudget, disconnectGoogle, emptyTrafficPlan, googleAccounts, googleLogin, importAiExport, importAiReferrals, importAnalytics, importGbp, importSearchConsole, inspectMore, listAnalyticsProperties, listBingSites, listSearchConsoleProperties, pagesForSpeedTest, parseTrafficPlan, propertyCovers, readConnections, readPaidData, readTrafficPlan, removeBingKey, resolveTrafficPlan, runCrux, runPageSpeed, runSavedPaidPlan, runSavedTrafficPlan, runTrafficPlan, saveTrafficPlan, suggestProperty, type LlmEngine, type PropertyOption, type TrafficPlan, type TrafficSource } from '@sak/integrations';

const KEYS: Record<string, string> = {
  dataforseo: 'DataForSEO login:password',
  pagespeed: 'PageSpeed Insights API key',
  'google-client': 'Google OAuth client_id:client_secret',
};

function promptHidden(label: string): Promise<string> {
  const muted = new Writable({ write: (_chunk, _encoding, done) => done() });
  process.stdout.write(`${label}: `);
  const reader = createInterface({ input: process.stdin, output: muted, terminal: Boolean(process.stdin.isTTY) });
  return new Promise((resolve) => reader.once('line', (line) => {
    reader.close();
    process.stdout.write('\n');
    resolve(line.trim());
  }));
}

export async function runPaidPlan(id: string): Promise<void> {
  const db = openCrawlDb(id);
  const cache = new ApiCache();
  try {
    await runSavedPaidPlan(db, new DataForSeo(new KeychainStore(), cache));
  } finally {
    cache.close();
    db.close();
  }
}

/** Fails before crawling, rather than after a long crawl has finished. */
export function checkPlanBudget(estimate: number): void {
  const cache = new ApiCache();
  try {
    checkBudget(cache, estimate);
  } finally {
    cache.close();
  }
}

export function printPaidData(id: string): void {
  for (const row of withCrawl(id, readPaidData)) {
    console.log(row.error ? `paid  ${row.kind}: ${row.error}` : `paid  ${row.kind} ($${row.cost.toFixed(4)}): ${JSON.stringify(row.value)}`);
  }
}

/** Null when the flags ask for no search or analytics data. Fails early if an account isn't connected. */
export async function trafficPlanFromFlags(values: Record<string, any>, fallback?: TrafficPlan | null): Promise<TrafficPlan | null> {
  const account = values.account;
  const plan = parseTrafficPlan({
    days: values.days ?? fallback?.days ?? 30,
    ...(values.gsc ? { gsc: { account, property: values.gsc, topQueries: values['top-queries'], ...(values.inspect ? { inspect: { limit: values.inspect } } : {}) } } : {}),
    ...(values.ga4 ? { ga4: { account, property: values.ga4 } } : {}),
    ...(values.bing ? { bing: { account: values['bing-key'], site: values.bing } } : {}),
  });
  const chosen = emptyTrafficPlan(plan) && fallback ? { ...fallback, days: plan.days } : plan;
  return emptyTrafficPlan(chosen) ? null : resolveTrafficPlan(new KeychainStore(), chosen);
}

export function printTraffic(db: Db): void {
  for (const pull of trafficPulls(db)) {
    const period = pull.days && pull.start_date ? `${pull.start_date} to ${pull.end_date}` : 'period chosen by the service';
    if (pull.status === 'ok') console.log(`${pull.source.padEnd(14)} ${period}, ${pull.matched} of ${pull.row_count} rows match, ${pull.dropped} outside this crawl${pull.note ? `. ${pull.note}` : ''}`);
    if (pull.error) console.log(`${pull.source.padEnd(14)} ${pull.status === 'ok' ? 'Last refresh failed, showing earlier data: ' : 'Failed: '}${pull.error}`);
  }
}

export async function runTraffic(id: string): Promise<void> {
  const db = openCrawlDb(id);
  try {
    await runSavedTrafficPlan(db, new KeychainStore());
    printTraffic(db);
  } finally {
    db.close();
  }
}

export async function runIntegrationCommand(command: string, positionals: string[], values: Record<string, any>): Promise<boolean> {
  const secrets = new KeychainStore();
  const where = { location: Number(values.location ?? 2840), language: values.language ?? 'en' };

  const paid = async <T>(call: (options: { refresh?: boolean; confirmed?: boolean }) => Promise<T>): Promise<T | null> => {
    try {
      return await call({ refresh: values.refresh, confirmed: values.yes });
    } catch (error) {
      if (!(error instanceof CostConfirmationRequired)) throw error;
      console.log(`${error.message}\nRe-run with --yes to spend it.`);
      return null;
    }
  };

  switch (command) {
    case 'paid': {
      if (positionals[0] && positionals[0] !== 'on' && positionals[0] !== 'off') throw new Error('Usage: sak paid [on|off]');
      const { paidApis } = positionals[0] ? writeSettings({ paidApis: positionals[0] === 'on' }) : readSettings();
      console.log(paidApis ? 'Paid APIs are on. Each spend still needs confirming.' : 'Paid APIs are off. Nothing can spend, and cached results still work.');
      return true;
    }
    case 'key': {
      if (positionals[0] === 'status') {
        for (const [name, label] of Object.entries(KEYS)) console.log(`${(await secrets.get(name)) ? 'set    ' : 'not set'}  ${name} (${label})`);
        const google = await googleAccounts(secrets);
        console.log(`${google.length ? 'set    ' : 'not set'}  Google sign-in${google.length ? ` (${google.join(', ')})` : ''}`);
        const bing = readConnections().bing;
        console.log(`${bing.length ? 'set    ' : 'not set'}  Bing API key${bing.length ? ` (${bing.join(', ')})` : ''}`);
        return true;
      }
      const name = positionals[1];
      if (positionals[0] !== 'set' || !KEYS[name]) throw new Error(`Usage: sak key set <${Object.keys(KEYS).join('|')}>`);
      const value = await promptHidden(KEYS[name]);
      if (!value) throw new Error('Nothing entered, so nothing was saved');
      await secrets.set(name, value);
      console.log(`Saved ${name} to the Keychain.`);
      return true;
    }
    case 'google': {
      if (positionals[0] === 'logout') {
        if (!values.account) throw new Error('Usage: sak google logout --account EMAIL');
        await disconnectGoogle(secrets, values.account);
        console.log(`Disconnected ${values.account}.`);
        return true;
      }
      if (positionals[0] !== 'login') throw new Error('Usage: sak google login | sak google logout --account EMAIL');
      const account = await googleLogin(secrets, (url) => {
        console.log('Opening your browser to sign in to Google...');
        execFile('open', [url]);
      });
      console.log(`Signed in to Google as ${account}.`);
      return true;
    }
    case 'bing': {
      if (positionals[0] !== 'key' || !['add', 'remove'].includes(positionals[1]) || !values.label) throw new Error('Usage: sak bing key add|remove --label NAME');
      if (positionals[1] === 'remove') {
        await removeBingKey(secrets, values.label);
        console.log(`Removed the Bing key ${values.label}.`);
        return true;
      }
      const key = await promptHidden('Bing Webmaster API key');
      if (!key) throw new Error('Nothing entered, so nothing was saved');
      const { sites } = await addBingKey(secrets, values.label, key);
      console.log(`Saved ${values.label} to the Keychain. It can see ${sites} sites.`);
      return true;
    }
    case 'connections': {
      const google = await googleAccounts(secrets);
      console.log(`Google client  ${(await secrets.get('google-client')) ? 'set' : 'not set'}`);
      console.log(`Google         ${google.join(', ') || 'none'}`);
      console.log(`Bing           ${readConnections().bing.join(', ') || 'none'}`);
      return true;
    }
    case 'properties': {
      const source = positionals[0] as TrafficSource;
      const load: Record<string, () => Promise<PropertyOption[]>> = {
        gsc: () => listSearchConsoleProperties(secrets, values.account),
        ga4: () => listAnalyticsProperties(secrets, values.account),
        bing: () => listBingSites(secrets, values.account),
      };
      if (!load[source]) throw new Error('Usage: sak properties <gsc|ga4|bing> [--account NAME] [--url URL]');
      const options = await load[source]();
      const suggested = values.url?.[0] ? suggestProperty(source, options, values.url[0]) : null;
      for (const option of options) {
        const notes = [option.id === suggested ? 'suggested' : '', values.url?.[0] && !propertyCovers(option.id, values.url[0]) ? 'may not cover this URL' : ''].filter(Boolean);
        console.log(`${option.id}${option.label === option.id ? '' : `  ${option.label}`}${notes.length ? `  (${notes.join(', ')})` : ''}`);
      }
      return true;
    }
    case 'traffic': {
      if (!positionals[0]) throw new Error('Usage: sak traffic <id> [--days 30|60|90] [--gsc PROPERTY] [--ga4 ID] [--bing SITE]');
      const db = openCrawlDb(positionals[0]);
      try {
        if (getMeta(db, 'status') !== 'finished') throw new Error('Search and analytics data can only be added to a finished crawl.');
        const plan = await trafficPlanFromFlags(values, readTrafficPlan(db));
        if (!plan) throw new Error('This crawl has no saved sources, so choose at least one of --gsc, --ga4 or --bing.');
        saveTrafficPlan(db, plan);
        await runTrafficPlan(db, secrets, plan);
        printTraffic(db);
      } finally {
        db.close();
      }
      return true;
    }
    case 'inspect': {
      if (!positionals[0]) throw new Error('Usage: sak inspect <id> [--limit 500]');
      const db = openCrawlDb(positionals[0]);
      try {
        await inspectMore(db, secrets, Number(values.limit ?? DEFAULT_INSPECTIONS));
        printTraffic(db);
      } finally {
        db.close();
      }
      return true;
    }
    case 'gsc':
    case 'ga4': {
      if (!positionals[0] || !values.property) throw new Error(`Usage: sak ${command} <id> --property <property>`);
      const db = openCrawlDb(positionals[0]);
      try {
        const run = command === 'gsc' ? importSearchConsole : importAnalytics;
        const result = await run(db, secrets, values.property, Number(values.days ?? 90), fetch, values.account);
        console.log(`Imported ${result.rows} rows: ${result.matched} match crawled URLs, ${result.unmatched} don't, ${result.dropped} are outside this crawl.`);
        if (command === 'ga4') {
          const ai = await importAiReferrals(db, secrets, values.property, Number(values.days ?? 90), fetch, values.account);
          console.log(`Found ${ai.rows} rows of visits referred by AI products.`);
        }
        runAnalysis(db);
      } finally {
        db.close();
      }
      return true;
    }
    case 'psi': {
      if (!positionals[0]) throw new Error('Usage: sak psi <id>');
      const db = openCrawlDb(positionals[0]);
      try {
        const urls = values.url ?? pagesForSpeedTest(db, Number(values.limit ?? 10));
        const results = await runPageSpeed(db, secrets, urls, values.strategy === 'desktop' ? 'desktop' : 'mobile');
        for (const r of results) console.log(r.error ? `failed  ${r.url}  ${r.error}` : `${String(r.performance).padStart(3)}  LCP ${Math.round(r.lcp_ms ?? 0)}ms  CLS ${r.cls?.toFixed(3)}  ${r.url}`);
        runAnalysis(db);
      } finally {
        db.close();
      }
      return true;
    }
    case 'crux': {
      if (!positionals[0]) throw new Error('Usage: sak crux <id>');
      const db = openCrawlDb(positionals[0]);
      try {
        const rows = await runCrux(db, secrets);
        if (rows.length === 0) console.log('Chrome has no real-user data for this site. That is normal for sites with little traffic.');
        else console.table(rows);
        runAnalysis(db);
      } finally {
        db.close();
      }
      return true;
    }
    case 'audit': {
      if (!positionals[0]) throw new Error('Usage: sak audit <id>');
      const audit = withCrawl(positionals[0], readSiteAudit);
      console.log(audit ? JSON.stringify(audit, null, 2) : 'This crawl was saved before SAK audited site files. Crawl the site again to see them.');
      return true;
    }
    case 'ai-import': {
      if (!positionals[0] || !values.file || (values.source !== 'gsc' && values.source !== 'bing')) throw new Error('Usage: sak ai-import <id> --source gsc|bing --file PATH');
      const db = openCrawlDb(positionals[0]);
      try {
        const result = importAiExport(db, values.source, readFileSync(values.file, 'utf8'));
        console.log(`Imported ${result.rows} ${result.kind}${result.kind === 'pages' ? `, ${result.in_crawl} of them in this crawl` : ''}. Columns read: ${JSON.stringify(result.columns)}`);
      } finally {
        db.close();
      }
      return true;
    }
    case 'budget': {
      const patch = {
        ...(values.monthly ? { monthlyBudgetUsd: Number(values.monthly) } : {}),
        ...(values.run ? { runBudgetUsd: Number(values.run) } : {}),
      };
      if (Object.values(patch).some((value) => !Number.isFinite(value) || value < 0)) throw new Error('Limits must be amounts in US dollars');
      if (Object.keys(patch).length) writeSettings(patch);
      const cache = new ApiCache();
      try {
        const status = budgetStatus(cache);
        console.log(`Limit per run: $${status.run_budget_usd.toFixed(2)}\nLimit per month: $${status.monthly_budget_usd.toFixed(2)}\nSpent this month: $${status.spent_this_month_usd.toFixed(4)}`);
      } finally {
        cache.close();
      }
      return true;
    }
    case 'gbp': {
      if (!positionals[0] || !positionals[1]) throw new Error('Usage: sak gbp <id> <name|cid:ID|place_id:ID> [--reviews 50] [--no-posts] [--yes]');
      const db = openCrawlDb(positionals[0]);
      const cache = new ApiCache();
      try {
        const answer = await paid((o) => importGbp(db, new DataForSeo(secrets, cache), { keyword: positionals[1], ...where, reviews: Number(values.reviews ?? 50), posts: !values['no-posts'] }, o));
        if (answer) console.log(`${answer.profile.title}: ${answer.reviews ?? 0} reviews and ${answer.posts ?? 0} posts read. Cost: $${answer.cost.toFixed(4)}. See sak issues ${positionals[0]}.`);
      } finally {
        cache.close();
        db.close();
      }
      return true;
    }
    case 'kw':
    case 'backlinks':
    case 'rank':
    case 'ai-overview':
    case 'ai-mode':
    case 'llm':
    case 'llm-prompt':
    case 'cost': {
      const cache = new ApiCache();
      const client = new DataForSeo(secrets, cache);
      try {
        if (command === 'cost') {
          const spend = cache.spend();
          console.log(`Spent through SAK: $${spend.total.toFixed(4)} over ${spend.calls} calls`);
          for (const row of spend.byEndpoint) console.log(`  $${row.cost.toFixed(4)}  ${row.calls} calls  ${row.endpoint}`);
          if (!readSettings().paidApis) console.log('Paid APIs are off, so the balance was not checked.');
          else if (await secrets.get('dataforseo')) console.log(`Account balance: $${await client.balance()}`);
        } else if (command === 'kw') {
          const answer = await paid((o) => client.keywordVolume(positionals, where, o));
          if (answer) { console.table(answer.value); console.log(answer.cached ? `From cache, fetched ${answer.fetchedAt}. Free.` : `Cost: $${answer.cost}`); }
        } else if (command === 'backlinks') {
          const answer = await paid((o) => client.backlinkSummary(positionals[0], o));
          if (answer) { console.log(answer.value); console.log(answer.cached ? `From cache, fetched ${answer.fetchedAt}. Free.` : `Cost: $${answer.cost}`); }
        } else if (command === 'ai-overview') {
          const answer = await paid((o) => client.aiOverviewKeywords(positionals[0], where, Number(values.limit ?? 100), o));
          if (answer) { console.log(`Cited for ${answer.value.total ?? 'an unknown number of'} keywords.`); console.table(answer.value.keywords); console.log(answer.cached ? `From cache, fetched ${answer.fetchedAt}. Free.` : `Cost: $${answer.cost}`); }
        } else if (command === 'ai-mode') {
          const [domain, ...keywords] = positionals;
          const answer = await paid((o) => client.aiModeCheck(domain, keywords, where, o));
          if (answer) { console.table(answer.value.map(({ sources, ...row }) => ({ ...row, sources: sources.length }))); console.log(`Cost: $${answer.cost.toFixed(4)}`); }
        } else if (command === 'llm') {
          const answer = await paid((o) => client.llmCitations([positionals[0], ...(values.competitor ?? [])], where, o));
          if (answer) { console.log(JSON.stringify(answer.value, null, 2)); console.log(answer.cached ? `From cache, fetched ${answer.fetchedAt}. Free.` : `Cost: $${answer.cost}`); }
        } else if (command === 'llm-prompt') {
          if (!positionals[0] || !values.engine || !values.model || !values.prompt) throw new Error('Usage: sak llm-prompt <domain> --engine ENGINE --model NAME --prompt TEXT');
          const answer = await paid((o) => client.llmPrompt(values.engine as LlmEngine, values.prompt, values.model, { domain: positionals[0], brand: values.brand }, Number(values.samples ?? 3), o));
          if (answer) { console.log(`Cited in ${answer.value.cited_in} of ${answer.value.samples} answers.${answer.value.brand_named_in === null ? '' : ` Brand named in ${answer.value.brand_named_in}.`}`); console.log(`Cost: $${answer.cost.toFixed(4)}`); }
        } else {
          const [domain, ...keywords] = positionals;
          const answer = await paid((o) => client.rankCheck(domain, keywords, where, o));
          if (answer) { console.table(answer.value); console.log(`Cost: $${answer.cost.toFixed(4)}`); }
        }
      } finally {
        cache.close();
      }
      return true;
    }
    default:
      return false;
  }
}
