import type { Db } from '../db.ts';
import { readSiteAudit, type SiteAudit } from '../site-audit.ts';
import type { IssueFinding, UrlRow } from '../types.ts';

const MAX_SITEMAP_URLS = 50_000;
const MAX_SITEMAP_BYTES = 50 * 1024 * 1024;

export function checkRobotsFile(audit: SiteAudit): IssueFinding[] {
  const { url, status, error, sitemaps, blockedSearchBots } = audit.robots;
  // A 5xx is the serious one: search engines may stop crawling rather than assume access.
  if (error || (status !== null && status >= 500)) return [{ type: 'robots_unreachable', url, detail: error ?? String(status) }];
  if (status !== 200) return [{ type: 'robots_missing', url, detail: String(status) }];
  const out: IssueFinding[] = blockedSearchBots.map((bot) => ({ type: 'robots_blocks_search', url, detail: bot }));
  if (sitemaps === 0) out.push({ type: 'robots_no_sitemap', url });
  return out;
}

export function checkSitemapFiles(audit: SiteAudit, startUrl: string): IssueFinding[] {
  if (!audit.sitemaps) return [];
  const { declared, reports } = audit.sitemaps;
  const out: IssueFinding[] = [];
  if (!reports.some((report) => report.urls > 0 || report.children > 0)) {
    out.push({ type: 'sitemap_missing', url: startUrl, detail: `Tried ${reports.map((r) => r.url).join(', ') || 'nothing'}` });
  }
  const guessed = new Set(reports.map((r) => r.url).filter((url) => !declared.includes(url) && /\/sitemap(_index)?\.xml$/.test(url)));
  for (const report of reports) {
    const failed = report.error !== null || report.status === null || report.status >= 400 || (report.urls === 0 && report.children === 0);
    // SAK guesses these names when robots.txt declares none, so a 404 on a guess isn't the site's fault.
    if (failed && !guessed.has(report.url)) out.push({ type: 'sitemap_unreachable', url: report.url, detail: report.error ?? (report.status && report.status >= 400 ? String(report.status) : 'no URLs found') });
    if (report.urls > MAX_SITEMAP_URLS || report.bytes > MAX_SITEMAP_BYTES) out.push({ type: 'sitemap_too_large', url: report.url, detail: `${report.urls} URLs, ${report.bytes} bytes` });
    if (report.urls > 0 && report.lastmods === 0) out.push({ type: 'sitemap_no_lastmod', url: report.url, detail: `${report.urls} URLs` });
  }
  return out;
}

export function checkLlmsFile(audit: SiteAudit): IssueFinding[] {
  const { url, status, contentType, hasHeading } = audit.llms;
  // Many sites answer every path with their HTML shell, which means there is no file, not a bad one.
  if (status !== 200 || /html/i.test(contentType ?? '') || hasHeading) return [];
  return [{ type: 'llms_invalid', url }];
}

export function checkHosts(audit: SiteAudit, startUrl: string, startRow?: UrlRow): IssueFinding[] {
  const out: IssueFinding[] = [];
  const start = new URL(startUrl);
  const local = audit.https === null && audit.hostTwin === null;
  if (!local && start.protocol === 'http:') out.push({ type: 'https_not_used', url: startUrl });
  if (audit.https?.status === 200 || (audit.https?.status && audit.https.status >= 300 && audit.https.status < 400 && !audit.https.location?.startsWith('https:'))) {
    out.push({ type: 'https_not_enforced', url: `http://${start.host}/`, detail: audit.https.location ? `Redirects to ${audit.https.location}` : 'Answers 200 over HTTP' });
  }
  if (audit.hostTwin?.status === 200) out.push({ type: 'host_not_consolidated', url: audit.hostTwin.url, detail: `Answers 200 alongside ${start.origin}` });
  if (start.protocol === 'https:' && startRow?.hsts === '') out.push({ type: 'hsts_missing', url: startUrl });
  return out;
}

export function checkAiBots(robotsUrl: string, bots: { name: string; purpose: string; robots_allowed: number | null; probe_status: number | null; probe_refused: number | null }[], startUrl: string): IssueFinding[] {
  const out: IssueFinding[] = [];
  for (const bot of bots) {
    if (bot.robots_allowed === 0 && bot.purpose !== 'training') out.push({ type: 'ai_bot_blocked', url: robotsUrl, detail: bot.name });
    if (bot.probe_refused === 1) out.push({ type: 'ai_bot_refused', url: startUrl, detail: `${bot.name}: ${bot.probe_status}` });
  }
  return out;
}

/** Crawls saved before the site audit existed have nothing to check. */
export function runAuditChecks(db: Db, startUrl: string, urls: UrlRow[]): IssueFinding[] {
  const audit = readSiteAudit(db);
  if (!audit) return [];
  const bots = db.prepare('SELECT name, purpose, robots_allowed, probe_status, probe_refused FROM ai_bots').all() as Parameters<typeof checkAiBots>[1];
  return [
    ...checkRobotsFile(audit),
    ...checkSitemapFiles(audit, startUrl),
    ...checkLlmsFile(audit),
    ...checkHosts(audit, startUrl, urls.find((u) => u.url === startUrl)),
    ...checkAiBots(audit.robots.url, bots, startUrl),
  ];
}
