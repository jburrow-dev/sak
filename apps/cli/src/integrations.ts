import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { openCrawlDb, readSettings, withCrawl, writeSettings } from '@sak/core';
import { ApiCache, CostConfirmationRequired, DataForSeo, KeychainStore, googleLogin, importAnalytics, importSearchConsole, pagesForSpeedTest, readPaidData, runPageSpeed, runSavedPaidPlan } from '@sak/integrations';

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

export function printPaidData(id: string): void {
  for (const row of withCrawl(id, readPaidData)) {
    console.log(row.error ? `paid  ${row.kind}: ${row.error}` : `paid  ${row.kind} ($${row.cost.toFixed(4)}): ${JSON.stringify(row.value)}`);
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
        console.log(`${(await secrets.get('google-tokens')) ? 'set    ' : 'not set'}  Google sign-in`);
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
      if (positionals[0] !== 'login') throw new Error('Usage: sak google login');
      await googleLogin(secrets, (url) => {
        console.log('Opening your browser to sign in to Google...');
        execFile('open', [url]);
      });
      console.log('Signed in to Google.');
      return true;
    }
    case 'gsc':
    case 'ga4': {
      if (!positionals[0] || !values.property) throw new Error(`Usage: sak ${command} <id> --property <property>`);
      const db = openCrawlDb(positionals[0]);
      try {
        const run = command === 'gsc' ? importSearchConsole : importAnalytics;
        const result = await run(db, secrets, values.property, Number(values.days ?? 90));
        console.log(`Imported ${result.rows} rows: ${result.matched} match crawled URLs, ${result.unmatched} don't.`);
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
      } finally {
        db.close();
      }
      return true;
    }
    case 'kw':
    case 'backlinks':
    case 'rank':
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
