import { ApiCache, type CachedResponse } from './cache.ts';
import type { SecretStore } from './secrets.ts';

const API = 'https://api.dataforseo.com/v3/';

// Published or documented sample prices, used only to warn before spending.
// The amount actually charged comes from each response's cost field.
export const ESTIMATED_COST = {
  keywordVolume: 0.09, // per request, up to 1,000 keywords
  backlinkSummary: 0.02, // per request
  rankCheck: 0.003, // per keyword, top 10 results
};

export class CostConfirmationRequired extends Error {
  estimate: number;
  constructor(estimate: number, what: string) {
    super(`${what} will cost about $${estimate.toFixed(3)}. Confirm to continue.`);
    this.estimate = estimate;
  }
}

interface CallOptions {
  refresh?: boolean;
  confirmed?: boolean;
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

  constructor(secrets: SecretStore, cache: ApiCache, fetchImpl: typeof fetch = fetch) {
    this.secrets = secrets;
    this.cache = cache;
    this.fetchImpl = fetchImpl;
  }

  private async authHeader(): Promise<string> {
    const credentials = await this.secrets.get('dataforseo');
    if (!credentials) throw new Error('DataForSEO is not set up. Run: sak key set dataforseo (enter login:password)');
    return `Basic ${dataForSeoBasicToken(credentials)}`;
  }

  private async post(endpoint: string, task: Record<string, unknown>): Promise<{ result: any[]; cost: number }> {
    const response = await this.fetchImpl(API + endpoint, {
      method: 'POST',
      headers: { authorization: await this.authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify([task]),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`DataForSEO HTTP ${response.status}`);
    const data = (await response.json()) as any;
    if (data.status_code !== 20000) throw new Error(`DataForSEO error ${data.status_code}: ${data.status_message}`);
    const taskResult = data.tasks?.[0];
    if (taskResult?.status_code !== 20000) throw new Error(`DataForSEO task error ${taskResult?.status_code}: ${taskResult?.status_message}`);
    return { result: taskResult.result ?? [], cost: Number(data.cost ?? 0) };
  }

  /** Cache first; on a miss, spend only if confirmed. Failed calls are never cached. */
  private async cached<T>(endpoint: string, task: Record<string, unknown>, estimate: number, label: string, options: CallOptions, transform: (result: any[]) => T): Promise<CachedResponse<T>> {
    if (!options.refresh) {
      const hit = this.cache.get<T>(endpoint, task);
      if (hit) return hit;
    }
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
    const tasks = keywords.map((keyword) => ({ keyword, location_code: where.location, language_code: where.language, depth: 10 }));
    const endpoint = 'serp/google/organic/live/regular';
    const misses = options.refresh ? tasks.length : tasks.filter((task) => !this.cache.get(endpoint, { ...task, domain })).length;
    if (misses > 0 && !options.confirmed) throw new CostConfirmationRequired(misses * ESTIMATED_COST.rankCheck, `Rank check for ${misses} uncached keywords`);
    const bare = domain.replace(/^www\./, '').toLowerCase();
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
    const match = items.find((item) => item.type === 'organic' && (item.domain === bare || String(item.domain).endsWith(`.${bare}`)));
    const value: RankRow = { keyword: String(task.keyword), position: match?.rank_group ?? null, url: match?.url ?? null };
    this.cache.put(endpoint, key, value, cost);
    return { value, cost };
  }

  /** Reads the account balance. This endpoint doesn't charge. */
  async balance(): Promise<number | null> {
    const response = await this.fetchImpl(`${API}appendix/user_data`, { headers: { authorization: await this.authHeader() }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`DataForSEO HTTP ${response.status}`);
    const data = (await response.json()) as any;
    return data.tasks?.[0]?.result?.[0]?.money?.balance ?? null;
  }
}
