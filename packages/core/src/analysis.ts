import type { Db } from './db.ts';
import { getMeta } from './db.ts';
import type { PageRow, UrlRow } from './types.ts';
import { ISSUES } from './checks/catalog.ts';
import { runPageChecks, type PageInput } from './checks/page.ts';
import { buildRedirectChains, runSiteChecks, type SiteInput } from './checks/site.ts';
import { runTrafficChecks } from './checks/traffic.ts';

export const URL_ROW_SQL = `SELECT u.id, u.url, u.kind, u.state, u.depth, u.in_sitemap, u.indexable, u.indexability_reason,
  r.status, r.content_type, r.redirect_target, r.x_robots, r.link_canonical, r.response_ms, r.bytes, r.error, r.blocked_reason
  FROM urls u LEFT JOIN responses r ON r.url_id = u.id`;

const parse = (value: string): string[] => JSON.parse(value) as string[];

function readPages(db: Db): (PageRow & { link_canonical: string | null; x_robots: string | null })[] {
  const rows = db.prepare(`SELECT p.*, u.url, r.link_canonical, r.x_robots FROM page_elements p
    JOIN urls u ON u.id = p.url_id JOIN responses r ON r.url_id = p.url_id`).all() as Record<string, never>[];
  return rows.map((row: any) => ({
    ...row,
    titles: parse(row.titles),
    meta_descriptions: parse(row.meta_descriptions),
    h1s: parse(row.h1s),
    meta_robots: parse(row.meta_robots),
    canonicals: parse(row.canonicals),
  }));
}

export function computeIndexability(row: UrlRow, page: { meta_robots: string[]; canonicals: string[]; link_canonical: string | null } | undefined): { indexable: 0 | 1; reason: string | null } {
  if (row.state === 'blocked_robots') return { indexable: 0, reason: 'blocked by robots.txt' };
  if (row.error) return { indexable: 0, reason: 'fetch failed' };
  if (row.status === null) return { indexable: 0, reason: 'not fetched' };
  if (row.status !== 200) return { indexable: 0, reason: `status ${row.status}` };
  if (!page) return { indexable: 0, reason: 'not HTML' };
  const directives = [...page.meta_robots, row.x_robots ?? ''].join(',');
  if (/\b(noindex|none)\b/i.test(directives)) return { indexable: 0, reason: 'noindex' };
  const canonical = page.canonicals[0] ?? page.link_canonical;
  if (canonical && canonical !== row.url) return { indexable: 0, reason: 'canonicalised' };
  return { indexable: 1, reason: null };
}

/** Rebuilds all derived data from stored crawl facts, so it can be re-run on an old crawl. */
export function runAnalysis(db: Db): void {
  const startUrl = getMeta(db, 'start_url') ?? '';
  const urls = db.prepare(URL_ROW_SQL).all() as UrlRow[];
  const pages = readPages(db);
  const pageById = new Map(pages.map((p) => [p.url_id, p]));

  for (const row of urls) {
    if (row.kind !== 'page') continue;
    const { indexable, reason } = computeIndexability(row, pageById.get(row.id));
    row.indexable = indexable;
    row.indexability_reason = reason;
  }

  const hreflang = db.prepare('SELECT u.url, h.lang, h.href FROM hreflang h JOIN urls u ON u.id = h.url_id').all() as SiteInput['hreflang'];
  const hreflangByUrl = new Map<string, { lang: string; href: string }[]>();
  for (const entry of hreflang) {
    if (!hreflangByUrl.has(entry.url)) hreflangByUrl.set(entry.url, []);
    hreflangByUrl.get(entry.url)!.push({ lang: entry.lang, href: entry.href });
  }
  const jsonLd = db.prepare('SELECT url_id, raw FROM structured_data').all() as { url_id: number; raw: string }[];
  const jsonLdById = new Map<number, string[]>();
  for (const { url_id, raw } of jsonLd) {
    if (!jsonLdById.has(url_id)) jsonLdById.set(url_id, []);
    jsonLdById.get(url_id)!.push(raw);
  }

  const rowById = new Map(urls.map((u) => [u.id, u]));
  const findings = pages.flatMap((page) => {
      const input: PageInput = {
        url: page.url,
        titles: page.titles,
        metaDescriptions: page.meta_descriptions,
        h1s: page.h1s,
        metaRobots: page.meta_robots,
        xRobots: page.x_robots,
        canonicals: [...page.canonicals, ...(page.link_canonical ? [page.link_canonical] : [])],
        wordCount: page.word_count,
        scriptCount: page.script_count,
        hasEmptyAppRoot: page.has_empty_app_root === 1,
        hreflang: hreflangByUrl.get(page.url) ?? [],
        jsonLd: jsonLdById.get(page.url_id) ?? [],
        indexable: rowById.get(page.url_id)?.indexable === 1,
        rendered: page.rendered === 1,
        rawWordCount: page.raw_word_count,
        jsOnlyLinks: page.js_only_links,
        renderError: page.render_error,
      };
      return runPageChecks(input);
  });

  const site: SiteInput = {
    startUrl,
    urls,
    pages: pages.map((p) => ({
      url: p.url,
      title: p.titles.find((t) => t.length > 0) ?? null,
      meta: p.meta_descriptions.find((m) => m.length > 0) ?? null,
      textHash: p.text_hash,
      canonical: p.canonicals[0] ?? p.link_canonical,
    })),
    links: db.prepare('SELECT s.url AS source, t.url AS target, l.type FROM links l JOIN urls s ON s.id = l.source_id JOIN urls t ON t.id = l.target_id').all() as SiteInput['links'],
    hreflang,
  };
  const chains = buildRedirectChains(urls);
  findings.push(...runSiteChecks(site, chains));
  findings.push(...runTrafficChecks(db, urls));

  const urlIds = new Map(urls.map((u) => [u.url, u.id]));
  db.transaction(() => {
    const setIndexable = db.prepare('UPDATE urls SET indexable = ?, indexability_reason = ? WHERE id = ?');
    for (const row of urls) setIndexable.run(row.indexable, row.indexability_reason, row.id);
    db.exec('DELETE FROM issues; DELETE FROM redirect_hops;');
    const insertHop = db.prepare('INSERT INTO redirect_hops (start_id, hop, url, status) VALUES (?, ?, ?, ?)');
    for (const chain of chains) {
      const startId = urlIds.get(chain.start)!;
      chain.hops.forEach((hop, index) => insertHop.run(startId, index, hop.url, hop.status));
    }
    const insertIssue = db.prepare('INSERT INTO issues (type, severity, url, detail) VALUES (?, ?, ?, ?)');
    for (const finding of findings) {
      insertIssue.run(finding.type, ISSUES[finding.type]?.severity ?? 'notice', finding.url, finding.detail ?? null);
    }
  })();
}
