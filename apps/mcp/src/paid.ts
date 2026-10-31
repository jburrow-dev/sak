import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openCrawlDb, readSettings } from '@sak/core';
import { ApiCache, CostConfirmationRequired, DataForSeo, KeychainStore, PaidApisDisabled, emptyPlan, enrichCrawl, estimatePlan, importAnalytics, importSearchConsole, pagesForSpeedTest, readPaidData, runPageSpeed } from '@sak/integrations';

type Reply = { content: { type: 'text'; text: string }[]; isError?: boolean };

const confirmField = z.boolean().optional().describe('Set true only after the user has agreed to the estimated cost');
const refreshField = z.boolean().optional().describe('Bypass the cache. This costs money again.');
const whereFields = {
  location: z.number().int().optional().describe('DataForSEO location code (default 2840, United States)'),
  language: z.string().optional().describe('Language code (default en)'),
};

export function dataForSeoTools(server: McpServer, json: (value: unknown) => Reply, failure: (message: string) => Reply) {
  const secrets = new KeychainStore();

  const paid = async (call: (client: DataForSeo) => Promise<unknown>): Promise<Reply> => {
    const cache = new ApiCache();
    try {
      return json(await call(new DataForSeo(secrets, cache)));
    } catch (error) {
      if (error instanceof CostConfirmationRequired) {
        return json({ needs_confirmation: true, estimated_cost_usd: error.estimate, message: error.message });
      }
      return failure((error as Error).message);
    } finally {
      cache.close();
    }
  };

  const withWritableCrawl = async (id: string, run: (db: ReturnType<typeof openCrawlDb>) => Promise<unknown>): Promise<Reply> => {
    let db: ReturnType<typeof openCrawlDb> | undefined;
    try {
      db = openCrawlDb(id);
      return json(await run(db));
    } catch (error) {
      return failure((error as Error).message);
    } finally {
      db?.close();
    }
  };

  server.registerTool('kw_volume', {
    description: 'Paid. Google Ads search volume, CPC and competition for up to 1,000 keywords. Cached results are free. Without confirm it returns the estimated cost and spends nothing.',
    inputSchema: { keywords: z.array(z.string()).min(1).max(1000), ...whereFields, confirm: confirmField, refresh: refreshField },
  }, ({ keywords, location, language, confirm, refresh }) =>
    paid((client) => client.keywordVolume(keywords, { location: location ?? 2840, language: language ?? 'en' }, { confirmed: confirm, refresh })));

  server.registerTool('backlinks_summary', {
    description: 'Paid. Backlink totals, referring domains and rank for a domain. Cached results are free. Without confirm it returns the estimated cost and spends nothing.',
    inputSchema: { target: z.string().describe('Domain without https:// or www.'), confirm: confirmField, refresh: refreshField },
  }, ({ target, confirm, refresh }) => paid((client) => client.backlinkSummary(target, { confirmed: confirm, refresh })));

  server.registerTool('rank_check', {
    description: 'Paid. Live Google top-10 position of a domain for each keyword. Cached results are free. Without confirm it returns the estimated cost and spends nothing.',
    inputSchema: { domain: z.string(), keywords: z.array(z.string()).min(1), ...whereFields, confirm: confirmField, refresh: refreshField },
  }, ({ domain, keywords, location, language, confirm, refresh }) =>
    paid((client) => client.rankCheck(domain, keywords, { location: location ?? 2840, language: language ?? 'en' }, { confirmed: confirm, refresh })));

  server.registerTool('crawl_enrich', {
    description: 'Paid. Store DataForSEO data with a finished crawl: backlinks for its domain, and search volume or rank for the given keywords. Without confirm it returns the most it can cost and spends nothing. Without any options it returns what is already stored.',
    inputSchema: {
      id: z.string(),
      backlinks: z.boolean().optional(),
      volume: z.boolean().optional(),
      rank: z.boolean().optional(),
      keywords: z.array(z.string()).max(1000).optional(),
      ...whereFields,
      confirm: confirmField,
    },
  }, ({ id, backlinks, volume, rank, keywords, location, language, confirm }) => {
    const plan = { backlinks: Boolean(backlinks), volume: Boolean(volume), rank: Boolean(rank), keywords: keywords ?? [], location, language };
    return withWritableCrawl(id, async (db) => {
      if (emptyPlan(plan)) return readPaidData(db);
      if (!readSettings().paidApis) throw new PaidApisDisabled();
      if (!confirm) return { needs_confirmation: true, estimated_cost_usd: estimatePlan(plan), message: 'Cached results are free, so it may cost less. Confirm to continue.' };
      const cache = new ApiCache();
      try {
        await enrichCrawl(db, new DataForSeo(secrets, cache), plan);
        return readPaidData(db);
      } finally {
        cache.close();
      }
    });
  });

  server.registerTool('api_costs', { description: 'DataForSEO spend recorded by SAK and the current account balance. The balance is null while paid APIs are switched off.' }, () =>
    paid(async (client) => {
      const cache = new ApiCache();
      try {
        const balance = readSettings().paidApis && (await secrets.get('dataforseo')) ? await client.balance() : null;
        return { ...cache.spend(), balance };
      } finally {
        cache.close();
      }
    }));

  server.registerTool('gsc_import', {
    description: 'Load Search Console clicks and impressions into a crawl. Requires sak google login.',
    inputSchema: { id: z.string(), property: z.string().describe('For example sc-domain:example.com'), days: z.number().int().min(1).max(480).optional() },
  }, ({ id, property, days }) => withWritableCrawl(id, (db) => importSearchConsole(db, secrets, property, days ?? 90)));

  server.registerTool('ga4_import', {
    description: 'Load GA4 sessions into a crawl. Requires sak google login.',
    inputSchema: { id: z.string(), property: z.string().describe('Numeric GA4 property id'), days: z.number().int().min(1).max(480).optional() },
  }, ({ id, property, days }) => withWritableCrawl(id, (db) => importAnalytics(db, secrets, property, days ?? 90)));

  server.registerTool('pagespeed_run', {
    description: 'Run PageSpeed Insights on specific URLs, or on the most-linked indexable pages. Each URL takes up to a minute.',
    inputSchema: { id: z.string(), urls: z.array(z.string()).optional(), limit: z.number().int().min(1).max(50).optional(), strategy: z.enum(['mobile', 'desktop']).optional() },
  }, ({ id, urls, limit, strategy }) => withWritableCrawl(id, (db) => runPageSpeed(db, secrets, urls ?? pagesForSpeedTest(db, limit ?? 10), strategy ?? 'mobile')));
}
