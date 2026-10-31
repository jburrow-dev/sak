import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database, createCrawlDb, listIssues, listElement, runAnalysis, setMeta, writeSettings, type Db } from '@sak/core';
import { ApiCache, BudgetExceeded, CostConfirmationRequired, DataForSeo, ESTIMATED_COST, MemoryStore, PaidApisDisabled, budgetStatus, collectReferences, enrichCrawl, estimateGbp, estimatePlan, emptyPlan, importAiExport, importAiReferrals, importGbp, inspectUrls, parseCsv, parsePageSpeed, readPaidData, runCrux, runPageSpeed } from '../src/index.ts';

let home: string;
let cache: ApiCache;
let secrets: MemoryStore;

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const dfs = (result: unknown[], cost = 0.1) => ok({ status_code: 20000, cost, tasks: [{ status_code: 20000, result }] });
const where = { location: 2840, language: 'en' };
const bodyOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string)[0];

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'sak-ai-'));
  process.env.SAK_HOME = home;
  cache = new ApiCache(join(home, 'cache.sqlite'));
  secrets = new MemoryStore();
  await secrets.set('dataforseo', 'login:password');
});

afterEach(() => {
  cache.close();
  rmSync(home, { recursive: true, force: true });
});

const crawl = (id = 'c1'): Db => {
  const db = createCrawlDb(id);
  setMeta(db, 'start_url', 'https://example.com/');
  db.prepare(`INSERT INTO urls (id, url, kind, state, indexable) VALUES (1, 'https://example.com/', 'page', 'done', 1), (2, 'https://example.com/guide', 'page', 'done', 1)`).run();
  db.prepare(`INSERT INTO responses (url_id, status, fetched_at) VALUES (1, 200, 'x'), (2, 200, 'x')`).run();
  return db;
};

describe('spending limits', () => {
  it('refuses a request over the run limit before asking, and sends nothing', async () => {
    writeSettings({ runBudgetUsd: 0.01 });
    const fetchImpl = vi.fn();
    const client = new DataForSeo(secrets, cache, fetchImpl as never);
    await expect(client.keywordVolume(['seo'], where)).rejects.toBeInstanceOf(BudgetExceeded);
    await expect(client.rankCheck('e.com', ['a', 'b', 'c', 'd'], where, { confirmed: true })).rejects.toBeInstanceOf(BudgetExceeded);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses once this month would pass the monthly limit, counting earlier spend', async () => {
    writeSettings({ monthlyBudgetUsd: 0.15 });
    const fetchImpl = vi.fn(async () => dfs([{ keyword: 'a' }], 0.09));
    const client = new DataForSeo(secrets, cache, fetchImpl as never);
    await client.keywordVolume(['a'], where, { confirmed: true });
    await expect(client.keywordVolume(['b'], where, { confirmed: true })).rejects.toThrow('monthly limit');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(budgetStatus(cache)).toMatchObject({ monthly_budget_usd: 0.15, spent_this_month_usd: 0.09 });
  });

  it('still serves cached answers once the limit is reached', async () => {
    const fetchImpl = vi.fn(async () => dfs([{ keyword: 'a', search_volume: 9 }], 0.09));
    const client = new DataForSeo(secrets, cache, fetchImpl as never);
    await client.keywordVolume(['a'], where, { confirmed: true });
    writeSettings({ monthlyBudgetUsd: 0 });
    expect((await client.keywordVolume(['a'], where)).cached).toBe(true);
  });

  it('ignores spending from earlier months', () => {
    const raw = new Database(join(home, 'cache.sqlite'));
    raw.prepare(`INSERT INTO ledger (endpoint, cost, at) VALUES ('x', 40, '2020-01-01T00:00:00.000Z')`).run();
    raw.close();
    expect(budgetStatus(cache).spent_this_month_usd).toBe(0);
  });

  it('records a plan over the limit against the crawl, and spends nothing', async () => {
    writeSettings({ runBudgetUsd: 0.001 });
    const fetchImpl = vi.fn();
    const db = crawl();
    await enrichCrawl(db, new DataForSeo(secrets, cache, fetchImpl as never), { backlinks: true, volume: false, rank: false, keywords: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readPaidData(db)[0]).toMatchObject({ kind: 'budget', value: null });
    db.close();
  });
});

describe('AI answer expiry', () => {
  it('keeps AI answers for a week, then asks again', async () => {
    const fetchImpl = vi.fn(async () => dfs([{ total_count: 1, items: [] }], 0.02));
    const client = new DataForSeo(secrets, cache, fetchImpl as never);
    await client.aiOverviewKeywords('e.com', where, 10, { confirmed: true });
    expect((await client.aiOverviewKeywords('e.com', where, 10)).cached).toBe(true);
    const raw = new Database(join(home, 'cache.sqlite'));
    raw.prepare(`UPDATE api_cache SET fetched_at = '2020-01-01T00:00:00.000Z'`).run();
    raw.close();
    await expect(client.aiOverviewKeywords('e.com', where, 10)).rejects.toBeInstanceOf(CostConfirmationRequired);
  });

  it('leaves search volume cached with no expiry', async () => {
    const fetchImpl = vi.fn(async () => dfs([{ keyword: 'a' }], 0.09));
    const client = new DataForSeo(secrets, cache, fetchImpl as never);
    await client.keywordVolume(['a'], where, { confirmed: true });
    const raw = new Database(join(home, 'cache.sqlite'));
    raw.prepare(`UPDATE api_cache SET fetched_at = '2020-01-01T00:00:00.000Z'`).run();
    raw.close();
    expect((await client.keywordVolume(['a'], where)).cached).toBe(true);
  });
});

describe('AI Overviews in rank checks', () => {
  const overview = { type: 'ai_overview', references: [{ type: 'ai_overview_reference', domain: 'other.com', url: 'https://other.com/x' }], items: [{ type: 'ai_overview_element', references: [{ type: 'ai_overview_reference', domain: 'www.example.com', url: 'https://www.example.com/guide' }] }] };
  const organic = { type: 'organic', domain: 'example.com', rank_group: 4, url: 'https://example.com/' };

  it('uses the advanced endpoint and asks for slow overviews', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => dfs([{ items: [organic] }], 0.004));
    await new DataForSeo(secrets, cache, fetchImpl as never).rankCheck('example.com', ['a'], where, { confirmed: true });
    expect(fetchImpl.mock.calls[0][0]).toContain('serp/google/organic/live/advanced');
    expect(bodyOf(fetchImpl.mock.calls[0])).toMatchObject({ load_async_ai_overview: true, depth: 10 });
  });

  it('finds citations nested at any depth, and separates being cited from an overview existing', async () => {
    const client = new DataForSeo(secrets, cache, vi.fn(async () => dfs([{ items: [overview, organic] }], 0.004)) as never);
    const { value } = await client.rankCheck('example.com', ['a'], where, { confirmed: true });
    expect(value[0]).toMatchObject({ position: 4, ai_overview: true, ai_cited: true, ai_cited_url: 'https://www.example.com/guide', ai_sources: ['other.com', 'www.example.com'] });
    const absent = new DataForSeo(secrets, cache, vi.fn(async () => dfs([{ items: [overview] }], 0.004)) as never);
    const other = await absent.rankCheck('elsewhere.com', ['a'], where, { confirmed: true });
    expect(other.value[0]).toMatchObject({ position: null, ai_overview: true, ai_cited: false, ai_cited_url: null });
  });

  it('finds a site Google hid behind a redirect link, using the breadcrumb', async () => {
    const hidden = { type: 'organic', rank_group: 2, domain: 'google.com', url: 'https://google.com/goto?url=CAES123', breadcrumb: 'https://www.example.com › news › facts-and-' };
    const direct = { type: 'organic', rank_group: 5, domain: 'www.cdc.gov', url: 'https://www.cdc.gov/page', breadcrumb: 'https://www.cdc.gov › page' };
    const client = new DataForSeo(secrets, cache, vi.fn(async () => dfs([{ items: [{ ...hidden, breadcrumb: 'https://other.org › x' }, hidden, direct] }], 0.002)) as never);
    const found = await client.rankCheck('example.com', ['a'], where, { confirmed: true });
    expect(found.value[0]).toMatchObject({ position: 2, url: 'https://www.example.com/' });
    const cdc = await client.rankCheck('cdc.gov', ['a'], where, { confirmed: true });
    expect(cdc.value[0]).toMatchObject({ position: 5, url: 'https://www.cdc.gov/page' });
    const google = await client.rankCheck('google.com', ['a'], where, { confirmed: true });
    expect(google.value[0].position).toBeNull();
  });

  it('does not count a lookalike domain as a citation', () => {
    expect(collectReferences([{ type: 'ai_overview_reference', domain: 'notexample.com', url: 'u' }])).toEqual([{ domain: 'notexample.com', url: 'u' }]);
  });
});

describe('AI Mode, LLM mentions and prompts', () => {
  it('checks AI Mode per keyword, quoting only uncached ones', async () => {
    const answer = { type: 'ai_overview', references: [{ type: 'ai_overview_reference', domain: 'example.com', url: 'https://example.com/guide' }] };
    const fetchImpl = vi.fn(async () => dfs([{ items: [answer] }], 0.004));
    const client = new DataForSeo(secrets, cache, fetchImpl as never);
    const first = await client.aiModeCheck('example.com', ['a'], where, { confirmed: true });
    expect(first.value[0]).toMatchObject({ keyword: 'a', answer: true, cited: true, cited_url: 'https://example.com/guide' });
    const blocked = await client.aiModeCheck('example.com', ['a', 'b'], where).catch((e) => e);
    expect(blocked.estimate).toBeCloseTo(ESTIMATED_COST.aiMode);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses target metrics for one domain and multi-target for several, scoped to cited sources', async () => {
    const metrics = { total: { mentions: 12, ai_search_volume: 900 }, platform: [{ key: 'google', mentions: 12, ai_search_volume: 900 }], sources_domain: [{ key: 'rival.com', mentions: 3, ai_search_volume: 5 }] };
    const single = vi.fn(async (_url: string, _init: RequestInit) => dfs([{ aggregated_metrics: metrics }]));
    const one = await new DataForSeo(secrets, cache, single as never).llmCitations(['www.example.com'], where, { confirmed: true });
    expect(single.mock.calls[0][0]).toContain('llm_mentions/target_metrics/live');
    expect(bodyOf(single.mock.calls[0]).target).toEqual([{ domain: 'example.com', search_scope: ['sources'], include_subdomains: true }]);
    expect(one.value[0]).toEqual({ target: 'www.example.com', mentions: 12, ai_search_volume: 900, platforms: [{ platform: 'google', mentions: 12, ai_search_volume: 900 }], cited_domains: [{ domain: 'rival.com', mentions: 3 }] });

    const multi = vi.fn(async (_url: string, _init: RequestInit) => dfs([{ items: [{ key: 'a.com', ...metrics }, { key: 'b.com', total: { mentions: 1, ai_search_volume: 2 } }] }]));
    const many = await new DataForSeo(secrets, cache, multi as never).llmCitations(['a.com', 'b.com'], where, { confirmed: true });
    expect(multi.mock.calls[0][0]).toContain('multi_target_metrics');
    expect(bodyOf(multi.mock.calls[0]).targets.map((t: any) => t.key)).toEqual(['a.com', 'b.com']);
    expect(many.value.map((row) => [row.target, row.mentions])).toEqual([['a.com', 12], ['b.com', 1]]);
  });

  it('asks for Google data alone outside the US in English, where ChatGPT has none', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => dfs([{ aggregated_metrics: {} }]));
    const client = new DataForSeo(secrets, cache, fetchImpl as never);
    await client.llmCitations(['e.com'], { location: 2826, language: 'en' }, { confirmed: true });
    await client.llmCitations(['e.com'], where, { confirmed: true });
    expect(bodyOf(fetchImpl.mock.calls[0]).platform).toBe('google');
    expect(bodyOf(fetchImpl.mock.calls[1]).platform).toBeUndefined();
  });

  it('counts brand mentions from the answer text', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => dfs([{ aggregated_metrics: { total: { mentions: 5 } } }]));
    await new DataForSeo(secrets, cache, fetchImpl as never).llmBrandMentions(['Acme'], where, { confirmed: true });
    expect(bodyOf(fetchImpl.mock.calls[0]).target).toEqual([{ keyword: 'Acme', search_scope: ['answer'], match_type: 'word_match' }]);
  });

  it('separates your pages from others in top cited pages', async () => {
    const items = [{ page: 'https://blog.example.com/a', total: { mentions: 4, ai_search_volume: 10 } }, { page: 'https://notexample.com/b', total: { mentions: 2, ai_search_volume: 5 } }];
    const { value } = await new DataForSeo(secrets, cache, vi.fn(async () => dfs([{ items }])) as never).llmTopPages('example.com', where, 10, { confirmed: true });
    expect(value.map((row) => row.own)).toEqual([true, false]);
  });

  it('samples a prompt separately, and reports rates rather than one answer', async () => {
    const reply = (text: string, url?: string) => dfs([{ fan_out_queries: ['sub query'], items: [{ type: 'reasoning', sections: [{ type: 'text', text: 'Acme thinking' }] }, { type: 'message', sections: [{ type: 'text', text, annotations: url ? [{ url }] : null }] }] }], 0.03);
    const replies = [reply('Try Acme', 'https://example.com/x'), reply('Try Zenith', 'https://other.com/y'), reply('Acme is fine')];
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => replies.shift()!);
    const client = new DataForSeo(secrets, cache, fetchImpl as never);
    const { value, cost } = await client.llmPrompt('chat_gpt', 'best plumber?', 'gpt-4.1-mini', { domain: 'example.com', brand: 'acme' }, 3, { confirmed: true });
    expect(value).toMatchObject({ samples: 3, cited_in: 1, brand_named_in: 2, fan_out_queries: ['sub query'] });
    expect(cost).toBeCloseTo(0.09);
    expect(fetchImpl.mock.calls[0][0]).toContain('ai_optimization/chat_gpt/llm_responses/live');
    expect(new Set(fetchImpl.mock.calls.map((call) => bodyOf(call).tag)).size).toBe(3);
    const again = await client.llmPrompt('chat_gpt', 'best plumber?', 'gpt-4.1-mini', { domain: 'example.com' }, 3);
    expect(again.cost).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('reads Gemini citations through its redirect links', async () => {
    const redirect = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/ABC';
    const notes = [{ title: 'other.com', url: redirect, direct_url: 'https://www.example.com/page' }, { title: 'cdc.gov', url: redirect }, { title: 'Some Title', url: redirect }];
    const reply = dfs([{ items: [{ type: 'message', sections: [{ type: 'text', text: 'x', annotations: notes }] }] }], 0.015);
    const { value } = await new DataForSeo(secrets, cache, vi.fn(async () => reply) as never).llmPrompt('gemini', 'q', 'm', { domain: 'example.com' }, 1, { confirmed: true });
    expect(value).toMatchObject({ with_sources: 1, cited_in: 1 });
    expect(value.answers[0].cited).toEqual(['https://www.example.com/page', 'https://cdc.gov/']);
  });

  it('separates answers with no sources from answers citing someone else', async () => {
    const reply = dfs([{ items: [{ type: 'message', sections: [{ type: 'text', text: 'From memory', annotations: [] }] }] }], 0.03);
    const { value } = await new DataForSeo(secrets, cache, vi.fn(async () => reply) as never).llmPrompt('chat_gpt', 'q', 'm', { domain: 'example.com' }, 1, { confirmed: true });
    expect(value).toMatchObject({ with_sources: 0, cited_in: 0 });
  });

  it('asks for AI Overview keywords by search volume, not alphabetically', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => dfs([{ total_count: 0, items: [] }], 0.01));
    await new DataForSeo(secrets, cache, fetchImpl as never).aiOverviewKeywords('e.com', where, 5, { confirmed: true });
    expect(bodyOf(fetchImpl.mock.calls[0]).order_by).toEqual(['keyword_data.keyword_info.search_volume,desc']);
  });

  it('keeps the monthly trend for AI search volume', async () => {
    const { value } = await new DataForSeo(secrets, cache, vi.fn(async () => dfs([{ items: [{ keyword: 'a', ai_search_volume: 9, ai_monthly_searches: [{ year: 2026, month: 9, ai_search_volume: 9 }] }] }], 0.01)) as never).aiKeywordVolume(['a'], where, { confirmed: true });
    expect(value[0].monthly).toEqual([{ year: 2026, month: 9, ai_search_volume: 9 }]);
  });

  it('needs confirmation for every uncached sample', async () => {
    const blocked = await new DataForSeo(secrets, cache, vi.fn() as never).llmPrompt('claude', 'q', 'm', { domain: 'e.com' }, 4).catch((e) => e);
    expect(blocked).toBeInstanceOf(CostConfirmationRequired);
    expect(blocked.estimate).toBeCloseTo(4 * ESTIMATED_COST.llmPrompt);
  });
});

describe('storing AI data with a crawl', () => {
  it('includes the new steps in empty checks and estimates', () => {
    const none = { backlinks: false, volume: false, rank: false, keywords: [] };
    expect(emptyPlan(none)).toBe(true);
    expect(emptyPlan({ ...none, aiMode: true })).toBe(true);
    expect(emptyPlan({ ...none, aiOverview: true })).toBe(false);
    expect(emptyPlan({ ...none, llm: true })).toBe(false);
    expect(estimatePlan({ ...none, keywords: ['a', 'b'], aiMode: true })).toBeCloseTo(2 * ESTIMATED_COST.aiMode);
  });

  it('joins cited URLs to crawled pages, and keeps those the crawl never reached', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('ranked_keywords')) return dfs([{ total_count: 2, items: [{ keyword_data: { keyword: 'guide', keyword_info: { search_volume: 500 } }, ranked_serp_element: { serp_item: { url: 'https://www.example.com/guide/' } } }, { keyword_data: { keyword: 'lost' }, ranked_serp_element: { serp_item: { url: 'https://example.com/never-crawled' } } }] }], 0.02);
      if (url.includes('top_mentioned_pages')) return dfs([{ items: [{ page: 'https://example.com/', total: { mentions: 2, ai_search_volume: 7 } }, { page: 'https://rival.com/x', total: { mentions: 9, ai_search_volume: 70 } }] }]);
      return dfs([{ aggregated_metrics: { total: { mentions: 2 } }, items: [{ key: 'example.com', total: { mentions: 2 } }, { key: 'rival.com', total: { mentions: 9 } }] }]);
    });
    const db = crawl();
    await enrichCrawl(db, new DataForSeo(secrets, cache, fetchImpl as never), { backlinks: false, volume: false, rank: false, keywords: [], aiOverview: true, llm: true, competitors: ['rival.com'] });
    const rows = listElement(db, 'ai-citations', { limit: 50, sort: 'url' }).items as { url: string; engine: string; in_crawl: number; volume: number | null; status: number | null }[];
    expect(rows.map((row) => [row.url, row.engine, row.in_crawl])).toEqual([
      ['https://example.com/', 'llm_mentions', 1],
      ['https://example.com/guide', 'google_ai_overview', 1],
      ['https://example.com/never-crawled', 'google_ai_overview', 0],
    ]);
    expect(rows[1]).toMatchObject({ volume: 500, status: 200 });
    expect(readPaidData(db).map((row) => row.kind).sort()).toEqual(['ai_overview', 'llm_citations', 'llm_pages']);
    db.close();
  });
});

describe('Business Profile', () => {
  const item = { title: 'Acme', description: 'Plumbers', category: 'Plumber', address: '1 Main St', phone: '+1 919 555 0100', url: 'https://example.com/', domain: 'example.com', place_id: 'P1', cid: 'C1', is_claimed: false, total_photos: 3, rating: { value: 4.5, votes_count: 20 }, rating_distribution: { 5: 20 }, work_time: { work_hours: { timetable: {} } }, attributes: { available_attributes: { a: ['x', 'y'] } }, services: [{}], place_topics: { price: 2 }, people_also_search: [{ title: 'Rival', cid: 'C2', rating: { value: 4 } }] };
  const now = new Date('2026-10-31T00:00:00Z');

  /** A task that isn't ready the first time it's collected, as DataForSEO reports it. */
  const server = (reviewItems: unknown[], postItems: unknown[]) => {
    const polled = new Map<string, number>();
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('my_business_info/live')) return dfs([{ items: [item] }], 0.0054);
      if (url.endsWith('task_post')) {
        const id = url.includes('reviews') ? 'R' : 'U';
        return ok({ status_code: 20000, cost: 0.01, tasks: [{ id, status_code: 20100, status_message: 'Task Created.' }], init });
      }
      const seen = (polled.get(url) ?? 0) + 1;
      polled.set(url, seen);
      if (seen === 1) return ok({ status_code: 20000, tasks: [{ status_code: 40602, status_message: 'Task In Queue.' }] });
      return ok({ status_code: 20000, tasks: [{ status_code: 20000, result: [{ items: url.includes('reviews') ? reviewItems : postItems }] }] });
    });
  };
  const fast = { waitMs: 1000, pollMs: 1 };
  const request = { keyword: 'Acme', ...where, reviews: 20, posts: true };

  it('quotes the whole cost up front, including reviews and posts, and sends nothing', async () => {
    const fetchImpl = vi.fn();
    const db = crawl();
    const blocked = await importGbp(db, new DataForSeo(secrets, cache, fetchImpl as never), request).catch((e) => e);
    expect(blocked).toBeInstanceOf(CostConfirmationRequired);
    expect(blocked.estimate).toBeCloseTo(estimateGbp(request));
    expect(estimateGbp(request)).toBeCloseTo(ESTIMATED_COST.gbpInfo + 2 * ESTIMATED_COST.gbpReviews + ESTIMATED_COST.gbpPosts);
    expect(fetchImpl).not.toHaveBeenCalled();
    db.close();
  });

  it('refuses while paid APIs are off', async () => {
    writeSettings({ paidApis: false });
    const db = crawl();
    await expect(importGbp(db, new DataForSeo(secrets, cache, vi.fn() as never), request)).rejects.toBeInstanceOf(PaidApisDisabled);
    db.close();
  });

  it('stores the profile, summarises reviews and posts, and raises issues', async () => {
    const reviews = [{ rating: { value: 5 }, timestamp: '2026-10-20 10:00:00 +00:00', review_text: 'Good', owner_answer: 'Thanks' }, ...Array.from({ length: 5 }, () => ({ rating: { value: 4 }, timestamp: '2025-01-01 10:00:00 +00:00', review_text: 'Fine' }))];
    const posts = [{ timestamp: '2026-01-02 00:00:00 +00:00', post_text: 'News', url: 'u' }];
    const fetchImpl = server(reviews, posts);
    const db = crawl();
    const result = await importGbp(db, new DataForSeo(secrets, cache, fetchImpl as never, fast), request, { confirmed: true }, now);
    expect(result).toMatchObject({ reviews: 6, posts: 1 });
    expect(result.cost).toBeCloseTo(0.0254);
    const profile = db.prepare('SELECT * FROM gbp_profile').get() as Record<string, unknown>;
    expect(profile).toMatchObject({ key: 'P1', title: 'Acme', is_claimed: 0, rating: 4.5, rating_votes: 20, has_hours: 1, attributes: 2, services: 1, reviews_fetched: 6, reviews_with_reply: 1, reviews_last_90: 1, posts_fetched: 1 });
    expect(JSON.parse(profile.competitors as string)).toEqual([{ title: 'Rival', cid: 'C2', rating: 4 }]);
    const types = listIssues(db, { limit: 50 }).items.map((issue) => issue.type);
    expect(types).toEqual(expect.arrayContaining(['gbp_unclaimed', 'gbp_reviews_unanswered', 'gbp_posts_stale']));
    expect(listElement(db, 'gbp').total).toBe(1);
    db.close();
  });

  it('sends reviews the id in its own field, sorted by newest', async () => {
    const fetchImpl = server([], []);
    const db = crawl();
    await importGbp(db, new DataForSeo(secrets, cache, fetchImpl as never, fast), request, { confirmed: true }, now);
    const post = fetchImpl.mock.calls.find(([url]) => (url as string).includes('reviews/task_post'))!;
    expect(bodyOf(post)).toMatchObject({ place_id: 'P1', depth: 20, sort_by: 'newest' });
    expect(bodyOf(post).keyword).toBeUndefined();
    db.close();
  });

  it('collects a paid task on the next call instead of paying again when waiting runs out', async () => {
    let ready = false;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('task_post')) return ok({ status_code: 20000, cost: 0.01, tasks: [{ id: 'R', status_code: 20100 }] });
      return ready ? ok({ status_code: 20000, tasks: [{ status_code: 20000, result: [{ items: [{ review_text: 'x' }] }] }] }) : ok({ status_code: 20000, tasks: [{ status_code: 40601 }] });
    });
    const client = new DataForSeo(secrets, cache, fetchImpl as never, { waitMs: 0, pollMs: 1 });
    await expect(client.gbpReviews('Acme', where, 10, { confirmed: true })).rejects.toThrow('already paid for');
    expect(cache.spend()).toMatchObject({ total: 0.01, calls: 1 });
    ready = true;
    // Collecting needs no confirmation, because nothing new is spent.
    const answer = await client.gbpReviews('Acme', where, 10);
    expect(answer.value).toHaveLength(1);
    expect(fetchImpl.mock.calls.filter(([url]) => (url as string).endsWith('task_post'))).toHaveLength(1);
    expect(cache.spend()).toMatchObject({ total: 0.01, calls: 1 });
    expect((await client.gbpReviews('Acme', where, 10)).cached).toBe(true);
  });

  it('reports a failed task rather than waiting for it', async () => {
    const fetchImpl = vi.fn(async (url: string) => (url.endsWith('task_post') ? ok({ status_code: 20000, cost: 0, tasks: [{ id: 'R', status_code: 20100 }] }) : ok({ status_code: 20000, tasks: [{ status_code: 40400, status_message: 'Not Found' }] })));
    await expect(new DataForSeo(secrets, cache, fetchImpl as never, fast).gbpReviews('Acme', where, 10, { confirmed: true })).rejects.toThrow('40400');
  });

  it('reports a closed business, without also calling its hours missing', async () => {
    // As Google returned it for a closed location: no timetable, no services and no related businesses.
    const closed = { ...item, is_claimed: true, work_time: { work_hours: { timetable: null, current_status: 'closed_forever' } }, services: null, people_also_search: null };
    const fetchImpl = vi.fn(async () => dfs([{ items: [closed] }], 0.0054));
    const db = crawl();
    const { profile } = await importGbp(db, new DataForSeo(secrets, cache, fetchImpl as never, fast), { ...request, reviews: 0, posts: false }, { confirmed: true }, now);
    expect(profile).toMatchObject({ business_status: 'closed_forever', has_hours: false, services: 0, competitors: [] });
    const found = listIssues(db, { limit: 50 }).items;
    expect(found.find((issue) => issue.type === 'gbp_closed')?.detail).toContain('closed forever');
    expect(found.find((issue) => issue.type === 'gbp_incomplete')?.detail).not.toContain('hours');
    expect(listElement(db, 'gbp', { filter: 'closed' }).total).toBe(1);
    db.close();
  });

  it('asks for posts by place id, as the docs allow, so a chain finds the right location', async () => {
    const fetchImpl = server([], []);
    const db = crawl();
    await importGbp(db, new DataForSeo(secrets, cache, fetchImpl as never, fast), request, { confirmed: true }, now);
    const post = fetchImpl.mock.calls.find(([url]) => (url as string).includes('my_business_updates/task_post'))!;
    expect(bodyOf(post).keyword).toBe('place_id:P1');
    db.close();
  });

  it('explains when no profile matches', async () => {
    const db = crawl();
    await expect(importGbp(db, new DataForSeo(secrets, cache, vi.fn(async () => dfs([{ items: [] }])) as never, fast), request, { confirmed: true })).rejects.toThrow('no Business Profile');
    db.close();
  });
});

describe('free Google data', () => {
  const googleToken = async () => {
    await secrets.set('google-tokens', JSON.stringify({ access_token: 't', refresh_token: 'r', expires_at: Date.now() + 3_600_000 }));
  };

  it('prefers real-user vitals, and converts CLS from its scaled form', () => {
    const parsed = parsePageSpeed('u', 'mobile', { loadingExperience: { metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 4500 }, CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 30 } } } });
    expect(parsed).toMatchObject({ field_lcp_ms: 4500, field_cls: 0.3 });
  });

  it('raises issues from vitals, labelling their source', async () => {
    const db = crawl();
    const body = { lighthouseResult: { audits: { 'largest-contentful-paint': { numericValue: 3000 }, 'cumulative-layout-shift': { numericValue: 0.3 } } }, loadingExperience: { metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 4500 }, INTERACTION_TO_NEXT_PAINT: { percentile: 150 } } } };
    await runPageSpeed(db, secrets, ['https://example.com/'], 'mobile', vi.fn(async () => ok(body)) as never);
    runAnalysis(db);
    const found = listIssues(db, { limit: 50 }).items.filter((issue) => issue.type.startsWith('cwv_'));
    expect(found.map((issue) => [issue.type, issue.detail])).toEqual(expect.arrayContaining([
      ['cwv_lcp_poor', '4500 ms (real users, mobile)'],
      ['cwv_cls_poor', '0.30 (lab test, mobile)'],
    ]));
    expect(found.some((issue) => issue.type === 'cwv_inp_poor')).toBe(false);
    db.close();
  });

  it('reads site-wide CrUX data, treats no data as normal, and raises issues', async () => {
    await secrets.set('pagespeed', 'key');
    const db = crawl();
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      if (JSON.parse(init.body as string).formFactor === 'DESKTOP') return new Response('{}', { status: 404 });
      return ok({ record: { metrics: { largest_contentful_paint: { percentiles: { p75: 2000 } }, cumulative_layout_shift: { percentiles: { p75: '0.30' } }, interaction_to_next_paint: { percentiles: { p75: 600 } } } } });
    });
    const rows = await runCrux(db, secrets, fetchImpl as never);
    expect(rows).toEqual([{ scope: 'https://example.com', form_factor: 'PHONE', lcp_ms: 2000, cls: 0.3, inp_ms: 600 }]);
    runAnalysis(db);
    expect(listIssues(db, { limit: 50 }).items.map((issue) => issue.type)).toEqual(expect.arrayContaining(['cwv_cls_poor', 'cwv_inp_poor']));
    db.close();
  });

  it('asks for a key before calling CrUX, and keeps the key out of errors', async () => {
    const db = crawl();
    await expect(runCrux(db, secrets, vi.fn() as never)).rejects.toThrow('sak key set pagespeed');
    await secrets.set('pagespeed', 'secret-key');
    const failed = await runCrux(db, secrets, vi.fn(async () => new Response(JSON.stringify({ error: { message: 'API not enabled' } }), { status: 403 })) as never).catch((e) => e);
    expect(failed.message).toContain('API not enabled');
    expect(failed.message).not.toContain('secret-key');
    db.close();
  });

  it('keeps rich result status from URL Inspection, and raises an issue when invalid', async () => {
    await googleToken();
    const db = crawl();
    const fetchImpl = vi.fn(async () => ok({ inspectionResult: { indexStatusResult: { verdict: 'PASS' }, richResultsResult: { verdict: 'FAIL', detectedItems: [{ richResultType: 'Product snippets', items: [{ issues: [{ issueMessage: 'Missing offers', severity: 'ERROR' }] }] }] } } }));
    await inspectUrls(db, secrets, 'sc-domain:example.com', 1, fetchImpl as never, 'default', 0).catch((error) => { throw error; });
    const stored = db.prepare('SELECT rich_verdict, rich_types, rich_issues FROM url_inspection').get();
    expect(stored).toEqual({ rich_verdict: 'FAIL', rich_types: 'Product snippets', rich_issues: 'Product snippets: Missing offers' });
    runAnalysis(db);
    expect(listIssues(db, { limit: 50 }).items.find((issue) => issue.type === 'rich_result_invalid')?.detail).toBe('Product snippets: Missing offers');
    db.close();
  });

  it('adds up AI referrals per page and source, filtered at the API', async () => {
    await googleToken();
    const db = crawl();
    const row = (host: string, path: string, source: string, sessions: string) => ({ dimensionValues: [{ value: host }, { value: path }, { value: source }], metricValues: [{ value: sessions }, { value: '1' }, { value: '0' }] });
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => ok({ rowCount: 3, rows: [row('example.com', '/guide', 'chatgpt.com', '4'), row('www.example.com', '/guide', 'www.chatgpt.com', '1'), row('other.com', '/x', 'perplexity.ai', '9')] }));
    const result = await importAiReferrals(db, secrets, '123', 30, fetchImpl as never, 'default');
    expect(result).toMatchObject({ rows: 3, dropped: 1 });
    const sent = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    expect(sent.dimensionFilter.filter).toMatchObject({ fieldName: 'sessionSource', stringFilter: { matchType: 'FULL_REGEXP' } });
    expect(sent.dimensionFilter.filter.stringFilter.value).toContain('chatgpt');
    expect(listElement(db, 'ai-traffic').items).toEqual([expect.objectContaining({ url: 'https://example.com/guide', source: 'chatgpt.com', sessions: 5 })]);
    db.close();
  });
});

describe('AI report exports', () => {
  it('parses quoted CSV with a byte order mark and Windows line endings', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"']]);
  });

  it('loads a page report, finding columns by name and matching crawled URLs', () => {
    const db = crawl();
    const result = importAiExport(db, 'gsc', 'Top pages,Clicks,Impressions\nhttps://www.example.com/guide/,0,"1,200"\nhttps://example.com/new,0,5\nGrand total,,1205\n');
    expect(result).toMatchObject({ kind: 'pages', rows: 3, in_crawl: 1, columns: { page: 'Top pages', impressions: 'Impressions' } });
    const rows = listElement(db, 'ai-search', { sort: 'impressions', desc: true }).items as { url: string; impressions: number; in_crawl: number; indexable: number | null }[];
    expect(rows[1]).toMatchObject({ url: 'https://example.com/guide', impressions: 1200, in_crawl: 1, indexable: 1 });
    db.close();
  });

  it('loads a query report with citation share as a number', () => {
    const db = crawl();
    const result = importAiExport(db, 'bing', 'Grounding query,Citations,Citation share\nbest plumber,12,34.5%\n');
    expect(result).toMatchObject({ kind: 'queries', rows: 1 });
    expect(listElement(db, 'ai-queries').items[0]).toMatchObject({ query: 'best plumber', citations: 12, citation_share: 34.5 });
    db.close();
  });

  it('replaces only the same source on import, and explains an unknown format', () => {
    const db = crawl();
    importAiExport(db, 'gsc', 'Page,Impressions\nhttps://example.com/,5\n');
    importAiExport(db, 'bing', 'Page,Citations\nhttps://example.com/,2\n');
    importAiExport(db, 'bing', 'Page,Citations\nhttps://example.com/guide,3\n');
    expect(listElement(db, 'ai-search').items.map((row: any) => [row.source, row.url])).toEqual([['gsc', 'https://example.com/'], ['bing', 'https://example.com/guide']]);
    expect(() => importAiExport(db, 'gsc', 'Foo,Bar\n1,2\n')).toThrow('Foo, Bar');
    expect(() => importAiExport(db, 'gsc', '')).toThrow('no rows');
    db.close();
  });
});
