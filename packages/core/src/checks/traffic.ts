import type { Db } from '../db.ts';

interface TrafficUrl {
  url: string;
  kind: string;
  status: number | null;
  in_sitemap: number;
  indexable: number | null;
  indexability_reason: string | null;
}

interface Finding {
  type: string;
  url: string;
  detail?: string;
}

const METRICS = [
  { source: 'gsc', sql: 'SELECT url, clicks AS value FROM search_console', label: 'clicks (Search Console)' },
  { source: 'ga4', sql: 'SELECT url, sessions AS value FROM analytics', label: 'sessions (GA4)' },
  { source: 'bing', sql: 'SELECT url, clicks AS value FROM bing_webmaster', label: 'clicks (Bing)' },
];

/**
 * A missing row only means "no traffic" when that source was actually pulled and matched pages.
 * Otherwise a crawl without integrations, or one using the wrong property, would fill up with false issues.
 */
export function runTrafficChecks(db: Db, urls: TrafficUrl[]): Finding[] {
  const pulled = new Map((db.prepare(`SELECT source, matched FROM traffic_pulls WHERE status = 'ok'`).all() as { source: string; matched: number }[]).map((p) => [p.source, p.matched]));
  const findings: Finding[] = [];
  const traffic = new Map<string, string[]>();
  for (const { source, sql, label } of METRICS) {
    if (!pulled.has(source)) continue;
    for (const { url, value } of db.prepare(sql).all() as { url: string; value: number | null }[]) {
      if (!value) continue;
      if (!traffic.has(url)) traffic.set(url, []);
      traffic.get(url)!.push(`${value} ${label}`);
    }
  }
  const pages = urls.filter((u) => u.kind === 'page');
  const hasSitemap = pages.some((u) => u.in_sitemap === 1);
  for (const page of pages) {
    const seen = traffic.get(page.url);
    if (seen) {
      // A redirect keeps collecting traffic for a while after a move, and is already doing its job.
      const redirected = page.status !== null && page.status >= 300 && page.status < 400;
      if (page.indexable === 0 && !redirected) findings.push({ type: 'traffic_non_indexable', url: page.url, detail: `${page.indexability_reason}: ${seen.join(', ')}` });
      if (page.indexable === 1 && hasSitemap && page.in_sitemap === 0) findings.push({ type: 'traffic_not_in_sitemap', url: page.url, detail: seen.join(', ') });
    }
  }
  if ((pulled.get('gsc') ?? 0) > 0) {
    const seen = new Set((db.prepare('SELECT url FROM search_console WHERE impressions > 0').all() as { url: string }[]).map((r) => r.url));
    for (const page of pages) if (page.indexable === 1 && !seen.has(page.url)) findings.push({ type: 'traffic_no_impressions', url: page.url });
  }
  const indexable = new Set(pages.filter((u) => u.indexable === 1).map((u) => u.url));
  const inspected = db.prepare('SELECT url, verdict, coverage_state, google_canonical, user_canonical, rich_verdict, rich_issues FROM url_inspection WHERE error IS NULL').all() as { url: string; verdict: string | null; coverage_state: string | null; google_canonical: string | null; user_canonical: string | null; rich_verdict: string | null; rich_issues: string | null }[];
  for (const row of inspected) {
    if (indexable.has(row.url) && (row.verdict === 'FAIL' || row.verdict === 'NEUTRAL')) findings.push({ type: 'index_not_indexed', url: row.url, detail: row.coverage_state ?? undefined });
    if (row.google_canonical && row.user_canonical && row.google_canonical !== row.user_canonical) findings.push({ type: 'index_canonical_mismatch', url: row.url, detail: `Google chose ${row.google_canonical}, declared ${row.user_canonical}` });
    if (row.rich_verdict === 'FAIL') findings.push({ type: 'rich_result_invalid', url: row.url, detail: row.rich_issues ?? undefined });
  }
  findings.push(...runSpeedChecks(db));
  return findings;
}

const LCP = { good: 2500, poor: 4000 };
const INP = { good: 200, poor: 500 };
const CLS = { good: 0.1, poor: 0.25 };

function vital(url: string, name: 'lcp' | 'inp' | 'cls', value: number | null, limits: { good: number; poor: number }, source: string): Finding[] {
  if (value === null) return [];
  const shown = name === 'cls' ? value.toFixed(2) : `${Math.round(value)} ms`;
  if (value > limits.poor) return [{ type: `cwv_${name}_poor`, url, detail: `${shown} (${source})` }];
  return value > limits.good ? [{ type: 'cwv_needs_improvement', url, detail: `${name.toUpperCase()} ${shown} (${source})` }] : [];
}

/** Real-user data decides when Google has it. Lab figures only stand in for pages without any. */
function runSpeedChecks(db: Db): Finding[] {
  const findings: Finding[] = [];
  const pages = db.prepare('SELECT url, strategy, lcp_ms, cls, inp_ms, field_lcp_ms, field_cls FROM pagespeed').all() as { url: string; strategy: string; lcp_ms: number | null; cls: number | null; inp_ms: number | null; field_lcp_ms: number | null; field_cls: number | null }[];
  for (const row of pages) {
    const lcp = row.field_lcp_ms ?? row.lcp_ms;
    const cls = row.field_cls ?? row.cls;
    findings.push(
      ...vital(row.url, 'lcp', lcp, LCP, `${row.field_lcp_ms !== null ? 'real users' : 'lab test'}, ${row.strategy}`),
      ...vital(row.url, 'inp', row.inp_ms, INP, `real users, ${row.strategy}`),
      ...vital(row.url, 'cls', cls, CLS, `${row.field_cls !== null ? 'real users' : 'lab test'}, ${row.strategy}`),
    );
  }
  const origins = db.prepare('SELECT scope, form_factor, lcp_ms, cls, inp_ms FROM crux').all() as { scope: string; form_factor: string; lcp_ms: number | null; cls: number | null; inp_ms: number | null }[];
  for (const row of origins) {
    const source = `real users across the site, ${row.form_factor.toLowerCase()}`;
    findings.push(...vital(row.scope, 'lcp', row.lcp_ms, LCP, source), ...vital(row.scope, 'inp', row.inp_ms, INP, source), ...vital(row.scope, 'cls', row.cls, CLS, source));
  }
  return findings;
}
