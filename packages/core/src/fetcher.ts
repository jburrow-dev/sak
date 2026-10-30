export interface FetchRequest {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
  /** When false only the status and headers matter, so the body is discarded. */
  readBody: boolean;
}

export interface FetchResult {
  status: number;
  headers: Headers;
  body: string | null;
  bytes: number | null;
  elapsedMs: number;
}

/** The seam a future Playwright renderer plugs into. */
export interface Fetcher {
  fetch(request: FetchRequest): Promise<FetchResult>;
}

const MAX_BODY_BYTES = 15 * 1024 * 1024;

export class HttpFetcher implements Fetcher {
  async fetch({ url, headers, timeoutMs, readBody }: FetchRequest): Promise<FetchResult> {
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
    } else {
      await response.body?.cancel();
    }
    return { status: response.status, headers: response.headers, body, bytes, elapsedMs: Math.round(performance.now() - started) };
  }
}
