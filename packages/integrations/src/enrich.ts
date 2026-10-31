import { getMeta, setMeta, type Db } from '@sak/core';
import { DataForSeo, ESTIMATED_COST } from './dataforseo.ts';

/** Optional DataForSEO data to collect for one crawl. */
export interface PaidPlan {
  backlinks: boolean;
  volume: boolean;
  rank: boolean;
  keywords: string[];
  location?: number;
  language?: string;
}

export const emptyPlan = (plan: PaidPlan) => !plan.backlinks && !(plan.keywords.length > 0 && (plan.volume || plan.rank));

/** The most the plan can cost. Anything already cached is free, so it may cost less. */
export function estimatePlan(plan: PaidPlan): number {
  const keywords = plan.keywords.length;
  return (plan.backlinks ? ESTIMATED_COST.backlinkSummary : 0)
    + (plan.volume && keywords > 0 ? ESTIMATED_COST.keywordVolume : 0)
    + (plan.rank ? keywords * ESTIMATED_COST.rankCheck : 0);
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
  const record = async (kind: string, key: string, call: () => Promise<{ value: unknown; cost: number; cached?: boolean }>) => {
    const at = new Date().toISOString();
    try {
      const answer = await call();
      save.run(kind, key, JSON.stringify(answer.value), answer.cost, answer.cached ? 1 : 0, null, at);
    } catch (error) {
      save.run(kind, key, null, 0, 0, (error as Error).message, at);
    }
  };
  if (plan.backlinks) await record('backlinks', domain, () => client.backlinkSummary(domain, { confirmed: true }));
  if (plan.volume && plan.keywords.length > 0) await record('volume', 'keywords', () => client.keywordVolume(plan.keywords, where, { confirmed: true }));
  if (plan.rank && plan.keywords.length > 0) await record('rank', domain, () => client.rankCheck(domain, plan.keywords, where, { confirmed: true }));
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
