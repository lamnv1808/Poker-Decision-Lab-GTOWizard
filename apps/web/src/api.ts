/** Thin JSON client for the Poker Decision Lab API (same-origin, cookie session). */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

/**
 * Upper bound for one request. Generous on purpose: a free-tier host can take ~50 s to wake up, and
 * the slowest analysis endpoints take a few seconds. Past this the page shows a retryable error
 * instead of an endless spinner.
 */
export const REQUEST_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 300_000;

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), isForm ? UPLOAD_TIMEOUT_MS : REQUEST_TIMEOUT_MS) : null;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'include',
      headers: body && !isForm ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? (isForm ? (body as FormData) : JSON.stringify(body)) : undefined,
      signal: ctrl?.signal,
    });
  } catch (e) {
    if (timer) clearTimeout(timer);
    // status 0 = the request never got an HTTP answer (offline, DNS, timeout)
    if ((e as { name?: string })?.name === 'AbortError') throw new ApiError(0, 'timeout', 'The server took too long to respond.');
    throw new ApiError(0, 'network', 'Could not reach the server.');
  }
  try {
    const text = await res.text();
    let data: { error?: string; message?: string } | null = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      if (res.ok) throw new ApiError(res.status, 'bad_response', 'The server sent an unreadable response.');
    }
    // never an empty message: statusText is empty over HTTP/2
    if (!res.ok) throw new ApiError(res.status, data?.error ?? 'error', data?.message || res.statusText || `Request failed (HTTP ${res.status}).`, data);
    return data as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if ((e as { name?: string })?.name === 'AbortError') throw new ApiError(0, 'timeout', 'The server took too long to respond.');
    throw new ApiError(res.status, 'bad_response', 'The server sent an unreadable response.');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}),
  put: <T>(p: string, b?: unknown) => request<T>('PUT', p, b ?? {}),
  del: <T>(p: string) => request<T>('DELETE', p),
  upload: <T>(p: string, form: FormData) => request<T>('POST', p, form),
};

export const newAttemptId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** The Mixed Training session this page was opened from (`?mixed=<id>`), if any. */
export function mixedSessionId(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  return new URLSearchParams(window.location.search).get('mixed') ?? undefined;
}
