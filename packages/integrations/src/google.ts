import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getMeta, normalizeUrl, type Db } from '@sak/core';
import type { SecretStore } from './secrets.ts';

const SCOPES = ['https://www.googleapis.com/auth/webmasters.readonly', 'https://www.googleapis.com/auth/analytics.readonly'];

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

/** Desktop OAuth with PKCE. The redirect comes back to a one-shot server on 127.0.0.1. */
export async function googleLogin(secrets: SecretStore, openBrowser: (url: string) => void, fetchImpl: typeof fetch = fetch): Promise<void> {
  const client = await readClient(secrets);
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('hex');

  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
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
  await secrets.set('google-tokens', JSON.stringify({ access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + data.expires_in * 1000 } satisfies Tokens));
}

async function accessToken(secrets: SecretStore, fetchImpl: typeof fetch): Promise<string> {
  const raw = await secrets.get('google-tokens');
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
  await secrets.set('google-tokens', JSON.stringify({ ...tokens, access_token: data.access_token, expires_at: Date.now() + data.expires_in * 1000 }));
  return data.access_token;
}

function dateRange(days: number) {
  // Search Console data lags by about two days.
  const end = new Date(Date.now() - 2 * 86_400_000);
  const start = new Date(end.getTime() - days * 86_400_000);
  const format = (d: Date) => d.toISOString().slice(0, 10);
  return { startDate: format(start), endDate: format(end) };
}

async function googleJson(url: string, token: string, body: unknown, fetchImpl: typeof fetch): Promise<any> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const data = (await response.json()) as any;
  if (!response.ok) throw new Error(`Google API error ${response.status}: ${data.error?.message ?? 'unknown'}`);
  return data;
}

export interface ImportResult {
  rows: number;
  matched: number;
  unmatched: number;
}

function crawledUrls(db: Db): Set<string> {
  return new Set((db.prepare(`SELECT url FROM urls WHERE kind = 'page'`).all() as { url: string }[]).map((r) => r.url));
}

export async function importSearchConsole(db: Db, secrets: SecretStore, property: string, days: number, fetchImpl: typeof fetch = fetch): Promise<ImportResult> {
  const token = await accessToken(secrets, fetchImpl);
  const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`;
  const rows: any[] = [];
  const rowLimit = 25_000;
  for (let startRow = 0; ; startRow += rowLimit) {
    const data = await googleJson(endpoint, token, { ...dateRange(days), dimensions: ['page'], rowLimit, startRow }, fetchImpl);
    rows.push(...(data.rows ?? []));
    if ((data.rows?.length ?? 0) < rowLimit) break;
  }
  const known = crawledUrls(db);
  let matched = 0;
  db.transaction(() => {
    db.exec('DELETE FROM search_console');
    const insert = db.prepare('INSERT OR REPLACE INTO search_console (url, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?)');
    for (const row of rows) {
      const url = normalizeUrl(row.keys[0]);
      if (!url) continue;
      if (known.has(url)) matched += 1;
      insert.run(url, row.clicks, row.impressions, row.ctr, row.position);
    }
  })();
  return { rows: rows.length, matched, unmatched: rows.length - matched };
}

export async function importAnalytics(db: Db, secrets: SecretStore, property: string, days: number, fetchImpl: typeof fetch = fetch): Promise<ImportResult> {
  const token = await accessToken(secrets, fetchImpl);
  const origin = new URL(getMeta(db, 'start_url') ?? '').origin;
  const endpoint = `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(property)}:runReport`;
  const rows: any[] = [];
  const limit = 25_000;
  for (let offset = 0; ; offset += limit) {
    const data = await googleJson(endpoint, token, {
      dateRanges: [dateRange(days)], dimensions: [{ name: 'pagePath' }], metrics: [{ name: 'sessions' }, { name: 'engagedSessions' }], limit, offset,
    }, fetchImpl);
    rows.push(...(data.rows ?? []));
    if (rows.length >= (data.rowCount ?? 0) || (data.rows?.length ?? 0) === 0) break;
  }
  const known = crawledUrls(db);
  let matched = 0;
  db.transaction(() => {
    db.exec('DELETE FROM analytics');
    const insert = db.prepare('INSERT OR REPLACE INTO analytics (url, sessions, engaged_sessions) VALUES (?, ?, ?)');
    for (const row of rows) {
      const url = normalizeUrl(row.dimensionValues[0].value, origin);
      if (!url) continue;
      if (known.has(url)) matched += 1;
      insert.run(url, Number(row.metricValues[0].value), Number(row.metricValues[1].value));
    }
  })();
  return { rows: rows.length, matched, unmatched: rows.length - matched };
}
