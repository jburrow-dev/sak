import type { Db } from '@sak/core';
import { CostConfirmationRequired, ESTIMATED_COST, bareDomain, hostOf, isDomain, type DataForSeo, type LlmEngine } from './dataforseo.ts';
import { crawlResolver } from './match.ts';

/** The most fan-out queries rank-checked for one prompt, so the cost has a ceiling before the prompt has run. */
export const FUNNEL_FAN_OUT_LIMIT = 10;
export const FUNNEL_PROMPT_LIMIT = 50;

/**
 * The first step a domain fails at, in the order an AI answer is built.
 * no_search: the model answered from memory in every sample, so no page could have been cited.
 */
export const FUNNEL_STAGES = ['no_search', 'not_ranked', 'not_retrieved', 'not_cited', 'cited'] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export interface FunnelOptions {
  engine: LlmEngine;
  model: string;
  samples?: number;
  /** Check Google's top 10 for each fan-out query. A stand-in, since not every engine searches Google. */
  rank?: boolean;
  location?: number;
  language?: string;
}

export interface FunnelRow {
  prompt: string;
  engine: LlmEngine;
  model: string;
  samples: number;
  /** Samples that cited any source at all. */
  with_sources: number;
  fan_out: { query: string; position: number | null; url: string | null }[];
  /** Fan-out queries where the domain is in Google's top 10. Null when they weren't checked or the engine listed none. */
  ranked_for: number | null;
  /** Samples whose search returned one of the domain's pages. Null when the engine doesn't list what it retrieved. */
  retrieved_in: number | null;
  cited_in: number;
  stage: FunnelStage;
  own_retrieved: string[];
  own_cited: string[];
  /** Other domains, by how many samples cited them. */
  cited_instead: { domain: string; samples: number }[];
}

export interface FunnelResult {
  rows: FunnelRow[];
  by_stage: Record<FunnelStage, number>;
}

export function estimateFunnel(prompts: number, samples = 3, rank = true): number {
  return prompts * (samples * ESTIMATED_COST.llmPrompt + (rank ? FUNNEL_FAN_OUT_LIMIT * ESTIMATED_COST.rankCheck : 0));
}

export function funnelStage(row: Pick<FunnelRow, 'with_sources' | 'fan_out' | 'ranked_for' | 'retrieved_in' | 'cited_in'>): FunnelStage {
  if (row.cited_in > 0) return 'cited';
  if (row.with_sources === 0 && row.retrieved_in === null && row.fan_out.length === 0) return 'no_search';
  if (row.retrieved_in) return 'not_cited';
  if (row.ranked_for === 0) return 'not_ranked';
  // Without a retrieved list there's no telling whether the page was fetched and passed over, or never fetched.
  return row.retrieved_in === 0 ? 'not_retrieved' : 'not_cited';
}

const fanOutOf = (queries: string[]) => {
  const seen = new Set<string>();
  return queries.map((query) => query.trim()).filter((query) => query && !seen.has(query.toLowerCase()) && seen.add(query.toLowerCase())).slice(0, FUNNEL_FAN_OUT_LIMIT);
};

/**
 * Follows each prompt through one engine: the searches it ran, whether the domain ranks for them,
 * whether its pages were retrieved, and whether they were cited. The whole cost is put to the user once.
 */
export async function aiFunnel(client: DataForSeo, domain: string, prompts: string[], settings: FunnelOptions, options: { confirmed?: boolean; refresh?: boolean } = {}): Promise<{ value: FunnelResult; cost: number }> {
  const samples = settings.samples ?? 3;
  const rank = settings.rank ?? true;
  const where = { location: settings.location ?? 2840, language: settings.language ?? 'en' };
  const list = [...new Set(prompts.map((prompt) => prompt.trim()).filter(Boolean))];
  if (list.length === 0 || list.length > FUNNEL_PROMPT_LIMIT) throw new Error(`Provide between 1 and ${FUNNEL_PROMPT_LIMIT} prompts`);
  const long = list.find((prompt) => prompt.length > 500);
  if (long) throw new Error(`A prompt can be up to 500 characters: ${long.slice(0, 60)}…`);
  if (samples < 1 || samples > 10) throw new Error('Ask for 1 to 10 samples');
  const look = { domain };

  let estimate = 0;
  for (const prompt of list) {
    const misses = client.llmPromptMisses(settings.engine, prompt, settings.model, samples, options);
    estimate += misses * ESTIMATED_COST.llmPrompt;
    if (!rank) continue;
    // Until the prompt has run, its fan-out queries are unknown, so the ceiling is quoted.
    if (misses > 0) estimate += FUNNEL_FAN_OUT_LIMIT * ESTIMATED_COST.rankCheck;
    else {
      const known = fanOutOf((await client.llmPrompt(settings.engine, prompt, settings.model, look, samples)).value.fan_out_queries);
      estimate += (options.refresh ? known.length : client.rankMisses(domain, known, where)) * ESTIMATED_COST.rankCheck;
    }
  }
  if (estimate > 0) {
    client.checkSpend(estimate);
    if (!options.confirmed) throw new CostConfirmationRequired(estimate, `AI funnel for ${list.length} ${list.length === 1 ? 'prompt' : 'prompts'} on ${settings.engine}`);
  }

  const bare = bareDomain(domain);
  const own = (url: string) => isDomain(hostOf(url), bare);
  const unique = (urls: string[]) => [...new Set(urls)];
  const paid = { confirmed: true, refresh: options.refresh };
  const rows: FunnelRow[] = [];
  let cost = 0;
  for (const prompt of list) {
    const answer = await client.llmPrompt(settings.engine, prompt, settings.model, look, samples, paid);
    cost += answer.cost;
    const queries = fanOutOf(answer.value.fan_out_queries);
    let fanOut: FunnelRow['fan_out'] = queries.map((query) => ({ query, position: null, url: null }));
    if (rank && queries.length > 0) {
      const ranks = await client.rankCheck(domain, queries, where, paid);
      cost += ranks.cost;
      fanOut = ranks.value.map((row) => ({ query: row.keyword, position: row.position, url: row.url }));
    }
    const { answers } = answer.value;
    const citing = new Map<string, number>();
    for (const sample of answers) {
      for (const host of new Set(sample.cited.map((url) => hostOf(url)).filter((host): host is string => Boolean(host)).map(bareDomain))) {
        if (!isDomain(host, bare)) citing.set(host, (citing.get(host) ?? 0) + 1);
      }
    }
    const counts = {
      with_sources: answer.value.with_sources,
      fan_out: fanOut,
      ranked_for: rank && queries.length > 0 ? fanOut.filter((row) => row.position !== null).length : null,
      retrieved_in: answer.value.retrieved_reported > 0 ? answer.value.retrieved_in : null,
      cited_in: answer.value.cited_in,
    };
    rows.push({
      prompt, engine: settings.engine, model: settings.model, samples: answer.value.samples, ...counts,
      stage: funnelStage(counts),
      own_retrieved: unique(answers.flatMap((sample) => sample.retrieved ?? []).filter(own)),
      own_cited: unique(answers.flatMap((sample) => sample.cited).filter(own)),
      cited_instead: [...citing].map(([host, count]) => ({ domain: host, samples: count })).sort((a, b) => b.samples - a.samples || a.domain.localeCompare(b.domain)).slice(0, 10),
    });
  }
  const by_stage = Object.fromEntries(FUNNEL_STAGES.map((stage) => [stage, rows.filter((row) => row.stage === stage).length])) as Record<FunnelStage, number>;
  return { value: { rows, by_stage }, cost };
}

/** Keeps the rows with a crawl, and lists the domain's cited pages beside its other AI citations. */
export function storeFunnel(db: Db, rows: FunnelRow[]): void {
  const resolve = crawlResolver(db);
  const at = new Date().toISOString();
  const save = db.prepare(`INSERT OR REPLACE INTO ai_funnel (prompt, engine, model, samples, with_sources, fan_out, ranked_for, retrieved_in, cited_in, stage, fan_out_queries, own_urls, cited_instead, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const cite = db.prepare('INSERT OR REPLACE INTO ai_citations (url, engine, subject, volume) VALUES (?, ?, ?, NULL)');
  db.transaction(() => {
    for (const row of rows) {
      const ownUrls = [...new Set([...row.own_cited, ...row.own_retrieved])].map((url) => resolve(url)?.url ?? url);
      save.run(row.prompt, row.engine, row.model, row.samples, row.with_sources, row.fan_out.length, row.ranked_for, row.retrieved_in, row.cited_in, row.stage,
        row.fan_out.map((item) => (item.position ? `${item.query} (#${item.position})` : item.query)).join('; '), ownUrls.join(' '), row.cited_instead.map((item) => item.domain).join(', '), at);
      for (const url of row.own_cited) cite.run(resolve(url)?.url ?? url, row.engine, row.prompt);
    }
  })();
}
