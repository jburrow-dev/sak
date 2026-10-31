import { deleteMeta, getMeta, runAnalysis, setMeta, siteHost, type Db } from '@sak/core';
import { importBing } from './bing.ts';
import { INSPECTIONS_PER_DAY, resolveBingAccount, resolveGoogleAccount, updateConnections } from './connections.ts';
import { DEFAULT_INSPECTIONS, importAiReferrals, importAnalytics, importSearchConsole, importTopQueries, inspectUrls } from './google.ts';
import { recordPullFailure } from './pulls.ts';
import type { SecretStore } from './secrets.ts';

export const TRAFFIC_DAYS = [30, 60, 90] as const;

/** Search and analytics data to collect for one crawl. */
export interface TrafficPlan {
  days: number;
  gsc?: { account?: string; property: string; topQueries?: boolean; inspect?: { limit: number } };
  ga4?: { account?: string; property: string };
  bing?: { account?: string; site: string };
}

export const emptyTrafficPlan = (plan: TrafficPlan) => !plan.gsc && !plan.ga4 && !plan.bing;

const text = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
};
const optionalText = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/** Checks a plan from outside, such as a form, and keeps only the fields it knows. */
export function parseTrafficPlan(input: any): TrafficPlan {
  const days = Number(input?.days);
  if (!(TRAFFIC_DAYS as readonly number[]).includes(days)) throw new Error('The date range must be 30, 60 or 90 days');
  const plan: TrafficPlan = { days };
  if (input.gsc) {
    plan.gsc = { account: optionalText(input.gsc.account), property: text(input.gsc.property, 'A Search Console property') };
    if (input.gsc.topQueries) plan.gsc.topQueries = true;
    if (input.gsc.inspect) {
      const limit = Number(input.gsc.inspect.limit ?? DEFAULT_INSPECTIONS);
      if (!Number.isInteger(limit) || limit < 1 || limit > INSPECTIONS_PER_DAY) throw new Error(`URL Inspection can cover 1 to ${INSPECTIONS_PER_DAY} URLs a day`);
      plan.gsc.inspect = { limit };
    }
  }
  if (input.ga4) plan.ga4 = { account: optionalText(input.ga4.account), property: text(input.ga4.property, 'A GA4 property') };
  if (input.bing) plan.bing = { account: optionalText(input.bing.account), site: text(input.bing.site, 'A Bing site') };
  return plan;
}

/** Fails before anything is crawled, and pins each source to its account in case more are connected later. */
export async function resolveTrafficPlan(secrets: SecretStore, plan: TrafficPlan): Promise<TrafficPlan> {
  const resolved: TrafficPlan = { ...plan };
  if (plan.gsc) resolved.gsc = { ...plan.gsc, account: await resolveGoogleAccount(secrets, plan.gsc.account) };
  if (plan.ga4) resolved.ga4 = { ...plan.ga4, account: await resolveGoogleAccount(secrets, plan.ga4.account) };
  if (plan.bing) resolved.bing = { ...plan.bing, account: resolveBingAccount(plan.bing.account) };
  return resolved;
}

function rememberChoices(db: Db, plan: TrafficPlan): void {
  const startUrl = getMeta(db, 'start_url');
  if (!startUrl) return;
  updateConnections((data) => {
    const remembered = (data.lastUsed[siteHost(startUrl)] ??= {});
    if (plan.gsc?.account) remembered.gsc = { account: plan.gsc.account, property: plan.gsc.property };
    if (plan.ga4?.account) remembered.ga4 = { account: plan.ga4.account, property: plan.ga4.property };
    if (plan.bing?.account) remembered.bing = { account: plan.bing.account, property: plan.bing.site };
  });
}

/**
 * Runs each source on its own, so one failure doesn't lose the others, then rebuilds issues so they
 * can use the new data. It records failures rather than throwing, because the crawl itself succeeded.
 */
export async function runTrafficPlan(db: Db, secrets: SecretStore, plan: TrafficPlan, fetchImpl: typeof fetch = fetch): Promise<void> {
  setMeta(db, 'traffic_status', 'running');
  const step = async (source: string, account: string | undefined, property: string, days: number | null, call: () => Promise<unknown>) => {
    try {
      await call();
    } catch (error) {
      recordPullFailure(db, source, account ?? null, property, days, (error as Error).message);
    }
  };
  const { days, gsc, ga4, bing } = plan;
  if (gsc) {
    await step('gsc', gsc.account, gsc.property, days, () => importSearchConsole(db, secrets, gsc.property, days, fetchImpl, gsc.account));
    if (gsc.topQueries) await step('gsc_queries', gsc.account, gsc.property, days, () => importTopQueries(db, secrets, gsc.property, days, fetchImpl, gsc.account));
    if (gsc.inspect) await step('url_inspection', gsc.account, gsc.property, null, () => inspectUrls(db, secrets, gsc.property, gsc.inspect!.limit, fetchImpl, gsc.account));
  }
  if (ga4) {
    await step('ga4', ga4.account, ga4.property, days, () => importAnalytics(db, secrets, ga4.property, days, fetchImpl, ga4.account));
    await step('ai_referrals', ga4.account, ga4.property, days, () => importAiReferrals(db, secrets, ga4.property, days, fetchImpl, ga4.account));
  }
  if (bing) await step('bing', bing.account, bing.site, days, () => importBing(db, secrets, bing.site, days, fetchImpl, bing.account));
  try {
    rememberChoices(db, plan);
    runAnalysis(db);
    setMeta(db, 'traffic_status', 'finished');
  } catch (error) {
    setMeta(db, 'traffic_status', `failed: ${(error as Error).message}`);
  }
}

/** Saves a plan so a paused crawl can still run it when it finishes. */
export function saveTrafficPlan(db: Db, plan: TrafficPlan): void {
  setMeta(db, 'traffic_plan', JSON.stringify(plan));
  deleteMeta(db, 'traffic_plan_done');
}

export function readTrafficPlan(db: Db): TrafficPlan | null {
  const raw = getMeta(db, 'traffic_plan');
  return raw ? (JSON.parse(raw) as TrafficPlan) : null;
}

/** Runs the saved plan once, after the crawl has finished. Saving a new plan allows another run. */
export async function runSavedTrafficPlan(db: Db, secrets: SecretStore, fetchImpl: typeof fetch = fetch): Promise<void> {
  const plan = readTrafficPlan(db);
  if (!plan || getMeta(db, 'status') !== 'finished' || getMeta(db, 'traffic_plan_done')) return;
  setMeta(db, 'traffic_plan_done', new Date().toISOString());
  await runTrafficPlan(db, secrets, plan, fetchImpl);
}

/** Inspects more URLs with the saved property, without pulling the other data again. */
export async function inspectMore(db: Db, secrets: SecretStore, limit: number, fetchImpl: typeof fetch = fetch): Promise<void> {
  const gsc = readTrafficPlan(db)?.gsc;
  if (!gsc) throw new Error('This crawl has no Search Console property to inspect with');
  setMeta(db, 'traffic_status', 'running');
  try {
    await inspectUrls(db, secrets, gsc.property, limit, fetchImpl, gsc.account);
  } catch (error) {
    recordPullFailure(db, 'url_inspection', gsc.account ?? null, gsc.property, null, (error as Error).message);
  }
  runAnalysis(db);
  setMeta(db, 'traffic_status', 'finished');
}
