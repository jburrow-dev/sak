import { readSettings } from '@sak/core';
import { ApiCache, type CachedResponse } from './cache.ts';
import type { SecretStore } from './secrets.ts';

const API = 'https://api.dataforseo.com/v3/';

// Published or documented sample prices, used only to warn before spending.
// The amount actually charged comes from each response's cost field.
export const ESTIMATED_COST = {
  keywordVolume: 0.09, // per request, up to 1,000 keywords
  backlinkSummary: 0.02, // per request
  rankCheck: 0.003, // per keyword, top 10 results with AI Overview. Measured at 0.002.
  aiOverviewKeywords: 0.01, // per request, plus aiOverviewKeywordRow per row
  aiOverviewKeywordRow: 0.0006, // Measured at 0.00052.
  aiMode: 0.004, // per keyword
  llmMentions: 0.1, // per request, plus llmMentionsRow per row
  llmMentionsRow: 0.001,
  aiKeywordVolume: 0.01, // per request, plus aiKeywordVolumeRow per row
  aiKeywordVolumeRow: 0.0001,
  llmPrompt: 0.03, // per sample. Depends on the model and the answer's length.
  gbpInfo: 0.0054, // per profile
  gbpReviews: 0.00075, // per 10 reviews
  gbpPosts: 0.0025, // per request, up to 10 posts. Measured at 0.0022.
};

/** How long an AI answer stays usable. Trends need fresh data, unlike search volume. */
export const AI_CACHE_DAYS = 7;

export type LlmEngine = 'chat_gpt' | 'claude' | 'gemini' | 'perplexity';

/** Task results stay available for 30 days, so an unfinished task can still be collected until then. */
const TASK_RESULT_DAYS = 29;
const TASK_WAIT_MS = 180_000;
const TASK_POLL_MS = 5_000;
// DataForSEO's codes for a task that hasn't finished.
const TASK_NOT_READY = new Set([40601, 40602]);

export class CostConfirmationRequired extends Error {
  estimate: number;
  constructor(estimate: number, what: string) {
    super(`${what} will cost about $${estimate.toFixed(3)}. Confirm to continue.`);
    this.estimate = estimate;
  }
}

export class PaidApisDisabled extends Error {
  constructor() {
    super('Paid APIs are switched off, so nothing was spent. Cached results are still available. Turn them on with: sak paid on');
  }
}

export class BudgetExceeded extends Error {
  constructor(message: string) {
    super(`${message} Nothing was spent. Change the limits with: sak budget --run N --monthly N`);
  }
}

function requirePaidApis(): void {
  if (!readSettings().paidApis) throw new PaidApisDisabled();
}

const monthStart = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

/** Runs before asking for confirmation, so nobody agrees to a cost SAK would then refuse. */
export function checkBudget(cache: ApiCache, estimate: number): void {
  const { monthlyBudgetUsd, runBudgetUsd } = readSettings();
  if (estimate > runBudgetUsd) throw new BudgetExceeded(`This would cost about $${estimate.toFixed(2)}, over the $${runBudgetUsd.toFixed(2)} limit per run.`);
  const spent = cache.spentSince(monthStart());
  if (spent + estimate > monthlyBudgetUsd) throw new BudgetExceeded(`$${spent.toFixed(2)} is already spent this month, and about $${estimate.toFixed(2)} more would pass the $${monthlyBudgetUsd.toFixed(2)} monthly limit.`);
}

export function budgetStatus(cache: ApiCache) {
  const { monthlyBudgetUsd, runBudgetUsd } = readSettings();
  return { monthly_budget_usd: monthlyBudgetUsd, run_budget_usd: runBudgetUsd, spent_this_month_usd: cache.spentSince(monthStart()) };
}

interface CallOptions {
  refresh?: boolean;
  confirmed?: boolean;
  maxAgeDays?: number;
}

/** Every source an AI answer cites, wherever in the answer it appears. */
export function collectReferences(value: unknown, out: { domain: string | null; url: string | null }[] = []): { domain: string | null; url: string | null }[] {
  if (Array.isArray(value)) {
    value.forEach((item) => collectReferences(item, out));
  } else if (value && typeof value === 'object') {
    const node = value as Record<string, unknown>;
    if (node.type === 'ai_overview_reference') out.push({ domain: (node.domain as string) ?? null, url: (node.url as string) ?? null });
    Object.values(node).forEach((child) => collectReferences(child, out));
  }
  return out;
}

const bareDomain = (domain: string) => domain.replace(/^www\./, '').toLowerCase();
const isDomain = (candidate: string | null | undefined, bare: string) => Boolean(candidate) && (bareDomain(candidate!) === bare || bareDomain(candidate!).endsWith(`.${bare}`));
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

/**
 * Google can hide a result behind a google.com/goto link, and DataForSEO then reports google.com as
 * its domain. The real host survives only in the breadcrumb, which is cut short, so the exact page is unknown.
 */
export function organicTarget(item: any): { domain: string | null; url: string | null } {
  if (!/^https?:\/\/(www\.)?google\.com\/goto\b/.test(item.url ?? '')) return { domain: item.domain ?? null, url: item.url ?? null };
  const host = hostOf(String(item.breadcrumb ?? '').split(' ')[0]);
  return { domain: host, url: host ? `https://${host}/` : null };
}

/** Gemini links through a Google redirect, so the real address is in direct_url, or failing that its title holds the domain. */
function citedUrl(note: any): string | null {
  if (note.direct_url) return note.direct_url;
  if (hostOf(note.url ?? '')?.endsWith('vertexaisearch.cloud.google.com')) return /^[\w-]+(\.[\w-]+)+$/.test(note.title ?? '') ? `https://${note.title}/` : null;
  return note.url ?? null;
}

export interface AiAnswerRow {
  keyword: string;
  answer: boolean;
  cited: boolean;
  cited_url: string | null;
  sources: string[];
}

function aiAnswerFor(keyword: string, answerItems: any[], bare: string): AiAnswerRow {
  const references = collectReferences(answerItems);
  const own = references.find((reference) => isDomain(reference.domain, bare));
  return { keyword, answer: answerItems.length > 0, cited: Boolean(own), cited_url: own?.url ?? null, sources: [...new Set(references.map((r) => r.domain).filter((d): d is string => Boolean(d)))] };
}

/** ChatGPT data covers only the US in English, so anywhere else asks for Google's alone. */
const mentionPlatform = (where: { location: number; language: string }) => (where.location === 2840 && where.language === 'en' ? {} : { platform: 'google' });

const mentionMetrics = (metrics: any) => ({
  mentions: metrics?.total?.mentions ?? null,
  ai_search_volume: metrics?.total?.ai_search_volume ?? null,
  platforms: (metrics?.platform ?? []).map((row: any) => ({ platform: row.key, mentions: row.mentions, ai_search_volume: row.ai_search_volume })),
  cited_domains: (metrics?.sources_domain ?? []).map((row: any) => ({ domain: row.key, mentions: row.mentions })),
});

export interface MentionRow {
  target: string;
  mentions: number | null;
  ai_search_volume: number | null;
  platforms: { platform: string; mentions: number; ai_search_volume: number }[];
  cited_domains: { domain: string; mentions: number }[];
}

export interface GbpProfile {
  title: string | null;
  description: string | null;
  category: string | null;
  additional_categories: string[];
  address: string | null;
  phone: string | null;
  url: string | null;
  domain: string | null;
  place_id: string | null;
  cid: string | null;
  is_claimed: boolean | null;
  total_photos: number | null;
  rating: number | null;
  rating_votes: number | null;
  rating_distribution: Record<string, number> | null;
  has_hours: boolean;
  /** Google's current status, such as open or closed_forever. */
  business_status: string | null;
  attributes: number;
  services: number;
  place_topics: Record<string, number> | null;
  competitors: { title: string; cid: string | null; rating: number | null }[];
}

export interface GbpReview {
  rating: number | null;
  timestamp: string | null;
  text: string | null;
  owner_answer: string | null;
  owner_timestamp: string | null;
}

export interface GbpPost {
  timestamp: string | null;
  text: string | null;
  url: string | null;
}

function parseProfile(item: any): GbpProfile {
  const available = item.attributes?.available_attributes;
  return {
    title: item.title ?? null,
    description: item.description ?? null,
    category: item.category ?? null,
    additional_categories: item.additional_categories ?? [],
    address: item.address ?? null,
    phone: item.phone ?? null,
    url: item.url ?? null,
    domain: item.domain ?? null,
    place_id: item.place_id ?? null,
    cid: item.cid ?? null,
    is_claimed: item.is_claimed ?? null,
    total_photos: item.total_photos ?? null,
    rating: item.rating?.value ?? null,
    rating_votes: item.rating?.votes_count ?? null,
    rating_distribution: item.rating_distribution ?? null,
    has_hours: Boolean(item.work_time?.work_hours?.timetable),
    business_status: item.work_time?.work_hours?.current_status ?? null,
    attributes: available ? Object.values(available).flat().length : 0,
    services: item.services?.length ?? 0,
    place_topics: item.place_topics ?? null,
    competitors: (item.people_also_search ?? []).map((row: any) => ({ title: row.title, cid: row.cid ?? null, rating: row.rating?.value ?? null })),
  };
}

export interface KeywordVolumeRow {
  keyword: string;
  search_volume: number | null;
  competition: string | null;
  cpc: number | null;
}

export interface RankRow {
  keyword: string;
  position: number | null;
  url: string | null;
  ai_overview: boolean;
  ai_cited: boolean;
  ai_cited_url: string | null;
  ai_sources: string[];
}

/** Accepts login:password, the dashboard's Base64 token, or login:token. */
export function dataForSeoBasicToken(credentials: string): string {
  const at = credentials.indexOf(':');
  const candidate = at === -1 ? credentials : credentials.slice(at + 1);
  const decoded = Buffer.from(candidate, 'base64').toString('utf8');
  const isToken = Buffer.from(decoded).toString('base64') === candidate && decoded.includes(':');
  if (isToken && (at === -1 || decoded.startsWith(`${credentials.slice(0, at)}:`))) return candidate;
  return Buffer.from(credentials).toString('base64');
}

export class DataForSeo {
  private secrets: SecretStore;
  private cache: ApiCache;
  private fetchImpl: typeof fetch;
  private taskWaitMs: number;
  private taskPollMs: number;

  constructor(secrets: SecretStore, cache: ApiCache, fetchImpl: typeof fetch = fetch, taskTiming: { waitMs?: number; pollMs?: number } = {}) {
    this.secrets = secrets;
    this.cache = cache;
    this.fetchImpl = fetchImpl;
    this.taskWaitMs = taskTiming.waitMs ?? TASK_WAIT_MS;
    this.taskPollMs = taskTiming.pollMs ?? TASK_POLL_MS;
  }

  checkBudget(estimate: number): void {
    checkBudget(this.cache, estimate);
  }

  private async authHeader(): Promise<string> {
    const credentials = await this.secrets.get('dataforseo');
    if (!credentials) throw new Error('DataForSEO is not set up. Run: sak key set dataforseo (enter login:password)');
    return `Basic ${dataForSeoBasicToken(credentials)}`;
  }

  private async send(endpoint: string, task: Record<string, unknown>): Promise<any> {
    requirePaidApis();
    const response = await this.fetchImpl(API + endpoint, {
      method: 'POST',
      headers: { authorization: await this.authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify([task]),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`DataForSEO HTTP ${response.status}`);
    const data = (await response.json()) as any;
    if (data.status_code !== 20000) throw new Error(`DataForSEO error ${data.status_code}: ${data.status_message}`);
    return data;
  }

  private async post(endpoint: string, task: Record<string, unknown>): Promise<{ result: any[]; cost: number }> {
    const data = await this.send(endpoint, task);
    const taskResult = data.tasks?.[0];
    if (taskResult?.status_code !== 20000) throw new Error(`DataForSEO task error ${taskResult?.status_code}: ${taskResult?.status_message}`);
    return { result: taskResult.result ?? [], cost: Number(data.cost ?? 0) };
  }

  /** Cache first; on a miss, spend only if confirmed. Failed calls are never cached. */
  private async cached<T>(endpoint: string, task: Record<string, unknown>, estimate: number, label: string, options: CallOptions, transform: (result: any[]) => T): Promise<CachedResponse<T>> {
    if (!options.refresh) {
      const hit = this.cache.get<T>(endpoint, task, options.maxAgeDays);
      if (hit) return hit;
    }
    requirePaidApis();
    checkBudget(this.cache, estimate);
    if (!options.confirmed) throw new CostConfirmationRequired(estimate, label);
    const { result, cost } = await this.post(endpoint, task);
    const value = transform(result);
    const fetchedAt = this.cache.put(endpoint, task, value, cost);
    return { value, cost, cached: false, fetchedAt };
  }

  keywordVolume(keywords: string[], where: { location: number; language: string }, options: CallOptions = {}) {
    if (keywords.length === 0 || keywords.length > 1000) throw new Error('Provide between 1 and 1,000 keywords');
    const task = { keywords: keywords.map((k) => k.toLowerCase()).sort(), location_code: where.location, language_code: where.language };
    return this.cached('keywords_data/google_ads/search_volume/live', task, ESTIMATED_COST.keywordVolume, `Search volume for ${keywords.length} keywords`, options,
      (result): KeywordVolumeRow[] => result.map((r) => ({ keyword: r.keyword, search_volume: r.search_volume ?? null, competition: r.competition ?? null, cpc: r.cpc ?? null })));
  }

  backlinkSummary(target: string, options: CallOptions = {}) {
    const task = { target, backlinks_status_type: 'live' };
    return this.cached('backlinks/summary/live', task, ESTIMATED_COST.backlinkSummary, `Backlink summary for ${target}`, options, (result) => {
      const r = result[0] ?? {};
      return {
        target: r.target ?? target, rank: r.rank ?? null, backlinks: r.backlinks ?? null, referring_domains: r.referring_domains ?? null,
        referring_domains_nofollow: r.referring_domains_nofollow ?? null, broken_backlinks: r.broken_backlinks ?? null, spam_score: r.backlinks_spam_score ?? null,
      };
    });
  }

  /** One request per keyword. The price is checked once up front for the whole list. */
  async rankCheck(domain: string, keywords: string[], where: { location: number; language: string }, options: CallOptions = {}) {
    if (keywords.length === 0) throw new Error('Provide at least one keyword');
    // Without load_async_ai_overview, Google's slower overviews come back empty.
    const tasks = keywords.map((keyword) => ({ keyword, location_code: where.location, language_code: where.language, depth: 10, load_async_ai_overview: true }));
    const endpoint = 'serp/google/organic/live/advanced';
    const misses = options.refresh ? tasks.length : tasks.filter((task) => !this.cache.get(endpoint, { ...task, domain })).length;
    if (misses > 0) {
      requirePaidApis();
      checkBudget(this.cache, misses * ESTIMATED_COST.rankCheck);
    }
    if (misses > 0 && !options.confirmed) throw new CostConfirmationRequired(misses * ESTIMATED_COST.rankCheck, `Rank check for ${misses} uncached keywords`);
    const bare = bareDomain(domain);
    const rows: RankRow[] = [];
    let cost = 0;
    for (const task of tasks) {
      const answer = await this.rankOne(endpoint, task, domain, bare, options);
      rows.push(answer.value);
      cost += answer.cost;
    }
    return { value: rows, cost };
  }

  private async rankOne(endpoint: string, task: Record<string, unknown>, domain: string, bare: string, options: CallOptions) {
    const key = { ...task, domain };
    if (!options.refresh) {
      const hit = this.cache.get<RankRow>(endpoint, key);
      if (hit) return hit;
    }
    const { result, cost } = await this.post(endpoint, task);
    const items: any[] = result[0]?.items ?? [];
    const match = items.find((item) => item.type === 'organic' && isDomain(organicTarget(item).domain, bare));
    const ai = aiAnswerFor(String(task.keyword), items.filter((item) => item.type === 'ai_overview'), bare);
    const value: RankRow = { keyword: String(task.keyword), position: match?.rank_group ?? null, url: match ? organicTarget(match).url : null, ai_overview: ai.answer, ai_cited: ai.cited, ai_cited_url: ai.cited_url, ai_sources: ai.sources };
    this.cache.put(endpoint, key, value, cost);
    return { value, cost };
  }

  /** Keywords where a domain is cited in Google's AI Overviews, with no keyword list needed. */
  aiOverviewKeywords(domain: string, where: { location: number; language: string }, limit = 100, options: CallOptions = {}) {
    const task = { target: domain, location_code: where.location, language_code: where.language, item_types: ['ai_overview_reference'], limit, order_by: ['keyword_data.keyword_info.search_volume,desc'] };
    return this.cached('dataforseo_labs/google/ranked_keywords/live', task, ESTIMATED_COST.aiOverviewKeywords + limit * ESTIMATED_COST.aiOverviewKeywordRow, `AI Overview keywords for ${domain}`, { maxAgeDays: AI_CACHE_DAYS, ...options }, (result) => ({
      total: result[0]?.total_count ?? null,
      keywords: (result[0]?.items ?? []).map((item: any) => ({
        keyword: item.keyword_data?.keyword ?? null,
        search_volume: item.keyword_data?.keyword_info?.search_volume ?? null,
        url: item.ranked_serp_element?.serp_item?.url ?? null,
      })),
    }));
  }

  /** One request per keyword. The answers vary, so they are kept for a week rather than for good. */
  async aiModeCheck(domain: string, keywords: string[], where: { location: number; language: string }, options: CallOptions = {}) {
    if (keywords.length === 0) throw new Error('Provide at least one keyword');
    const endpoint = 'serp/google/ai_mode/live/advanced';
    const tasks = keywords.map((keyword) => ({ keyword, location_code: where.location, language_code: where.language }));
    const age = options.maxAgeDays ?? AI_CACHE_DAYS;
    const misses = options.refresh ? tasks.length : tasks.filter((task) => !this.cache.get(endpoint, { ...task, domain }, age)).length;
    const estimate = misses * ESTIMATED_COST.aiMode;
    if (misses > 0) {
      requirePaidApis();
      checkBudget(this.cache, estimate);
      if (!options.confirmed) throw new CostConfirmationRequired(estimate, `AI Mode check for ${misses} uncached keywords`);
    }
    const bare = bareDomain(domain);
    const rows: AiAnswerRow[] = [];
    let cost = 0;
    for (const task of tasks) {
      const key = { ...task, domain };
      const hit = options.refresh ? null : this.cache.get<AiAnswerRow>(endpoint, key, age);
      if (hit) {
        rows.push(hit.value);
        continue;
      }
      const answer = await this.post(endpoint, task);
      const row = aiAnswerFor(task.keyword, (answer.result[0]?.items ?? []).filter((item: any) => item.type === 'ai_overview'), bare);
      this.cache.put(endpoint, key, row, answer.cost);
      rows.push(row);
      cost += answer.cost;
    }
    return { value: rows, cost };
  }

  /**
   * How often answers on Google AI Overviews and ChatGPT cite each domain. Several domains go in one
   * request. These figures come from DataForSEO's database of prompts, not from live prompts of yours.
   */
  llmCitations(domains: string[], where: { location: number; language: string }, options: CallOptions = {}) {
    if (domains.length === 0 || domains.length > 10) throw new Error('Provide between 1 and 10 domains');
    const entity = (domain: string) => ({ domain: bareDomain(domain), search_scope: ['sources'], include_subdomains: true });
    return this.mentions(domains, domains.map((domain) => ({ key: domain, target: [entity(domain)] })), where, `AI citations for ${domains.join(', ')}`, options);
  }

  /** How often answers name each brand in their text, whether or not they link to it. */
  llmBrandMentions(brands: string[], where: { location: number; language: string }, options: CallOptions = {}) {
    if (brands.length === 0 || brands.length > 10) throw new Error('Provide between 1 and 10 brands');
    return this.mentions(brands, brands.map((brand) => ({ key: brand, target: [{ keyword: brand, search_scope: ['answer'], match_type: 'word_match' }] })), where, `AI mentions of ${brands.join(', ')}`, options);
  }

  private mentions(names: string[], targets: { key: string; target: Record<string, unknown>[] }[], where: { location: number; language: string }, label: string, options: CallOptions) {
    const shared = { location_code: where.location, language_code: where.language, internal_list_limit: 10, ...mentionPlatform(where) };
    const estimate = ESTIMATED_COST.llmMentions + names.length * ESTIMATED_COST.llmMentionsRow;
    const merged = { maxAgeDays: AI_CACHE_DAYS, ...options };
    // The multi-target endpoint needs at least two.
    if (names.length === 1) {
      return this.cached('ai_optimization/llm_mentions/target_metrics/live', { target: targets[0].target, ...shared }, estimate, label, merged, (result): MentionRow[] => [{ target: names[0], ...mentionMetrics(result[0]?.aggregated_metrics) }]);
    }
    return this.cached('ai_optimization/llm_mentions/multi_target_metrics/live', { targets, ...shared }, estimate, label, merged, (result): MentionRow[] =>
      (result[0]?.items ?? []).map((item: any) => ({ target: item.key, ...mentionMetrics(item) })));
  }

  /** Pages cited in answers that also cite this domain, so competitors' pages appear alongside your own. */
  llmTopPages(domain: string, where: { location: number; language: string }, limit = 100, options: CallOptions = {}) {
    const task = { target: [{ domain: bareDomain(domain), search_scope: ['sources'], include_subdomains: true }], links_scope: 'sources', location_code: where.location, language_code: where.language, limit, ...mentionPlatform(where) };
    const bare = bareDomain(domain);
    return this.cached('ai_optimization/llm_mentions/top_mentioned_pages/live', task, ESTIMATED_COST.llmMentions + limit * ESTIMATED_COST.llmMentionsRow, `Top AI-cited pages for ${domain}`, { maxAgeDays: AI_CACHE_DAYS, ...options }, (result) =>
      (result[0]?.items ?? []).map((item: any) => ({ page: item.page, own: isDomain(hostOf(item.page ?? ''), bare), mentions: item.total?.mentions ?? null, ai_search_volume: item.total?.ai_search_volume ?? null })) as { page: string; own: boolean; mentions: number | null; ai_search_volume: number | null }[]);
  }

  aiKeywordVolume(keywords: string[], where: { location: number; language: string }, options: CallOptions = {}) {
    if (keywords.length === 0 || keywords.length > 1000) throw new Error('Provide between 1 and 1,000 keywords');
    const task = { keywords: keywords.map((k) => k.toLowerCase()).sort(), location_code: where.location, language_code: where.language };
    return this.cached('ai_optimization/ai_keyword_data/keywords_search_volume/live', task, ESTIMATED_COST.aiKeywordVolume + keywords.length * ESTIMATED_COST.aiKeywordVolumeRow, `AI search volume for ${keywords.length} keywords`, { maxAgeDays: AI_CACHE_DAYS, ...options }, (result) =>
      (result[0]?.items ?? []).map((item: any) => ({ keyword: item.keyword, ai_search_volume: item.ai_search_volume ?? null, monthly: item.ai_monthly_searches ?? [] })) as { keyword: string; ai_search_volume: number | null; monthly: { year: number; month: number; ai_search_volume: number }[] }[]);
  }

  /**
   * Asks a model the same prompt several times, because answers vary between runs, and reports rates
   * rather than one answer. This goes through the model's API, which may not match its consumer app.
   */
  async llmPrompt(engine: LlmEngine, prompt: string, model: string, look: { domain: string; brand?: string }, samples = 3, options: CallOptions = {}) {
    if (prompt.length > 500) throw new Error('A prompt can be up to 500 characters');
    const endpoint = `ai_optimization/${engine}/llm_responses/live`;
    const age = options.maxAgeDays ?? AI_CACHE_DAYS;
    const tasks = Array.from({ length: samples }, (_, sample) => ({ user_prompt: prompt, model_name: model, web_search: true, max_output_tokens: 1024, tag: `sample-${sample}` }));
    const misses = options.refresh ? tasks.length : tasks.filter((task) => !this.cache.get(endpoint, task, age)).length;
    const estimate = misses * ESTIMATED_COST.llmPrompt;
    if (misses > 0) {
      requirePaidApis();
      checkBudget(this.cache, estimate);
      if (!options.confirmed) throw new CostConfirmationRequired(estimate, `${samples} samples of this prompt on ${engine}`);
    }
    type Answer = { text: string; cited: string[]; fan_out_queries: string[] };
    const answers: Answer[] = [];
    let cost = 0;
    for (const task of tasks) {
      const hit = options.refresh ? null : this.cache.get<Answer>(endpoint, task, age);
      if (hit) {
        answers.push(hit.value);
        continue;
      }
      const reply = await this.post(endpoint, task);
      const result = reply.result[0] ?? {};
      const sections = (result.items ?? []).filter((item: any) => item.type === 'message').flatMap((item: any) => item.sections ?? []).filter((section: any) => section.type === 'text');
      const answer: Answer = {
        text: sections.map((section: any) => section.text ?? '').join('\n'),
        cited: [...new Set<string>(sections.flatMap((section: any) => section.annotations ?? []).map(citedUrl).filter((url: string | null): url is string => Boolean(url)))],
        fan_out_queries: result.fan_out_queries ?? [],
      };
      this.cache.put(endpoint, task, answer, reply.cost);
      answers.push(answer);
      cost += reply.cost;
    }
    const bare = bareDomain(look.domain);
    const brand = look.brand?.toLowerCase();
    const count = (test: (answer: Answer) => boolean) => answers.filter(test).length;
    return {
      value: {
        samples: answers.length,
        // A model can answer from memory with web search on, so a low citation count may just mean this is low.
        with_sources: count((answer) => answer.cited.length > 0),
        cited_in: count((answer) => answer.cited.some((url) => isDomain(hostOf(url), bare))),
        brand_named_in: brand ? count((answer) => answer.text.toLowerCase().includes(brand)) : null,
        fan_out_queries: [...new Set(answers.flatMap((answer) => answer.fan_out_queries))],
        answers,
      },
      cost,
    };
  }

  /** Public profile data for one business. keyword can be a name, or cid: or place_id: followed by the id. */
  gbpInfo(keyword: string, where: { location: number; language: string }, options: CallOptions = {}) {
    const task = { keyword, location_code: where.location, language_code: where.language };
    return this.cached('business_data/google/my_business_info/live', task, ESTIMATED_COST.gbpInfo, `Business Profile for ${keyword}`, { maxAgeDays: AI_CACHE_DAYS, ...options }, (result) => {
      const item = result[0]?.items?.[0];
      return item ? parseProfile(item) : null;
    });
  }

  gbpReviews(keyword: string, where: { location: number; language: string }, depth = 50, options: CallOptions = {}) {
    // This endpoint takes ids in their own fields, unlike the profile endpoint.
    const id = keyword.match(/^(cid|place_id):(.+)$/);
    const task = { ...(id ? { [id[1]]: id[2] } : { keyword }), location_code: where.location, language_code: where.language, depth, sort_by: 'newest' };
    return this.taskFlow('business_data/google/reviews', task, Math.ceil(depth / 10) * ESTIMATED_COST.gbpReviews, `${depth} Google reviews for ${keyword}`, options, (result): GbpReview[] =>
      (result[0]?.items ?? []).map((item: any) => ({ rating: item.rating?.value ?? null, timestamp: item.timestamp ?? null, text: item.review_text ?? null, owner_answer: item.owner_answer ?? null, owner_timestamp: item.owner_timestamp ?? null })));
  }

  gbpPosts(keyword: string, where: { location: number; language: string }, options: CallOptions = {}) {
    const task = { keyword, location_code: where.location, language_code: where.language };
    return this.taskFlow('business_data/google/my_business_updates', task, ESTIMATED_COST.gbpPosts, `Business Profile posts for ${keyword}`, options, (result): GbpPost[] =>
      (result[0]?.items ?? []).map((item: any) => ({ timestamp: item.timestamp ?? null, text: item.post_text ?? item.snippet ?? null, url: item.url ?? null })));
  }

  /**
   * For endpoints with no live version. The charge is recorded as soon as the task is accepted, so if
   * waiting runs out, the next call collects the same task instead of paying for another.
   */
  private async taskFlow<T>(path: string, task: Record<string, unknown>, estimate: number, label: string, options: CallOptions, transform: (result: any[]) => T): Promise<CachedResponse<T>> {
    const age = options.maxAgeDays ?? AI_CACHE_DAYS;
    if (!options.refresh) {
      const hit = this.cache.get<T>(path, task, age);
      if (hit) return hit;
    }
    const pendingKey = `${path}/pending`;
    const pending = options.refresh ? null : this.cache.get<{ id: string; cost: number }>(pendingKey, task, TASK_RESULT_DAYS);
    let id = pending?.value.id;
    let cost = 0;
    if (!id) {
      requirePaidApis();
      checkBudget(this.cache, estimate);
      if (!options.confirmed) throw new CostConfirmationRequired(estimate, label);
      const created = await this.send(`${path}/task_post`, task);
      const posted = created.tasks?.[0];
      if (posted?.status_code !== 20100) throw new Error(`DataForSEO task error ${posted?.status_code}: ${posted?.status_message}`);
      id = String(posted.id);
      cost = Number(created.cost ?? 0);
      this.cache.put(pendingKey, task, { id, cost }, cost);
    }
    const deadline = Date.now() + this.taskWaitMs;
    for (;;) {
      const response = await this.fetchImpl(`${API}${path}/task_get/${id}`, { headers: { authorization: await this.authHeader() }, signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`DataForSEO HTTP ${response.status}`);
      const data = (await response.json()) as any;
      const state = data.tasks?.[0];
      if (state?.status_code === 20000) {
        const value = transform(state.result ?? []);
        const fetchedAt = this.cache.put(path, task, value, cost, { ledger: false });
        return { value, cost, cached: false, fetchedAt };
      }
      if (!TASK_NOT_READY.has(state?.status_code)) throw new Error(`DataForSEO task error ${state?.status_code}: ${state?.status_message}`);
      if (Date.now() + this.taskPollMs > deadline) throw new Error(`DataForSEO is still working on this task. It's already paid for, so run the same request again later to collect it.`);
      await new Promise((resolve) => setTimeout(resolve, this.taskPollMs));
    }
  }

  /** Reads the account balance. This endpoint doesn't charge. */
  async balance(): Promise<number | null> {
    const response = await this.fetchImpl(`${API}appendix/user_data`, { headers: { authorization: await this.authHeader() }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`DataForSEO HTTP ${response.status}`);
    const data = (await response.json()) as any;
    return data.tasks?.[0]?.result?.[0]?.money?.balance ?? null;
  }
}
