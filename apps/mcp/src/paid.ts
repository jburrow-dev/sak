import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { openCrawlDb, readSettings, readSiteAudit, runAnalysis } from '@sak/core';
import { ApiCache, CostConfirmationRequired, DataForSeo, KeychainStore, PaidApisDisabled, budgetStatus, emptyPlan, enrichCrawl, estimatePlan, googleAccounts, importAiExport, importAiReferrals, importAnalytics, importBing, importGbp, importSearchConsole, listAnalyticsProperties, listBingSites, listSearchConsoleProperties, pagesForSpeedTest, propertyCovers, readConnections, readPaidData, runCrux, runPageSpeed, suggestProperty, type TrafficSource } from '@sak/integrations';

type Reply = { content: { type: 'text'; text: string }[]; isError?: boolean };

const confirmField = z.boolean().optional().describe('Set true only after the user has agreed to the estimated cost');
const accountField = z.string().optional().describe('Google account email. Needed only when several are connected.');
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

  /** Issues read this data, so they have to be rebuilt once it changes. */
  const thenAnalyse = (id: string, run: (db: ReturnType<typeof openCrawlDb>) => Promise<unknown>) => withWritableCrawl(id, async (db) => {
    const result = await run(db);
    runAnalysis(db);
    return result;
  });

  const place = (location?: number, language?: string) => ({ location: location ?? 2840, language: language ?? 'en' });

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
    description: 'Paid. Live Google top-10 position of a domain for each keyword, plus whether an AI Overview appeared and cited it. Cached results are free. Without confirm it returns the estimated cost and spends nothing.',
    inputSchema: { domain: z.string(), keywords: z.array(z.string()).min(1), ...whereFields, confirm: confirmField, refresh: refreshField },
  }, ({ domain, keywords, location, language, confirm, refresh }) =>
    paid((client) => client.rankCheck(domain, keywords, place(location, language), { confirmed: confirm, refresh })));

  server.registerTool('ai_overview_keywords', {
    description: 'Paid. Keywords where a domain is cited in Google AI Overviews, without needing a keyword list. Without confirm it returns the estimated cost and spends nothing.',
    inputSchema: { domain: z.string(), limit: z.number().int().min(1).max(1000).optional(), ...whereFields, confirm: confirmField, refresh: refreshField },
  }, ({ domain, limit, location, language, confirm, refresh }) => paid((client) => client.aiOverviewKeywords(domain, place(location, language), limit ?? 100, { confirmed: confirm, refresh })));

  server.registerTool('ai_mode_check', {
    description: 'Paid. Whether Google AI Mode cites a domain for each keyword. One request per keyword. Answers vary, so results are cached for 7 days. Without confirm it returns the estimated cost and spends nothing.',
    inputSchema: { domain: z.string(), keywords: z.array(z.string()).min(1), ...whereFields, confirm: confirmField, refresh: refreshField },
  }, ({ domain, keywords, location, language, confirm, refresh }) => paid((client) => client.aiModeCheck(domain, keywords, place(location, language), { confirmed: confirm, refresh })));

  server.registerTool('llm_citations', {
    description: 'Paid. How often AI answers cite each domain, and which other domains they cite. Pass competitors in the same call for share of voice. The docs list Google AI Overviews and ChatGPT only, and ChatGPT only for the US in English. Without confirm it returns the estimated cost and spends nothing.',
    inputSchema: { domains: z.array(z.string()).min(1).max(10), ...whereFields, confirm: confirmField, refresh: refreshField },
  }, ({ domains, location, language, confirm, refresh }) => paid((client) => client.llmCitations(domains, place(location, language), { confirmed: confirm, refresh })));

  server.registerTool('llm_brand_mentions', {
    description: 'Paid. How often AI answers name each brand in their text, linked or not. Without confirm it returns the estimated cost and spends nothing.',
    inputSchema: { brands: z.array(z.string()).min(1).max(10), ...whereFields, confirm: confirmField, refresh: refreshField },
  }, ({ brands, location, language, confirm, refresh }) => paid((client) => client.llmBrandMentions(brands, place(location, language), { confirmed: confirm, refresh })));

  server.registerTool('llm_top_pages', {
    description: 'Paid. The pages cited most in AI answers that cite this domain, marked as its own or another site\'s. Without confirm it returns the estimated cost and spends nothing.',
    inputSchema: { domain: z.string(), limit: z.number().int().min(1).max(1000).optional(), ...whereFields, confirm: confirmField, refresh: refreshField },
  }, ({ domain, limit, location, language, confirm, refresh }) => paid((client) => client.llmTopPages(domain, place(location, language), limit ?? 100, { confirmed: confirm, refresh })));

  server.registerTool('ai_keyword_volume', {
    description: 'Paid. Estimated demand for keywords in AI tools. Without confirm it returns the estimated cost and spends nothing.',
    inputSchema: { keywords: z.array(z.string()).min(1).max(1000), ...whereFields, confirm: confirmField, refresh: refreshField },
  }, ({ keywords, location, language, confirm, refresh }) => paid((client) => client.aiKeywordVolume(keywords, place(location, language), { confirmed: confirm, refresh })));

  server.registerTool('llm_prompt', {
    description: 'Paid, and the cost varies with the model and answer length. Asks a model one prompt several times and reports how often it cited a domain and named a brand. Answers come from the model\'s API, which may not match its consumer app. Without confirm it returns the estimated cost and spends nothing.',
    inputSchema: {
      engine: z.enum(['chat_gpt', 'claude', 'gemini', 'perplexity']),
      model: z.string().describe('A model name DataForSEO accepts for this engine, for example gpt-4.1-mini'),
      prompt: z.string().max(500),
      domain: z.string(),
      brand: z.string().optional(),
      samples: z.number().int().min(1).max(10).optional().describe('How many times to ask (default 3)'),
      confirm: confirmField,
      refresh: refreshField,
    },
  }, ({ engine, model, prompt, domain, brand, samples, confirm, refresh }) => paid((client) => client.llmPrompt(engine, prompt, model, { domain, brand }, samples ?? 3, { confirmed: confirm, refresh })));

  server.registerTool('gbp_check', {
    description: 'Paid. Reads a public Google Business Profile, with recent reviews and posts, stores it with a crawl and compares it to the site. Owner-only figures such as calls and views aren\'t available this way. Without confirm it returns the estimated cost and spends nothing. Reviews and posts can take a few minutes.',
    inputSchema: {
      id: z.string(),
      keyword: z.string().describe('The business name, or cid: or place_id: followed by the id'),
      reviews: z.number().int().min(0).max(1000).optional().describe('Newest reviews to read (default 50, 0 to skip)'),
      posts: z.boolean().optional().describe('Also read its posts (default true)'),
      ...whereFields,
      confirm: confirmField,
      refresh: refreshField,
    },
  }, ({ id, keyword, reviews, posts, location, language, confirm, refresh }) => {
    const request = { keyword, ...place(location, language), reviews: reviews ?? 50, posts: posts ?? true };
    return withWritableCrawl(id, async (db) => {
      const cache = new ApiCache();
      try {
        return await importGbp(db, new DataForSeo(secrets, cache), request, { confirmed: confirm, refresh });
      } catch (error) {
        if (error instanceof CostConfirmationRequired) return { needs_confirmation: true, estimated_cost_usd: error.estimate, message: 'Cached results are free, so it may cost less. Confirm to continue.' };
        throw error;
      } finally {
        cache.close();
      }
    });
  });

  server.registerTool('crawl_enrich', {
    description: 'Paid. Store DataForSEO data with a finished crawl: backlinks for its domain, search volume, rank or AI Mode citations for the given keywords, AI Overview keywords, and citations in AI answers against competitors. Without confirm it returns the most it can cost and spends nothing. Without any options it returns what is already stored.',
    inputSchema: {
      id: z.string(),
      backlinks: z.boolean().optional(),
      volume: z.boolean().optional(),
      rank: z.boolean().optional(),
      keywords: z.array(z.string()).max(1000).optional(),
      ai_overview: z.boolean().optional(),
      ai_mode: z.boolean().optional(),
      llm: z.boolean().optional(),
      competitors: z.array(z.string()).max(9).optional().describe('Domains to compare against in the llm step'),
      ...whereFields,
      confirm: confirmField,
    },
  }, ({ id, backlinks, volume, rank, keywords, ai_overview, ai_mode, llm, competitors, location, language, confirm }) => {
    const plan = { backlinks: Boolean(backlinks), volume: Boolean(volume), rank: Boolean(rank), keywords: keywords ?? [], location, language, aiOverview: Boolean(ai_overview), aiMode: Boolean(ai_mode), llm: Boolean(llm), competitors };
    return withWritableCrawl(id, async (db) => {
      if (emptyPlan(plan)) return readPaidData(db);
      if (!readSettings().paidApis) throw new PaidApisDisabled();
      const cache = new ApiCache();
      try {
        const client = new DataForSeo(secrets, cache);
        client.checkBudget(estimatePlan(plan));
        if (!confirm) return { needs_confirmation: true, estimated_cost_usd: estimatePlan(plan), message: 'Cached results are free, so it may cost less. Confirm to continue.' };
        await enrichCrawl(db, client, plan);
        return readPaidData(db);
      } finally {
        cache.close();
      }
    });
  });

  server.registerTool('api_costs', { description: 'DataForSEO spend recorded by SAK, the spending limits, and the current account balance. The balance is null while paid APIs are switched off. Only the user can change the limits, with sak budget.' }, () =>
    paid(async (client) => {
      const cache = new ApiCache();
      try {
        const balance = readSettings().paidApis && (await secrets.get('dataforseo')) ? await client.balance() : null;
        return { ...cache.spend(), ...budgetStatus(cache), balance };
      } finally {
        cache.close();
      }
    }));

  server.registerTool('gsc_import', {
    description: 'Load Search Console clicks and impressions into a crawl. Requires sak google login.',
    inputSchema: { id: z.string(), property: z.string().describe('For example sc-domain:example.com'), days: z.number().int().min(1).max(480).optional(), account: accountField },
  }, ({ id, property, days, account }) => thenAnalyse(id, (db) => importSearchConsole(db, secrets, property, days ?? 90, fetch, account)));

  server.registerTool('ga4_import', {
    description: 'Load GA4 sessions and engagement into a crawl, including visits referred by AI products. Requires sak google login.',
    inputSchema: { id: z.string(), property: z.string().describe('Numeric GA4 property id'), days: z.number().int().min(1).max(480).optional(), account: accountField },
  }, ({ id, property, days, account }) => thenAnalyse(id, async (db) => ({
    analytics: await importAnalytics(db, secrets, property, days ?? 90, fetch, account),
    ai_referrals: await importAiReferrals(db, secrets, property, days ?? 90, fetch, account),
  })));

  server.registerTool('ai_export_import', {
    description: 'Load a Search Console Generative AI or Bing AI Performance export into a crawl. Neither report has a documented API, so the user exports a CSV first. The file can list pages or queries, and its columns are found by name.',
    inputSchema: { id: z.string(), source: z.enum(['gsc', 'bing']), file: z.string().describe('Absolute path to the CSV') },
  }, ({ id, source, file }) => withWritableCrawl(id, async (db) => importAiExport(db, source, readFileSync(file, 'utf8'))));

  server.registerTool('site_audit', {
    description: 'Free. What a crawl found in robots.txt, sitemaps, llms.txt, HTTPS and host redirects. AI bot access is in the ai-bots element. Crawls from before this existed have none.',
    inputSchema: { id: z.string() },
  }, ({ id }) => withWritableCrawl(id, async (db) => readSiteAudit(db)));

  server.registerTool('crux_run', {
    description: 'Free. Site-wide Core Web Vitals from real Chrome users. Needs a Google API key with the Chrome UX Report API enabled, set with sak key set pagespeed. Sites with little traffic have no data.',
    inputSchema: { id: z.string() },
  }, ({ id }) => thenAnalyse(id, (db) => runCrux(db, secrets)));

  server.registerTool('bing_import', {
    description: "Load Bing Webmaster clicks and impressions into a crawl. Requires sak bing key add. Bing takes no date range, so the result's period may differ from the days asked for: read the stored note through crawl_status.",
    inputSchema: { id: z.string(), site: z.string().describe('For example https://www.example.com/'), days: z.number().int().min(1).max(480).optional(), account: z.string().optional().describe('Name of the Bing key. Needed only when several are connected.') },
  }, ({ id, site, days, account }) => thenAnalyse(id, (db) => importBing(db, secrets, site, days ?? 30, fetch, account)));

  server.registerTool('connections_list', { description: 'Which Google accounts and Bing keys are connected, without any credentials. Signing in is done by the user, with sak google login or in the sak ui Connections screen.' }, async () => {
    try {
      return json({ google_client_set: Boolean(await secrets.get('google-client')), google: await googleAccounts(secrets), bing: readConnections().bing });
    } catch (error) {
      return failure((error as Error).message);
    }
  });

  server.registerTool('properties_list', {
    description: 'Search Console properties, GA4 properties or Bing sites available to an account. Pass url to get a suggested property for that site.',
    inputSchema: { source: z.enum(['gsc', 'ga4', 'bing']), account: accountField, url: z.string().optional() },
  }, async ({ source, account, url }) => {
    try {
      const options = await (source === 'gsc' ? listSearchConsoleProperties(secrets, account) : source === 'ga4' ? listAnalyticsProperties(secrets, account) : listBingSites(secrets, account));
      return json({ properties: options.map((option) => ({ ...option, covers: url ? propertyCovers(option.id, url) : true })), suggested: url ? suggestProperty(source as TrafficSource, options, url) : null });
    } catch (error) {
      return failure((error as Error).message);
    }
  });

  server.registerTool('pagespeed_run', {
    description: 'Run PageSpeed Insights on specific URLs, or on the most-linked indexable pages. Each URL takes up to a minute.',
    inputSchema: { id: z.string(), urls: z.array(z.string()).optional(), limit: z.number().int().min(1).max(50).optional(), strategy: z.enum(['mobile', 'desktop']).optional() },
  }, ({ id, urls, limit, strategy }) => thenAnalyse(id, (db) => runPageSpeed(db, secrets, urls ?? pagesForSpeedTest(db, limit ?? 10), strategy ?? 'mobile')));
}
