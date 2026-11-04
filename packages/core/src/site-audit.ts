import { createRequire } from 'node:module';
import type { Db } from './db.ts';
import { getMeta, setMeta } from './db.ts';
import type { SitemapReport } from './sitemap.ts';
import type { CrawlConfig } from './types.ts';

const require = createRequire(import.meta.url);
const robotsParser = require('robots-parser') as (url: string, body: string) => {
  isAllowed(url: string, ua?: string): boolean | undefined;
  getSitemaps(): string[];
};

export type AiBotPurpose = 'search' | 'user' | 'training';

/**
 * Search bots build an AI product's index and user bots fetch a page someone asked about, so blocking
 * either removes a site from answers. Blocking a training bot is a policy choice, so it raises no issue.
 */
export const AI_BOTS: { name: string; owner: string; purpose: AiBotPurpose }[] = [
  { name: 'OAI-SearchBot', owner: 'OpenAI', purpose: 'search' },
  { name: 'ChatGPT-User', owner: 'OpenAI', purpose: 'user' },
  { name: 'GPTBot', owner: 'OpenAI', purpose: 'training' },
  { name: 'Claude-SearchBot', owner: 'Anthropic', purpose: 'search' },
  { name: 'Claude-User', owner: 'Anthropic', purpose: 'user' },
  { name: 'ClaudeBot', owner: 'Anthropic', purpose: 'training' },
  { name: 'PerplexityBot', owner: 'Perplexity', purpose: 'search' },
  { name: 'Perplexity-User', owner: 'Perplexity', purpose: 'user' },
  { name: 'Google-Extended', owner: 'Google', purpose: 'training' },
  { name: 'Applebot-Extended', owner: 'Apple', purpose: 'training' },
  { name: 'CCBot', owner: 'Common Crawl', purpose: 'training' },
];

/**
 * The shared AI training preference from draft-kelley-aipref-training-preference-signal. It is a robots.txt
 * group, not a crawler: it states a preference for every participating provider, and the * group never counts.
 */
export const TRAINING_TOKEN = '__usage_ai-training';

export interface TrainingPreference {
  /** False when no group names the token, which expresses no preference. */
  declared: boolean;
  /** How much of the site the token opts out of training. Null when it isn't declared. */
  optOut: 'all' | 'some' | 'none' | null;
  /** User-agent values that look like the token but aren't it, so they state nothing. */
  misspelled: string[];
  /** Training bots named in their own group that answer the start URL differently. Their own rules win. */
  conflicts: { bot: string; owner: string; allowed: boolean }[];
}

interface RobotsGroup {
  agents: string[];
  rules: { allow: boolean; path: string }[];
}

/** RFC 9309 groups: consecutive user-agent lines share the rules that follow them. */
function robotsGroups(body: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  for (const raw of body.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*/, '');
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (!current || current.rules.length > 0) groups.push((current = { agents: [], rules: [] }));
      if (value) current.agents.push(value);
    } else if ((key === 'allow' || key === 'disallow') && current) {
      current.rules.push({ allow: key === 'allow', path: value });
    }
  }
  return groups;
}

/** Same normalising as robots-parser, so "Google-Extended/1.0" names Google-Extended. */
const agentKey = (agent: string) => agent.toLowerCase().split('/')[0].trim();

const LOOKS_LIKE_TOKEN = /ai[-_\s]*train|^_*usage[-_\s]*ai/i;

function readTrainingPreference(body: string, isAllowed: (agent: string) => boolean): TrainingPreference {
  const groups = robotsGroups(body);
  const named = new Set(groups.flatMap((g) => g.agents.map(agentKey)));
  const misspelled = [...new Set(groups.flatMap((g) => g.agents).filter((a) => agentKey(a) !== TRAINING_TOKEN && LOOKS_LIKE_TOKEN.test(a)))];
  if (!named.has(TRAINING_TOKEN)) return { declared: false, optOut: null, misspelled, conflicts: [] };

  const rules = groups.filter((g) => g.agents.some((a) => agentKey(a) === TRAINING_TOKEN)).flatMap((g) => g.rules).filter((r) => r.path);
  const disallowed = rules.filter((r) => !r.allow);
  const optOut = disallowed.length === 0 ? 'none' : disallowed.some((r) => /^\/\*?\$?$/.test(r.path)) && !rules.some((r) => r.allow) ? 'all' : 'some';
  const tokenAllows = isAllowed(TRAINING_TOKEN);
  const conflicts = AI_BOTS.filter((bot) => bot.purpose === 'training' && named.has(agentKey(bot.name)) && isAllowed(bot.name) !== tokenAllows)
    .map((bot) => ({ bot: bot.name, owner: bot.owner, allowed: !tokenAllows }));
  return { declared: true, optOut, misspelled, conflicts };
}

/** Blocking these also takes a site out of the AI features built on those search indexes. */
const SEARCH_BOTS = ['Googlebot', 'Bingbot'];

export interface ProbeResult {
  status: number | null;
  error: string | null;
  location: string | null;
}

export interface SiteAudit {
  robots: { url: string; status: number | null; error: string | null; sitemaps: number; blockedSearchBots: string[] };
  /** Null when the crawl was told not to use sitemaps. */
  sitemaps: { declared: string[]; reports: SitemapReport[] } | null;
  llms: { url: string; status: number | null; contentType: string | null; hasHeading: boolean };
  https: ProbeResult | null;
  hostTwin: (ProbeResult & { url: string }) | null;
  /** Missing on crawls saved before SAK read the shared training preference. */
  training?: TrainingPreference;
}

const probe = async (url: string, headers: Record<string, string>, timeoutMs: number, fetchImpl: typeof fetch, redirect: RequestRedirect = 'manual'): Promise<ProbeResult & { response?: Response }> => {
  try {
    const response = await fetchImpl(url, { headers, redirect, signal: AbortSignal.timeout(timeoutMs) });
    return { status: response.status, error: null, location: response.headers.get('location'), response };
  } catch (error) {
    return { status: null, error: (error as Error).message, location: null };
  }
};

const MAX_HTTP_HOPS = 4;

/** Follows http://a to http://www.a to https://www.a, because the site is judged on where HTTP ends up. */
async function httpOutcome(url: string, headers: Record<string, string>, timeoutMs: number, fetchImpl: typeof fetch): Promise<ProbeResult> {
  let current = strip(await probe(url, headers, timeoutMs, fetchImpl));
  let at = url;
  for (let hop = 0; hop < MAX_HTTP_HOPS && current.location && current.status !== null && current.status >= 300 && current.status < 400; hop++) {
    let next: URL;
    try {
      next = new URL(current.location, at);
    } catch {
      return current;
    }
    if (next.protocol === 'https:') return { ...current, location: next.href };
    at = next.href;
    current = strip(await probe(at, headers, timeoutMs, fetchImpl));
  }
  return current;
}

const strip = ({ status, error, location }: ProbeResult): ProbeResult => ({ status, error, location });

const isLocalHost = (host: string) => host === 'localhost' || host === '[::1]' || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.endsWith('.test') || host.endsWith('.localhost');

/** Reads the site-wide files and host variants a page crawl never asks for. Failures are findings, not errors. */
export async function collectSiteAudit(config: CrawlConfig, sitemaps: SiteAudit['sitemaps'], fetchImpl: typeof fetch = fetch): Promise<{ audit: SiteAudit; bots: { name: string; owner: string; purpose: string; robots_allowed: number | null; probe_status: number | null; probe_refused: number | null }[] }> {
  const start = new URL(config.startUrl);
  const headers = { ...config.headers, 'user-agent': config.userAgent };
  const robotsUrl = `${start.origin}/robots.txt`;
  // A robots.txt that redirects still counts, the same as when SAK reads it to crawl.
  const robots = await probe(robotsUrl, headers, config.timeoutMs, fetchImpl, 'follow');
  const body = robots.status === 200 && robots.response ? await robots.response.text().catch(() => '') : '';
  const parsed = robotsParser(robotsUrl, body);
  const allowed = (agent: string) => parsed.isAllowed(config.startUrl, agent) !== false;

  const llmsUrl = `${start.origin}/llms.txt`;
  const llms = await probe(llmsUrl, headers, config.timeoutMs, fetchImpl, 'follow');
  const llmsBody = llms.status === 200 && llms.response ? await llms.response.text().catch(() => '') : '';

  let https: ProbeResult | null = null;
  let hostTwin: SiteAudit['hostTwin'] = null;
  if (!isLocalHost(start.hostname)) {
    // Custom headers can hold credentials, so they don't go over plain HTTP or to another host.
    const anonymous = { 'user-agent': config.userAgent };
    if (start.protocol === 'https:') https = await httpOutcome(`http://${start.host}/`, anonymous, config.timeoutMs, fetchImpl);
    const twinHost = start.hostname.startsWith('www.') ? start.hostname.slice(4) : `www.${start.hostname}`;
    const twinUrl = `${start.protocol}//${twinHost}${start.port ? `:${start.port}` : ''}/`;
    hostTwin = { url: twinUrl, ...strip(await probe(twinUrl, anonymous, config.timeoutMs, fetchImpl)) };
  }

  const baseline = config.probeAiBots ? await probe(config.startUrl, headers, config.timeoutMs, fetchImpl) : null;
  const training = readTrainingPreference(body, allowed);
  const bots: Awaited<ReturnType<typeof collectSiteAudit>>['bots'] = [];
  for (const bot of AI_BOTS) {
    let probeStatus: number | null = null;
    let refused: number | null = null;
    if (baseline?.status !== undefined && baseline.status !== null && baseline.status < 400) {
      await new Promise((resolve) => setTimeout(resolve, 1000 / Math.max(config.requestsPerSecond, 0.5)));
      const answer = await probe(config.startUrl, { ...headers, 'user-agent': `Mozilla/5.0 (compatible; ${bot.name}/1.0)` }, config.timeoutMs, fetchImpl);
      probeStatus = answer.status;
      refused = answer.status !== null && answer.status >= 400 ? 1 : 0;
    }
    bots.push({ ...bot, robots_allowed: allowed(bot.name) ? 1 : 0, probe_status: probeStatus, probe_refused: refused });
  }
  // Listed beside the training bots so its answer is visible. A policy token has no user agent to probe.
  bots.push({ name: TRAINING_TOKEN, owner: 'Shared policy token', purpose: 'training', robots_allowed: training.declared ? (allowed(TRAINING_TOKEN) ? 1 : 0) : null, probe_status: null, probe_refused: null });

  return {
    audit: {
      robots: { url: robotsUrl, status: robots.status, error: robots.error, sitemaps: parsed.getSitemaps().length, blockedSearchBots: SEARCH_BOTS.filter((bot) => !allowed(bot)) },
      sitemaps,
      llms: { url: llmsUrl, status: llms.status, contentType: llms.response?.headers.get('content-type') ?? null, hasHeading: /^\s*#\s+\S/.test(llmsBody) },
      https,
      hostTwin,
      training,
    },
    bots,
  };
}

export function saveSiteAudit(db: Db, { audit, bots }: Awaited<ReturnType<typeof collectSiteAudit>>): void {
  db.transaction(() => {
    setMeta(db, 'site_audit', JSON.stringify(audit));
    db.exec('DELETE FROM ai_bots');
    const insert = db.prepare('INSERT INTO ai_bots (name, owner, purpose, robots_allowed, probe_status, probe_refused) VALUES (@name, @owner, @purpose, @robots_allowed, @probe_status, @probe_refused)');
    for (const bot of bots) insert.run(bot);
  })();
}

export function readSiteAudit(db: Db): SiteAudit | null {
  const raw = getMeta(db, 'site_audit');
  return raw ? (JSON.parse(raw) as SiteAudit) : null;
}
