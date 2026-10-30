import { createRequire } from 'node:module';
import type { CrawlConfig } from './types.ts';
import type { Fetcher } from './fetcher.ts';

const require = createRequire(import.meta.url);
const robotsParser = require('robots-parser') as (url: string, body: string) => {
  isAllowed(url: string, ua?: string): boolean | undefined;
  getSitemaps(): string[];
};

export interface RobotsPolicy {
  isAllowed(url: string): boolean;
  sitemaps: string[];
}

/** Each origin has its own robots.txt, so http/https and www variants are fetched separately. */
export class RobotsCache {
  private policies = new Map<string, Promise<RobotsPolicy>>();
  private config: CrawlConfig;
  private fetcher: Fetcher;

  constructor(config: CrawlConfig, fetcher: Fetcher) {
    this.config = config;
    this.fetcher = fetcher;
  }

  forUrl(url: string): Promise<RobotsPolicy> {
    const origin = new URL(url).origin;
    let policy = this.policies.get(origin);
    if (!policy) {
      policy = this.load(origin);
      this.policies.set(origin, policy);
    }
    return policy;
  }

  private async load(origin: string): Promise<RobotsPolicy> {
    const robotsUrl = `${origin}/robots.txt`;
    const headers = { ...this.config.headers, 'user-agent': this.config.userAgent };
    let text = '';
    if (this.config.robotsMode === 'custom') {
      text = this.config.customRobots ?? '';
    } else {
      try {
        const result = await this.fetchText(robotsUrl, headers);
        // A 4xx means no restrictions. A 5xx or network failure is treated the same so a
        // flaky robots.txt can't silently produce an empty crawl.
        if (result.status === 200) text = result.body;
      } catch {
        text = '';
      }
    }
    const parsed = robotsParser(robotsUrl, text);
    const ignore = this.config.robotsMode === 'ignore';
    return {
      sitemaps: parsed.getSitemaps(),
      isAllowed: (url) => ignore || parsed.isAllowed(url, this.config.userAgent) !== false,
    };
  }

  private async fetchText(url: string, headers: Record<string, string>) {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(this.config.timeoutMs) });
    return { status: response.status, body: await response.text() };
  }
}
