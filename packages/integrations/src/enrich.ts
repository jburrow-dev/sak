import { getMeta, setMeta, type Db } from '@sak/core';
import { DataForSeo, ESTIMATED_COST } from './dataforseo.ts';
import { crawlResolver } from './match.ts';

/** Optional DataForSEO data to collect for one crawl. */
export interface PaidPlan {
  backlinks: boolean;
  volume: boolean;
  rank: boolean;
  keywords: string[];
  location?: number;
  language?: string;
  /** Keywords where the domain is cited in AI Overviews. */
  aiOverview?: boolean;
  /** AI Mode citations for the keywords. */
  aiMode?: boolean;
  /** Citations in AI answers, against these competitors, plus the most-cited pages. */
  llm?: boolean;
  competitors?: string[];
}

const AI_KEYWORD_LIMIT = 100;
const LLM_PAGE_LIMIT = 100;

export const emptyPlan = (plan: PaidPlan) => !plan.backlinks && !plan.aiOverview && !plan.llm && !(plan.keywords.length > 0 && (plan.volume || plan.rank || plan.aiMode));

/** The most the plan can cost. Anything already cached is free, so it may cost less. */
export function estimatePlan(plan: PaidPlan): number {
  const keywords = plan.keywords.length;
  return (plan.backlinks ? ESTIMATED_COST.backlinkSummary : 0)
    + (plan.volume && keywords > 0 ? ESTIMATED_COST.keywordVolume : 0)
    + (plan.rank ? keywords * ESTIMATED_COST.rankCheck : 0)
    + (plan.aiOverview ? ESTIMATED_COST.aiOverviewKeywords + AI_KEYWORD_LIMIT * ESTIMATED_COST.aiOverviewKeywordRow : 0)
    + (plan.aiMode ? keywords * ESTIMATED_COST.aiMode : 0)
    + (plan.llm ? 2 * ESTIMATED_COST.llmMentions + (1 + (plan.competitors?.length ?? 0) + LLM_PAGE_LIMIT) * ESTIMATED_COST.llmMentionsRow : 0);
}

export interface PaidRow {
  kind: string;
  key: string;
  value: unknown;
  cost: number;
  cached: number;
  error: string | null;
  fetched_at: string;
}

export function readPaidData(db: Db): PaidRow[] {
  const rows = db.prepare('SELECT kind, key, value, cost, cached, error, fetched_at FROM paid_data ORDER BY kind, key').all() as (Omit<PaidRow, 'value'> & { value: string | null })[];
  return rows.map((row) => ({ ...row, value: row.value === null ? null : JSON.parse(row.value) }));
}

const domainOf = (startUrl: string) => new URL(startUrl).hostname.replace(/^www\./, '');

/**
 * Runs a plan the user has already agreed to. One failed step doesn't lose the others, and each
 * outcome is stored with the crawl. The client's own checks still stop anything while paid APIs are off.
 */
export async function enrichCrawl(db: Db, client: DataForSeo, plan: PaidPlan): Promise<void> {
  const startUrl = getMeta(db, 'start_url');
  if (!startUrl) throw new Error('This crawl has no start URL');
  const domain = domainOf(startUrl);
  const where = { location: plan.location ?? 2840, language: plan.language ?? 'en' };
  const save = db.prepare(`INSERT OR REPLACE INTO paid_data (kind, key, value, cost, cached, error, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const record = async <T>(kind: string, key: string, call: () => Promise<{ value: T; cost: number; cached?: boolean }>): Promise<T | null> => {
    const at = new Date().toISOString();
    try {
      const answer = await call();
      save.run(kind, key, JSON.stringify(answer.value), answer.cost, answer.cached ? 1 : 0, null, at);
      return answer.value;
    } catch (error) {
      save.run(kind, key, null, 0, 0, (error as Error).message, at);
      return null;
    }
  };
  try {
    client.checkBudget(estimatePlan(plan));
  } catch (error) {
    save.run('budget', 'plan', null, 0, 0, (error as Error).message, new Date().toISOString());
    return;
  }
  const resolve = crawlResolver(db);
  const cite = db.prepare('INSERT OR REPLACE INTO ai_citations (url, engine, subject, volume) VALUES (?, ?, ?, ?)');
  const citation = (url: string | null, engine: string, subject: string, volume: number | null = null) => {
    if (url) cite.run(resolve(url)?.url ?? url, engine, subject, volume);
  };
  if (plan.backlinks) await record('backlinks', domain, () => client.backlinkSummary(domain, { confirmed: true }));
  if (plan.volume && plan.keywords.length > 0) await record('volume', 'keywords', () => client.keywordVolume(plan.keywords, where, { confirmed: true }));
  if (plan.rank && plan.keywords.length > 0) {
    const rows = await record('rank', domain, () => client.rankCheck(domain, plan.keywords, where, { confirmed: true }));
    for (const row of rows ?? []) citation(row.ai_cited_url, 'google_ai_overview', row.keyword);
  }
  if (plan.aiOverview) {
    const found = await record('ai_overview', domain, () => client.aiOverviewKeywords(domain, where, AI_KEYWORD_LIMIT, { confirmed: true }));
    for (const row of found?.keywords ?? []) citation(row.url, 'google_ai_overview', row.keyword, row.search_volume);
  }
  if (plan.aiMode && plan.keywords.length > 0) {
    const rows = await record('ai_mode', domain, () => client.aiModeCheck(domain, plan.keywords, where, { confirmed: true }));
    for (const row of rows ?? []) citation(row.cited_url, 'google_ai_mode', row.keyword);
  }
  if (plan.llm) {
    await record('llm_citations', domain, () => client.llmCitations([domain, ...(plan.competitors ?? [])], where, { confirmed: true }));
    const pages = await record('llm_pages', domain, () => client.llmTopPages(domain, where, LLM_PAGE_LIMIT, { confirmed: true }));
    for (const page of pages ?? []) {
      if (page.own) citation(page.page, 'llm_mentions', 'all prompts', page.ai_search_volume);
    }
  }
}

/** Saves a plan the user agreed to, so a paused crawl can still run it when it finishes. */
export function savePaidPlan(db: Db, plan: PaidPlan): void {
  setMeta(db, 'paid_plan', JSON.stringify(plan));
}

/** Runs the saved plan once, after the crawl has finished. */
export async function runSavedPaidPlan(db: Db, client: DataForSeo): Promise<void> {
  const raw = getMeta(db, 'paid_plan');
  if (!raw || getMeta(db, 'status') !== 'finished' || getMeta(db, 'paid_plan_done')) return;
  setMeta(db, 'paid_plan_done', new Date().toISOString());
  await enrichCrawl(db, client, JSON.parse(raw) as PaidPlan);
}
