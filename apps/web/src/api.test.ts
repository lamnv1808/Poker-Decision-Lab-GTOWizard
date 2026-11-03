// Ported from the Codex P0 patch; adapted to the reconciled limit (60 s, all requests) and codes.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('API failure recovery', () => {
  it('aborts a stalled request after 60 seconds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));
    const check = expect(api.get('/daily/plan')).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(60_000);
    await check;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reports a non-JSON proxy error as a recoverable error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 502, ok: false, text: async () => '<html>Bad gateway</html>' }));
    await expect(api.get('/daily/plan')).rejects.toMatchObject({ status: 502 });
    await expect(api.get('/daily/plan')).rejects.toSatisfy((e: Error) => e.message.trim().length > 0);
  });
  it('bounds non-training requests too (full hands, scenarios)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));
    const check = expect(api.get('/sim/hands/x')).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(60_000);
    await check;
  });
  it('gives an empty-body, empty-status-text failure a readable message (HTTP/2 behind a proxy)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502, statusText: '' })));
    await expect(api.post('/mixed/sessions')).rejects.toMatchObject({ status: 502, message: 'Request failed (HTTP 502).' });
  });
});
