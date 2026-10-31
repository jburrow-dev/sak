export interface FetchRequest {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
  /** When false only the status and headers matter, so the body is discarded. */
  readBody: boolean;
  /** Reads a non-HTML body only to measure its size. */
  measureBody?: boolean;
  /** Waits for the rate limiter, for fetchers that make a second request to the same host. */
  pace?: () => Promise<void>;
}

export interface FetchResult {
  status: number;
  headers: Headers;
  body: string | null;
  bytes: number | null;
  elapsedMs: number;
  /** The HTML as served, when body holds the rendered DOM. */
  rawBody?: string;
  /** Where the page ended up, when its JavaScript navigated away. */
  finalUrl?: string;
  renderError?: string;
  /** The body was longer than SAK reads, so anything after the cut wasn't seen. */
  truncated?: boolean;
}

export interface Fetcher {
  fetch(request: FetchRequest): Promise<FetchResult>;
  /** Fails before any crawling starts if the fetcher can't run. */
  prepare?(): Promise<void>;
  close?(): Promise<void>;
}

const MAX_BODY_BYTES = 15 * 1024 * 1024;

export class HttpFetcher implements Fetcher {
  async fetch({ url, headers, timeoutMs, readBody, measureBody }: FetchRequest): Promise<FetchResult> {
    const started = performance.now();
    const response = await fetch(url, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const contentType = response.headers.get('content-type') ?? '';
    const isHtml = /html|xhtml/i.test(contentType);
    let body: string | null = null;
    let bytes: number | null = Number(response.headers.get('content-length')) || null;
    if (readBody && isHtml) {
      const buffer = Buffer.from(await response.arrayBuffer());
      bytes = buffer.byteLength;
      body = buffer.subarray(0, MAX_BODY_BYTES).toString('utf8');
    } else if (measureBody) {
      bytes = (await response.arrayBuffer()).byteLength;
    } else {
      await response.body?.cancel();
    }
    return { status: response.status, headers: response.headers, body, bytes, elapsedMs: Math.round(performance.now() - started), truncated: body !== null && (bytes ?? 0) > MAX_BODY_BYTES };
  }
}
