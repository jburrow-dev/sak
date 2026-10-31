import type { Db } from '@sak/core';

export interface PullRecord {
  source: string;
  account: string | null;
  property: string | null;
  days: number | null;
  startDate: string | null;
  endDate: string | null;
  rows: number;
  matched: number;
  dropped: number;
  note?: string | null;
}

export function recordPull(db: Db, pull: PullRecord): void {
  db.prepare(`INSERT OR REPLACE INTO traffic_pulls (source, account, property, days, start_date, end_date, fetched_at, status, row_count, matched, dropped, note, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?, ?, ?, NULL)`)
    .run(pull.source, pull.account, pull.property, pull.days, pull.startDate, pull.endDate, new Date().toISOString(), pull.rows, pull.matched, pull.dropped, pull.note ?? null);
}

/** A failed refresh leaves earlier data in place, so its dates and status stay true. It only adds the error. */
export function recordPullFailure(db: Db, source: string, account: string | null, property: string | null, days: number | null, message: string): void {
  db.prepare(`INSERT INTO traffic_pulls (source, account, property, days, fetched_at, status, error) VALUES (?, ?, ?, ?, ?, 'failed', ?)
    ON CONFLICT(source) DO UPDATE SET error = excluded.error`)
    .run(source, account, property, days, new Date().toISOString(), message);
}
