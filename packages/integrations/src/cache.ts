import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database, sakHome, type Db } from '@sak/core';

export interface CachedResponse<T> {
  value: T;
  cost: number;
  cached: boolean;
  fetchedAt: string;
}

/** Paid responses, shared across crawls. Every charge is also written to a ledger. */
export class ApiCache {
  private db: Db;

  constructor(path?: string) {
    if (!path) mkdirSync(sakHome(), { recursive: true });
    this.db = new Database(path ?? join(sakHome(), 'api_cache.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_cache (key TEXT PRIMARY KEY, endpoint TEXT NOT NULL, request TEXT NOT NULL, response TEXT NOT NULL, cost REAL NOT NULL, fetched_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY, endpoint TEXT NOT NULL, cost REAL NOT NULL, at TEXT NOT NULL);
    `);
  }

  private key(endpoint: string, body: unknown) {
    return createHash('sha256').update(`${endpoint}\n${JSON.stringify(body)}`).digest('hex');
  }

  /** With maxAgeDays, an older answer counts as a miss. AI answers change, so they don't stay valid forever. */
  get<T>(endpoint: string, body: unknown, maxAgeDays?: number): CachedResponse<T> | null {
    const row = this.db.prepare('SELECT response, cost, fetched_at FROM api_cache WHERE key = ?').get(this.key(endpoint, body)) as { response: string; cost: number; fetched_at: string } | undefined;
    if (!row) return null;
    if (maxAgeDays !== undefined && Date.now() - new Date(row.fetched_at).getTime() > maxAgeDays * 86_400_000) return null;
    return { value: JSON.parse(row.response) as T, cost: 0, cached: true, fetchedAt: row.fetched_at };
  }

  /** The ledger records each charge once, so a task's collected result can be saved without adding another row. */
  put(endpoint: string, body: unknown, response: unknown, cost: number, options: { ledger?: boolean } = {}): string {
    const at = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare('INSERT OR REPLACE INTO api_cache (key, endpoint, request, response, cost, fetched_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(this.key(endpoint, body), endpoint, JSON.stringify(body), JSON.stringify(response), cost, at);
      if (options.ledger !== false) this.db.prepare('INSERT INTO ledger (endpoint, cost, at) VALUES (?, ?, ?)').run(endpoint, cost, at);
    })();
    return at;
  }

  spentSince(iso: string): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(cost), 0) AS total FROM ledger WHERE at >= ?').get(iso) as { total: number };
    return row.total;
  }

  spend(): { total: number; calls: number; byEndpoint: { endpoint: string; cost: number; calls: number }[] } {
    const byEndpoint = this.db.prepare('SELECT endpoint, SUM(cost) AS cost, COUNT(*) AS calls FROM ledger GROUP BY endpoint ORDER BY cost DESC').all() as { endpoint: string; cost: number; calls: number }[];
    return { total: byEndpoint.reduce((sum, row) => sum + row.cost, 0), calls: byEndpoint.reduce((sum, row) => sum + row.calls, 0), byEndpoint };
  }

  close() {
    this.db.close();
  }
}
