import { siteHost } from '@sak/core';
import { readConnections, type TrafficSource } from './connections.ts';
import type { PropertyOption } from './google.ts';

const DOMAIN_PREFIX = 'sc-domain:';

/** Whether a property's data can cover a crawl of this URL. */
export function propertyCovers(property: string, startUrl: string, crawlSubdomains = false): boolean {
  let start: URL;
  try {
    start = new URL(startUrl);
  } catch {
    return true;
  }
  const host = start.hostname.toLowerCase();
  if (property.startsWith(DOMAIN_PREFIX)) {
    const domain = property.slice(DOMAIN_PREFIX.length).toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  }
  let prefix: URL;
  try {
    prefix = new URL(property);
  } catch {
    return true; // GA4 ids say nothing about hosts.
  }
  const sameSite = siteHost(prefix.toString()) === siteHost(start.toString());
  if (!sameSite) return false;
  return !crawlSubdomains && prefix.pathname.length <= 1;
}

/** Best first: a domain property for this site, then a URL prefix for it, then the last one chosen for this domain. */
export function suggestProperty(source: TrafficSource, properties: PropertyOption[], startUrl: string, crawlSubdomains = false): string | null {
  let site: string;
  try {
    site = siteHost(startUrl);
  } catch {
    return null;
  }
  const domains = properties.filter((p) => p.id.startsWith(DOMAIN_PREFIX) && propertyCovers(p.id, startUrl)).sort((a, b) => b.id.length - a.id.length);
  if (domains[0]) return domains[0].id;
  const start = new URL(startUrl);
  const prefixes = properties.filter((p) => {
    try {
      return siteHost(p.id) === site && new URL(p.id).pathname.length <= 1;
    } catch {
      return false;
    }
  });
  const exact = prefixes.find((p) => new URL(p.id).hostname === start.hostname && new URL(p.id).protocol === start.protocol);
  if (exact ?? prefixes[0]) return (exact ?? prefixes[0]).id;
  const last = readConnections().lastUsed[site]?.[source]?.property;
  return last && (properties.length === 0 || properties.some((p) => p.id === last)) ? last : null;
}
