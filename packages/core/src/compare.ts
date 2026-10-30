import type { Db } from './db.ts';

interface Snapshot {
  url: string;
  status: number | null;
  indexable: number | null;
  title: string | null;
  canonical: string | null;
}

export interface CrawlComparison {
  urlsAdded: string[];
  urlsRemoved: string[];
  changed: { url: string; field: string; before: unknown; after: unknown }[];
  issuesAdded: { type: string; url: string; detail: string | null }[];
  issuesResolved: { type: string; url: string; detail: string | null }[];
}

function snapshot(db: Db): Map<string, Snapshot> {
  const rows = db.prepare(`SELECT u.url, r.status, u.indexable,
      json_extract(p.titles, '$[0]') AS title,
      COALESCE(json_extract(p.canonicals, '$[0]'), r.link_canonical) AS canonical
    FROM urls u LEFT JOIN responses r ON r.url_id = u.id LEFT JOIN page_elements p ON p.url_id = u.id
    WHERE u.kind = 'page'`).all() as Snapshot[];
  return new Map(rows.map((r) => [r.url, r]));
}

function issueSet(db: Db) {
  const rows = db.prepare('SELECT type, url, detail FROM issues').all() as { type: string; url: string; detail: string | null }[];
  return new Map(rows.map((r) => [`${r.type}\u0000${r.url}\u0000${r.detail ?? ''}`, r]));
}

export function compareCrawls(before: Db, after: Db): CrawlComparison {
  const a = snapshot(before);
  const b = snapshot(after);
  const changed: CrawlComparison['changed'] = [];
  for (const [url, next] of b) {
    const previous = a.get(url);
    if (!previous) continue;
    for (const field of ['status', 'indexable', 'title', 'canonical'] as const) {
      if (previous[field] !== next[field]) changed.push({ url, field, before: previous[field], after: next[field] });
    }
  }
  const issuesA = issueSet(before);
  const issuesB = issueSet(after);
  return {
    urlsAdded: [...b.keys()].filter((u) => !a.has(u)),
    urlsRemoved: [...a.keys()].filter((u) => !b.has(u)),
    changed,
    issuesAdded: [...issuesB].filter(([k]) => !issuesA.has(k)).map(([, v]) => v),
    issuesResolved: [...issuesA].filter(([k]) => !issuesB.has(k)).map(([, v]) => v),
  };
}
