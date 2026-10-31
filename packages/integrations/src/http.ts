/** Failures carry the service's message but never the request URL, because Bing puts its API key there. */
export class ApiError extends Error {
  status: number;
  constructor(label: string, status: number, message: string) {
    super(`${label} error ${status}: ${message}`);
    this.status = status;
  }
}

export interface ApiOptions {
  label: string;
  fetchImpl?: typeof fetch;
  retries?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const MAX_RETRY_WAIT_MS = 60_000;

function errorMessage(data: any): string {
  if (typeof data?.error === 'string') return data.error_description ?? data.error;
  return data?.error?.message ?? data?.Message ?? data?.message ?? 'no details given';
}

/** Google's quotas reset over minutes or hours, so a quick retry only uses up more of them. */
const isQuotaMessage = (message: string) => /quota|exhausted/i.test(message);

function retryDelay(header: string | null, attempt: number): number {
  const seconds = header === null ? NaN : Number(header);
  return Number.isFinite(seconds) ? seconds * 1000 : 1000 * 2 ** attempt;
}

export async function apiJson(url: string, init: RequestInit, options: ApiOptions): Promise<any> {
  const { label, fetchImpl = fetch, retries = 3, timeoutMs = 120_000, sleep = wait } = options;
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (attempt < retries) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new Error(`${label} could not be reached (${(error as Error).name})`);
    }
    const data = await response.json().catch(() => null);
    if (response.ok) {
      if (data === null) throw new Error(`${label} sent a response that could not be read`);
      return data;
    }
    const message = errorMessage(data);
    const delay = retryDelay(response.headers.get('retry-after'), attempt);
    const retryable = (response.status === 429 || response.status >= 500) && !isQuotaMessage(message);
    if (!retryable || attempt >= retries || delay > MAX_RETRY_WAIT_MS) throw new ApiError(label, response.status, message);
    await sleep(delay);
  }
}
