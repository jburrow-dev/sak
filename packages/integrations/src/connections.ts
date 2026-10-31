import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sakHome } from '@sak/core';
import { apiJson } from './http.ts';
import type { SecretStore } from './secrets.ts';

export type TrafficSource = 'gsc' | 'ga4' | 'bing';

/** Holds no secrets. Those stay in the SecretStore, under one key per account. */
export interface ConnectionsData {
  google: string[];
  bing: string[];
  lastUsed: Record<string, Partial<Record<TrafficSource, { account: string; property: string }>>>;
  inspections: Record<string, { date: string; count: number }>;
}

const empty = (): ConnectionsData => ({ google: [], bing: [], lastUsed: {}, inspections: {} });
const path = () => join(sakHome(), 'connections.json');

export function readConnections(): ConnectionsData {
  try {
    return { ...empty(), ...(JSON.parse(readFileSync(path(), 'utf8')) as Partial<ConnectionsData>) };
  } catch {
    return empty();
  }
}

export function updateConnections(change: (data: ConnectionsData) => void): ConnectionsData {
  const data = readConnections();
  change(data);
  mkdirSync(sakHome(), { recursive: true });
  writeFileSync(`${path()}.tmp`, JSON.stringify(data, null, 2));
  renameSync(`${path()}.tmp`, path());
  return data;
}

/** A sign-in saved before accounts existed. It works until the next sign-in replaces it. */
export const LEGACY_GOOGLE_ACCOUNT = 'default';
const LEGACY_TOKENS = 'google-tokens';

export const googleTokensKey = (account: string) => (account === LEGACY_GOOGLE_ACCOUNT ? LEGACY_TOKENS : `google-tokens:${account}`);
const bingKeyName = (account: string) => `bing-key:${account}`;

export async function googleAccounts(secrets: SecretStore): Promise<string[]> {
  const named = readConnections().google;
  return (await secrets.get(LEGACY_TOKENS)) ? [LEGACY_GOOGLE_ACCOUNT, ...named] : named;
}

function pickAccount(accounts: string[], account: string | undefined, service: string, setup: string): string {
  if (account) {
    if (!accounts.includes(account)) throw new Error(`${service} account ${account} is not connected. ${setup}`);
    return account;
  }
  if (accounts.length === 0) throw new Error(`Not signed in to ${service}. ${setup}`);
  if (accounts.length > 1) throw new Error(`Several ${service} accounts are connected, so choose one: ${accounts.join(', ')}`);
  return accounts[0];
}

export async function resolveGoogleAccount(secrets: SecretStore, account?: string): Promise<string> {
  return pickAccount(await googleAccounts(secrets), account, 'Google', 'Run: sak google login');
}

export function resolveBingAccount(account?: string): string {
  return pickAccount(readConnections().bing, account, 'Bing', 'Run: sak bing key add');
}

export async function rememberGoogleAccount(secrets: SecretStore, account: string): Promise<void> {
  if (account === LEGACY_GOOGLE_ACCOUNT) return;
  updateConnections((data) => {
    if (!data.google.includes(account)) data.google.push(account);
  });
  await secrets.delete(LEGACY_TOKENS);
}

/** Revoking can fail if the token has already expired, and the local copy should go either way. */
export async function disconnectGoogle(secrets: SecretStore, account: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const key = googleTokensKey(account);
  const raw = await secrets.get(key);
  if (raw) {
    try {
      const token = (JSON.parse(raw) as { refresh_token?: string }).refresh_token;
      if (token) await fetchImpl('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }), signal: AbortSignal.timeout(15_000) });
    } catch {
      // Nothing more can be done from here. The user can still revoke access in their Google account.
    }
  }
  await secrets.delete(key);
  updateConnections((data) => { data.google = data.google.filter((a) => a !== account); });
}

const BING_API = 'https://ssl.bing.com/webmaster/api.svc/json';

export async function bingCall(secrets: SecretStore, account: string, method: string, params: Record<string, string> = {}, fetchImpl: typeof fetch = fetch): Promise<any> {
  const key = await secrets.get(bingKeyName(account));
  if (!key) throw new Error(`Bing account ${account} has no saved API key. Run: sak bing key add`);
  return bingRequest(key, method, params, fetchImpl);
}

async function bingRequest(key: string, method: string, params: Record<string, string>, fetchImpl: typeof fetch): Promise<any> {
  const query = new URLSearchParams({ ...params, apikey: key });
  const data = await apiJson(`${BING_API}/${method}?${query}`, { method: 'GET' }, { label: 'Bing Webmaster API', fetchImpl });
  return data.d;
}

/** Tries the key first, so a mistyped one is never saved. */
export async function addBingKey(secrets: SecretStore, label: string, key: string, fetchImpl: typeof fetch = fetch): Promise<{ sites: number }> {
  const name = label.trim();
  if (!name) throw new Error('Give this Bing key a name');
  if (/[/\r\n]/.test(name)) throw new Error('A Bing key name cannot contain a slash or a line break');
  const sites = await bingRequest(key.trim(), 'GetUserSites', {}, fetchImpl);
  await secrets.set(bingKeyName(name), key.trim());
  updateConnections((data) => {
    if (!data.bing.includes(name)) data.bing.push(name);
  });
  return { sites: Array.isArray(sites) ? sites.length : 0 };
}

export async function removeBingKey(secrets: SecretStore, label: string): Promise<void> {
  await secrets.delete(bingKeyName(label));
  updateConnections((data) => { data.bing = data.bing.filter((a) => a !== label); });
}

export const INSPECTIONS_PER_DAY = 2000;

const today = () => new Date().toISOString().slice(0, 10);

export function inspectionsLeftToday(property: string): number {
  const used = readConnections().inspections[property];
  return INSPECTIONS_PER_DAY - (used?.date === today() ? used.count : 0);
}

export function countInspections(property: string, count: number): void {
  if (count === 0) return;
  updateConnections((data) => {
    const used = data.inspections[property];
    data.inspections[property] = { date: today(), count: (used?.date === today() ? used.count : 0) + count };
  });
}
