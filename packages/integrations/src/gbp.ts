import { readSettings, runAnalysis, type Db } from '@sak/core';
import { CostConfirmationRequired, ESTIMATED_COST, PaidApisDisabled, type DataForSeo } from './dataforseo.ts';

export interface GbpRequest {
  /** A business name, or cid: or place_id: followed by the id. */
  keyword: string;
  location: number;
  language: string;
  /** How many of the newest reviews to read. 0 skips them. */
  reviews: number;
  posts: boolean;
}

export const estimateGbp = ({ reviews, posts }: Pick<GbpRequest, 'reviews' | 'posts'>) =>
  ESTIMATED_COST.gbpInfo + (reviews > 0 ? Math.ceil(reviews / 10) * ESTIMATED_COST.gbpReviews : 0) + (posts ? ESTIMATED_COST.gbpPosts : 0);

const QUARTER_MS = 90 * 86_400_000;

const newest = (dates: (string | null)[]) => {
  const times = dates.filter((date): date is string => Boolean(date)).map((date) => new Date(date).getTime()).filter((time) => !Number.isNaN(time));
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
};

/** Stores one Business Profile with a crawl, then rebuilds issues so the site and the profile can be compared. */
export async function importGbp(db: Db, client: DataForSeo, request: GbpRequest, options: { confirmed?: boolean; refresh?: boolean } = {}, now = new Date()) {
  // Asked here rather than by each call, so the amount agreed to covers the reviews and posts as well.
  if (!options.confirmed) {
    if (!readSettings().paidApis) throw new PaidApisDisabled();
    client.checkBudget(estimateGbp(request));
    throw new CostConfirmationRequired(estimateGbp(request), `Business Profile data for ${request.keyword}`);
  }
  const where = { location: request.location, language: request.language };
  const info = await client.gbpInfo(request.keyword, where, options);
  if (!info.value) throw new Error(`Google has no Business Profile matching ${request.keyword} here. Try cid: or place_id: followed by the id.`);
  const profile = info.value;
  // The id is more exact than a name, and asks for the same business the profile came from.
  const id = profile.place_id ? `place_id:${profile.place_id}` : request.keyword;
  const reviews = request.reviews > 0 ? await client.gbpReviews(id, where, request.reviews, options) : null;
  const posts = request.posts ? await client.gbpPosts(id, where, options) : null;
  const recent = (reviews?.value ?? []).filter((review) => review.timestamp && now.getTime() - new Date(review.timestamp).getTime() <= QUARTER_MS);
  db.prepare(`INSERT OR REPLACE INTO gbp_profile (key, title, category, additional_categories, description, address, phone, url, domain, place_id, cid, is_claimed, total_photos, rating, rating_votes, rating_distribution, has_hours, business_status, attributes, services, place_topics, competitors, reviews_fetched, reviews_with_reply, latest_review, reviews_last_90, posts_fetched, latest_post, fetched_at)
    VALUES (@key, @title, @category, @additional_categories, @description, @address, @phone, @url, @domain, @place_id, @cid, @is_claimed, @total_photos, @rating, @rating_votes, @rating_distribution, @has_hours, @business_status, @attributes, @services, @place_topics, @competitors, @reviews_fetched, @reviews_with_reply, @latest_review, @reviews_last_90, @posts_fetched, @latest_post, @fetched_at)`).run({
    ...profile,
    key: profile.place_id ?? request.keyword,
    additional_categories: JSON.stringify(profile.additional_categories),
    is_claimed: profile.is_claimed === null ? null : profile.is_claimed ? 1 : 0,
    rating_distribution: profile.rating_distribution ? JSON.stringify(profile.rating_distribution) : null,
    has_hours: profile.has_hours ? 1 : 0,
    place_topics: profile.place_topics ? JSON.stringify(profile.place_topics) : null,
    competitors: JSON.stringify(profile.competitors),
    reviews_fetched: reviews ? reviews.value.length : null,
    reviews_with_reply: reviews ? reviews.value.filter((review) => review.owner_answer).length : null,
    latest_review: reviews ? newest(reviews.value.map((review) => review.timestamp)) : null,
    reviews_last_90: reviews ? recent.length : null,
    posts_fetched: posts ? posts.value.length : null,
    latest_post: posts ? newest(posts.value.map((post) => post.timestamp)) : null,
    fetched_at: now.toISOString(),
  });
  runAnalysis(db);
  return { profile, reviews: reviews?.value.length ?? null, posts: posts?.value.length ?? null, cost: info.cost + (reviews?.cost ?? 0) + (posts?.cost ?? 0) };
}
