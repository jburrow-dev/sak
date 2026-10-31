import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Db } from '@sak/core';
import { LEGACY_GOOGLE_ACCOUNT, countInspections, googleTokensKey, inspectionsLeftToday, rememberGoogleAccount, resolveGoogleAccount } from './connections.ts';
import { ApiError, apiJson } from './http.ts';
import { crawlResolver, groupRows, weightedAverage } from './match.ts';
import { recordPull } from './pulls.ts';
import type { SecretStore } from './secrets.ts';

const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/webmasters.readonly', 'https://www.googleapis.com/auth/analytics.readonly'];
const LOGIN_TIMEOUT_MS = 5 * 60_000;

interface ClientCredentials {
  client_id: string;
  client_secret: string;
}

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

async function readClient(secrets: SecretStore): Promise<ClientCredentials> {
  const raw = await secrets.get('google-client');
  if (!raw) throw new Error('Google is not set up. Run: sak key set google-client (enter client_id:client_secret from a Desktop OAuth client)');
  const at = raw.indexOf(':');
  return { client_id: raw.slice(0, at), client_secret: raw.slice(at + 1) };
}

export interface LoginOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** The token came straight from Google over TLS, so its claims can be read without checking a signature. */
function emailFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null;
  try {
    return (JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8')) as { email?: string }).email ?? null;
  } catch {
    return null;
  }
}

/** Desktop OAuth with PKCE. The redirect comes back to a one-shot server on 127.0.0.1. Returns the account signed in to. */
export async function googleLogin(secrets: SecretStore, openBrowser: (url: string) => void, fetchImpl: typeof fetch = fetch, options: LoginOptions = {}): Promise<string> {
  const client = await readClient(secrets);
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('hex');

  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    const giveUp = (message: string) => {
      server.close();
      reject(new Error(message));
    };
    const timer = setTimeout(() => giveUp('Google sign-in timed out. Please try again.'), options.timeoutMs ?? LOGIN_TIMEOUT_MS);
    const onAbort = () => giveUp('Google sign-in was cancelled.');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const receivedCode = url.searchParams.get('code');
      const ok = url.searchParams.get('state') === state && receivedCode;
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain' }).end(ok ? 'SAK is connected. You can close this tab.' : 'Sign-in failed.');
      server.close();
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (ok) resolve({ code: receivedCode!, redirectUri });
      else reject(new Error(`Google sign-in failed: ${url.searchParams.get('error') ?? 'state mismatch'}`));
    });
    let redirectUri = '';
    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      auth.search = new URLSearchParams({
        client_id: client.client_id, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent',
        state, code_challenge: challenge, code_challenge_method: 'S256',
      }).toString();
      openBrowser(auth.toString());
    });
  });

  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...client, code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });
  const data = (await response.json()) as any;
  if (!response.ok) throw new Error(`Google token exchange failed: ${data.error_description ?? data.error}`);
  const account = emailFromIdToken(data.id_token) ?? LEGACY_GOOGLE_ACCOUNT;
  await secrets.set(googleTokensKey(account), JSON.stringify({ access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + data.expires_in * 1000 } satisfies Tokens));
  await rememberGoogleAccount(secrets, account);
  return account;
}

async function accessToken(secrets: SecretStore, account: string, fetchImpl: typeof fetch): Promise<string> {
  const key = googleTokensKey(account);
  const raw = await secrets.get(key);
  if (!raw) throw new Error('Not signed in to Google. Run: sak google login');
  const tokens = JSON.parse(raw) as Tokens;
  if (tokens.expires_at > Date.now() + 60_000) return tokens.access_token;
  const client = await readClient(secrets);
  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...client, refresh_token: tokens.refresh_token, grant_type: 'refresh_token' }),
  });
  const data = (await response.json()) as any;
  if (!response.ok) throw new Error(`Google sign-in expired (${data.error}). Run: sak google login`);
  await secrets.set(key, JSON.stringify({ ...tokens, access_token: data.access_token, expires_at: Date.now() + data.expires_in * 1000 }));
  return data.access_token;
}

const DAY_MS = 86_400_000;

/** Exactly `days` days, ending two days ago, because Search Console and GA4 data arrive late. */
export function dateWindow(days: number, now: Date = new Date()): { startDate: string; endDate: string } {
  const end = new Date(now.getTime() - 2 * DAY_MS);
  const start = new Date(end.getTime() - (days - 1) * DAY_MS);
  const format = (d: Date) => d.toISOString().slice(0, 10);
  return { startDate: format(start), endDate: format(end) };
}

const googleGet = (url: string, token: string, label: string, fetchImpl: typeof fetch) => apiJson(url, { headers: { authorization: `Bearer ${token}` } }, { label, fetchImpl });
const googlePost = (url: string, token: string, body: unknown, label: string, fetchImpl: typeof fetch) => apiJson(url, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
}, { label, fetchImpl });

const GSC_LABEL = 'Search Console';
const GA4_LABEL = 'GA4';
const searchAnalyticsUrl = (property: string) => `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`;

export interface ImportResult {
  rows: number;
  matched: number;
  unmatched: number;
  dropped: number;
}

export interface PropertyOption {
  id: string;
  label: string;
}

export async function listSearchConsoleProperties(secrets: SecretStore, account?: string, fetchImpl: typeof fetch = fetch): Promise<PropertyOption[]> {
  const token = await accessToken(secrets, await resolveGoogleAccount(secrets, account), fetchImpl);
  const data = await googleGet('https://www.googleapis.com/webmasters/v3/sites', token, GSC_LABEL, fetchImpl);
  return (data.siteEntry ?? [])
    .filter((site: any) => site.permissionLevel !== 'siteUnverifiedUser')
    .map((site: any) => ({ id: site.siteUrl, label: site.siteUrl }));
}

export async function listAnalyticsProperties(secrets: SecretStore, account?: string, fetchImpl: typeof fetch = fetch): Promise<PropertyOption[]> {
  const token = await accessToken(secrets, await resolveGoogleAccount(secrets, account), fetchImpl);
  const properties: PropertyOption[] = [];
  let pageToken = '';
  do {
    const query = new URLSearchParams({ pageSize: '200', ...(pageToken ? { pageToken } : {}) });
    const data = await googleGet(`https://analyticsadmin.googleapis.com/v1beta/accountSummaries?${query}`, token, 'GA4 Admin API', fetchImpl);
    for (const summary of data.accountSummaries ?? []) {
      for (const property of summary.propertySummaries ?? []) {
        const id = String(property.property).replace(/^properties\//, '');
        properties.push({ id, label: `${property.displayName} (${summary.displayName}, ${id})` });
      }
    }
    pageToken = data.nextPageToken ?? '';
  } while (pageToken);
  return properties;
}

const toPullDates = (window: { startDate: string; endDate: string }) => ({ startDate: window.startDate, endDate: window.endDate });

export async function importSearchConsole(db: Db, secrets: SecretStore, property: string, days: number, fetchImpl: typeof fetch = fetch, account?: string): Promise<ImportResult> {
  const chosen = await resolveGoogleAccount(secrets, account);
  const token = await accessToken(secrets, chosen, fetchImpl);
  const window = dateWindow(days);
  const rows: any[] = [];
  const rowLimit = 25_000;
  for (let startRow = 0; ; startRow += rowLimit) {
    const data = await googlePost(searchAnalyticsUrl(property), token, { ...window, dimensions: ['page'], rowLimit, startRow }, GSC_LABEL, fetchImpl);
    rows.push(...(data.rows ?? []));
    if ((data.rows?.length ?? 0) < rowLimit) break;
  }
  const grouped = groupRows(rows, (row) => row.keys[0], crawlResolver(db), (row) => ({ clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position }), (bucket, row) => {
    bucket.position = weightedAverage(bucket.position, bucket.impressions, row.position, row.impressions);
    bucket.clicks += row.clicks;
    bucket.impressions += row.impressions;
    bucket.ctr = bucket.impressions > 0 ? bucket.clicks / bucket.impressions : 0;
  });
  db.transaction(() => {
    db.exec('DELETE FROM search_console');
    const insert = db.prepare('INSERT INTO search_console (url, clicks, impressions, ctr, position, source_url) VALUES (?, ?, ?, ?, ?, ?)');
    for (const [url, { bucket, source }] of grouped.groups) insert.run(url, bucket.clicks, bucket.impressions, bucket.ctr, bucket.position, source);
    recordPull(db, { source: 'gsc', account: chosen, property, days, ...toPullDates(window), rows: rows.length, matched: grouped.matched, dropped: grouped.dropped });
  })();
  return { rows: rows.length, matched: grouped.matched, unmatched: grouped.unmatched, dropped: grouped.dropped };
}

const gaUrl = (host: string, path: string) => (host && host !== '(not set)' && path.startsWith('/') ? `https://${host}${path}` : null);

export async function importAnalytics(db: Db, secrets: SecretStore, property: string, days: number, fetchImpl: typeof fetch = fetch, account?: string): Promise<ImportResult> {
  const chosen = await resolveGoogleAccount(secrets, account);
  const token = await accessToken(secrets, chosen, fetchImpl);
  const endpoint = `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(property)}:runReport`;
  const window = dateWindow(days);
  const rows: any[] = [];
  const limit = 25_000;
  for (let offset = 0; ; offset += limit) {
    const data = await googlePost(endpoint, token, {
      dateRanges: [window],
      // pagePath alone would credit every subdomain's traffic to the start URL's host.
      dimensions: [{ name: 'hostName' }, { name: 'pagePath' }],
      metrics: [{ name: 'sessions' }, { name: 'engagedSessions' }, { name: 'totalUsers' }, { name: 'screenPageViews' }, { name: 'keyEvents' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit,
      offset,
    }, GA4_LABEL, fetchImpl);
    rows.push(...(data.rows ?? []));
    if (rows.length >= (data.rowCount ?? 0) || (data.rows?.length ?? 0) === 0) break;
  }
  const metrics = (row: any) => row.metricValues.map((m: any) => Number(m.value)) as number[];
  const grouped = groupRows(rows, (row) => gaUrl(row.dimensionValues[0].value, row.dimensionValues[1].value), crawlResolver(db), metrics, (bucket, row) => {
    metrics(row).forEach((value, i) => { bucket[i] += value; });
  });
  db.transaction(() => {
    db.exec('DELETE FROM analytics');
    const insert = db.prepare('INSERT INTO analytics (url, sessions, engaged_sessions, users, views, key_events, source_url) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const [url, { bucket, source }] of grouped.groups) insert.run(url, bucket[0], bucket[1], bucket[2], bucket[3], bucket[4], source);
    recordPull(db, { source: 'ga4', account: chosen, property, days, ...toPullDates(window), rows: rows.length, matched: grouped.matched, dropped: grouped.dropped });
  })();
  return { rows: rows.length, matched: grouped.matched, unmatched: grouped.unmatched, dropped: grouped.dropped };
}

export const MAX_QUERY_ROWS = 200_000;
export const QUERIES_PER_PAGE = 10;

/** Asks for page and query together, which Google says is its most expensive report, so it is capped. */
export async function importTopQueries(db: Db, secrets: SecretStore, property: string, days: number, fetchImpl: typeof fetch = fetch, account?: string): Promise<ImportResult> {
  const chosen = await resolveGoogleAccount(secrets, account);
  const token = await accessToken(secrets, chosen, fetchImpl);
  const window = dateWindow(days);
  const resolve = crawlResolver(db);
  const byPage = new Map<string, Map<string, { clicks: number; impressions: number; position: number }>>();
  let rows = 0;
  let matched = 0;
  let dropped = 0;
  const rowLimit = 25_000;
  for (let startRow = 0; rows < MAX_QUERY_ROWS; startRow += rowLimit) {
    const data = await googlePost(searchAnalyticsUrl(property), token, { ...window, dimensions: ['page', 'query'], rowLimit, startRow }, GSC_LABEL, fetchImpl);
    for (const row of data.rows ?? []) {
      rows += 1;
      const resolved = resolve(row.keys[0]);
      if (!resolved) dropped += 1;
      if (!resolved?.matched) continue;
      matched += 1;
      if (!byPage.has(resolved.url)) byPage.set(resolved.url, new Map());
      const queries = byPage.get(resolved.url)!;
      const seen = queries.get(row.keys[1]);
      if (!seen) {
        queries.set(row.keys[1], { clicks: row.clicks, impressions: row.impressions, position: row.position });
      } else {
        seen.position = weightedAverage(seen.position, seen.impressions, row.position, row.impressions);
        seen.clicks += row.clicks;
        seen.impressions += row.impressions;
      }
    }
    if ((data.rows?.length ?? 0) < rowLimit) break;
  }
  db.transaction(() => {
    db.exec('DELETE FROM gsc_queries');
    const insert = db.prepare('INSERT INTO gsc_queries (url, query, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?, ?)');
    for (const [url, queries] of byPage) {
      const top = [...queries].sort(([, a], [, b]) => b.clicks - a.clicks || b.impressions - a.impressions).slice(0, QUERIES_PER_PAGE);
      for (const [query, q] of top) insert.run(url, query, q.clicks, q.impressions, q.impressions > 0 ? q.clicks / q.impressions : 0, q.position);
    }
    const capped = rows >= MAX_QUERY_ROWS ? ` Stopped at ${MAX_QUERY_ROWS.toLocaleString('en-US')} rows, so quieter pages may be missing.` : '';
    recordPull(db, { source: 'gsc_queries', account: chosen, property, days, ...toPullDates(window), rows, matched, dropped, note: `Top ${QUERIES_PER_PAGE} per page. Google leaves out rare queries, so these won't add up to the page totals.${capped}` });
  })();
  return { rows, matched, unmatched: rows - matched - dropped, dropped };
}

export const DEFAULT_INSPECTIONS = 500;
const INSPECTION_DELAY_MS = 110; // About 545 a minute, under Google's 600.
const INSPECTION_SAVE_EVERY = 25;

export interface InspectResult {
  inspected: number;
  failed: number;
  remaining: number;
  stoppedBy: string | null;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Continues from where it left off, so running it again inspects URLs it has not reached yet. */
export async function inspectUrls(db: Db, secrets: SecretStore, property: string, limit: number = DEFAULT_INSPECTIONS, fetchImpl: typeof fetch = fetch, account?: string, delayMs: number = INSPECTION_DELAY_MS): Promise<InspectResult> {
  const chosen = await resolveGoogleAccount(secrets, account);
  const candidates = db.prepare(`SELECT u.url FROM urls u JOIN responses r ON r.url_id = u.id LEFT JOIN search_console sc ON sc.url = u.url
    WHERE u.kind = 'page' AND r.status = 200 AND u.url NOT IN (SELECT url FROM url_inspection WHERE error IS NULL)
    ORDER BY u.indexable = 1 DESC, COALESCE(sc.clicks, 0) DESC, u.depth ASC NULLS LAST, u.id`).all() as { url: string }[];
  const allowed = Math.min(limit, inspectionsLeftToday(property));
  const save = db.prepare(`INSERT OR REPLACE INTO url_inspection (url, verdict, coverage_state, indexing_state, robots_state, page_fetch_state, last_crawl_time, google_canonical, user_canonical, error, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let inspected = 0;
  let failed = 0;
  let unsaved = 0;
  let stoppedBy: string | null = allowed <= 0 ? `Google's limit of 2,000 inspections a day for this property has been reached.` : null;
  try {
    for (const { url } of candidates.slice(0, Math.max(allowed, 0))) {
      if (inspected + failed > 0) await wait(delayMs);
      const at = new Date().toISOString();
      // Outside the try, because an expired sign-in isn't a problem with this one URL.
      const token = await accessToken(secrets, chosen, fetchImpl);
      try {
        const data = await googlePost('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', token, { inspectionUrl: url, siteUrl: property }, 'URL Inspection', fetchImpl);
        const result = data.inspectionResult?.indexStatusResult ?? {};
        save.run(url, result.verdict ?? null, result.coverageState ?? null, result.indexingState ?? null, result.robotsTxtState ?? null, result.pageFetchState ?? null, result.lastCrawlTime ?? null, result.googleCanonical ?? null, result.userCanonical ?? null, null, at);
        inspected += 1;
      } catch (error) {
        // These apply to the whole property, so every other URL would fail the same way.
        if (error instanceof ApiError && [401, 403, 429].includes(error.status)) {
          stoppedBy = error.message;
          break;
        }
        save.run(url, null, null, null, null, null, null, null, null, (error as Error).message, at);
        failed += 1;
      }
      unsaved += 1;
      if (unsaved >= INSPECTION_SAVE_EVERY) {
        countInspections(property, unsaved);
        unsaved = 0;
      }
    }
  } finally {
    countInspections(property, unsaved);
  }
  const { n: total } = db.prepare('SELECT COUNT(*) AS n FROM url_inspection WHERE error IS NULL').get() as { n: number };
  const remaining = candidates.length - inspected;
  recordPull(db, { source: 'url_inspection', account: chosen, property, days: null, startDate: null, endDate: null, rows: total, matched: total, dropped: 0, note: `${total} URLs inspected, ${remaining} not yet.${stoppedBy ? ` ${stoppedBy}` : ''}` });
  return { inspected, failed, remaining, stoppedBy };
}
