import type { Db } from '../db.ts';
import type { IssueFinding, UrlRow } from '../types.ts';

export interface GbpRow {
  key: string;
  title: string | null;
  category: string | null;
  description: string | null;
  address: string | null;
  phone: string | null;
  url: string | null;
  domain: string | null;
  is_claimed: number | null;
  total_photos: number | null;
  has_hours: number | null;
  business_status?: string | null;
  attributes: number | null;
  services: number | null;
  reviews_fetched: number | null;
  reviews_with_reply: number | null;
  latest_review: string | null;
  posts_fetched: number | null;
  latest_post: string | null;
}

const bareHost = (host: string) => host.toLowerCase().replace(/^www\./, '');
const digits = (phone: string) => phone.replace(/\D/g, '').slice(-10);
const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
const STALE_DAYS = 90;
const MIN_REPLY_RATE = 0.5;
const MIN_REVIEWS_FOR_REPLY_RATE = 5;

const daysSince = (date: string | null, now: Date) => (date ? (now.getTime() - new Date(date).getTime()) / 86_400_000 : null);

/** LocalBusiness facts the site states about itself, gathered from every page's JSON-LD. */
export interface SiteBusiness {
  names: string[];
  phones: string[];
  addresses: string[];
}

export function readSiteBusiness(jsonLd: string[]): SiteBusiness {
  const found: SiteBusiness = { names: [], phones: [], addresses: [] };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, any>;
    if (node.telephone && node.address) {
      if (typeof node.name === 'string') found.names.push(node.name);
      if (typeof node.telephone === 'string') found.phones.push(node.telephone);
      const address = node.address;
      const text = typeof address === 'string' ? address : [address.streetAddress, address.addressLocality, address.addressRegion, address.postalCode].filter(Boolean).join(' ');
      if (text) found.addresses.push(text);
    }
    Object.values(node).forEach(visit);
  };
  for (const raw of jsonLd) {
    try {
      visit(JSON.parse(raw));
    } catch {
      // A block that doesn't parse has its own issue.
    }
  }
  return found;
}

export function checkGbpProfile(profile: GbpRow, startUrl: string, site: SiteBusiness, urls: Pick<UrlRow, 'url' | 'status' | 'indexable'>[], now = new Date()): IssueFinding[] {
  const label = profile.title ?? profile.key;
  const out: IssueFinding[] = [];
  const add = (type: string, detail: string) => out.push({ type, url: startUrl, detail: `${label}: ${detail}` });

  const closed = profile.business_status === 'closed_forever' || profile.business_status === 'temporarily_closed';
  if (closed) add('gbp_closed', `Google shows this business as ${profile.business_status!.replace('_', ' ')}`);
  if (profile.is_claimed === 0) add('gbp_unclaimed', 'Google shows this profile as unclaimed');
  const missing = [
    !profile.description && 'description', !profile.category && 'category', !profile.phone && 'phone', !profile.url && 'website',
    // A closed business has no hours to show, so that isn't a gap in its profile.
    !profile.has_hours && !closed && 'hours', !profile.total_photos && 'photos', !profile.attributes && 'attributes', !profile.services && 'services',
  ].filter(Boolean);
  if (missing.length) add('gbp_incomplete', missing.join(', '));

  const siteHost = bareHost(new URL(startUrl).hostname);
  if (profile.domain && bareHost(profile.domain) !== siteHost && !bareHost(profile.domain).endsWith(`.${siteHost}`)) {
    add('gbp_website_mismatch', `Profile links to ${profile.domain}, this crawl is ${siteHost}`);
  }
  if (profile.url) {
    const linked = urls.find((u) => u.url === profile.url);
    if (linked && (linked.status !== 200 || linked.indexable !== 1)) add('gbp_website_bad', `${profile.url} returned ${linked.status ?? 'no response'}${linked.indexable === 0 ? ' and is not indexable' : ''}`);
  }

  // Only compared when the site publishes these details, and any matching location is enough on a multi-location site.
  if (profile.phone && site.phones.length && !site.phones.some((phone) => digits(phone) === digits(profile.phone!))) {
    add('gbp_nap_mismatch', `Phone ${profile.phone} isn't in the site's LocalBusiness schema (${[...new Set(site.phones)].slice(0, 3).join(', ')})`);
  }
  if (profile.address && site.addresses.length) {
    const profileWords = words(profile.address);
    const close = site.addresses.some((address) => {
      const siteWords = [...words(address)];
      return siteWords.length > 0 && siteWords.filter((word) => profileWords.has(word)).length / siteWords.length >= 0.6;
    });
    if (!close) add('gbp_nap_mismatch', `Address "${profile.address}" doesn't match the site's LocalBusiness schema`);
  }
  if (profile.title && site.names.length) {
    const titleWords = words(profile.title);
    if (!site.names.some((name) => [...words(name)].some((word) => titleWords.has(word)))) add('gbp_nap_mismatch', `Name "${profile.title}" doesn't match the site's LocalBusiness schema`);
  }

  const fetched = profile.reviews_fetched ?? 0;
  if (fetched >= MIN_REVIEWS_FOR_REPLY_RATE && (profile.reviews_with_reply ?? 0) / fetched < MIN_REPLY_RATE) {
    add('gbp_reviews_unanswered', `${profile.reviews_with_reply ?? 0} of the latest ${fetched} reviews have an owner reply`);
  }
  const reviewAge = daysSince(profile.latest_review, now);
  if (reviewAge !== null && reviewAge > STALE_DAYS) add('gbp_reviews_stale', `Latest review ${Math.round(reviewAge)} days ago`);
  const postAge = daysSince(profile.latest_post, now);
  if (postAge !== null && postAge > STALE_DAYS) add('gbp_posts_stale', `Latest post ${Math.round(postAge)} days ago`);
  return out;
}

export function runGbpChecks(db: Db, startUrl: string, urls: UrlRow[]): IssueFinding[] {
  const profiles = db.prepare('SELECT * FROM gbp_profile').all() as GbpRow[];
  if (profiles.length === 0 || !startUrl) return [];
  const site = readSiteBusiness((db.prepare('SELECT raw FROM structured_data').all() as { raw: string }[]).map((row) => row.raw));
  const pages = urls.filter((u) => u.kind === 'page');
  return profiles.flatMap((profile) => checkGbpProfile(profile, startUrl, site, pages));
}
