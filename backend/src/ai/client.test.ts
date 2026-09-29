import { describe, it, expect, vi } from 'vitest';
import { generateAiAnalysis, type AiClientOptions } from './client.js';

const prompt = { system: 'system text', user: 'user text' };

const validOutput = {
  summary: 'Touches authentication without tests; review session handling.',
  review_focus: ['Session expiry logic', 'Token validation path', 'Error handling on login'],
  test_suggestions: ['Expired session is rejected', 'Invalid token returns 401', 'Login rate limit applies'],
  rollback_risk: 'MED',
  confidence: 0.7,
};

function completion(content: string | null) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function options(fetchImpl: typeof fetch, overrides: Partial<AiClientOptions> = {}): AiClientOptions {
  return {
    apiKey: 'test-key-not-real',
    model: 'gpt-4o-mini',
    baseUrl: 'http://127.0.0.1:9/v1',
    timeoutMs: 1000,
    fetch: fetchImpl,
    sleep: async () => {},
    ...overrides,
  };
}

describe('generateAiAnalysis', () => {
  it('returns a config failure without calling the provider when no API key is set', async () => {
    const fetchImpl = vi.fn();
    const result = await generateAiAnalysis(prompt, options(fetchImpl as unknown as typeof fetch, { apiKey: null }));
    expect(result).toEqual({ ok: false, kind: 'config', error: 'OPENAI_API_KEY not configured', attempts: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns validated output and sends system and user messages separately', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.messages).toEqual([
        { role: 'system', content: 'system text' },
        { role: 'user', content: 'user text' },
      ]);
      expect(body.response_format).toEqual({ type: 'json_object' });
      return json(200, completion(JSON.stringify(validOutput)));
    });
    const result = await generateAiAnalysis(prompt, options(fetchImpl as unknown as typeof fetch));
    expect(result).toEqual({ ok: true, output: validOutput, attempts: 1 });
  });

  it('does not retry malformed JSON', async () => {
    const fetchImpl = vi.fn(async () => json(200, completion('not json {')));
    const result = await generateAiAnalysis(prompt, options(fetchImpl as unknown as typeof fetch));
    expect(result).toMatchObject({ ok: false, kind: 'invalid_output', attempts: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry schema violations', async () => {
    const fetchImpl = vi.fn(async () => json(200, completion(JSON.stringify({ ...validOutput, review_focus: ['one'] }))));
    const result = await generateAiAnalysis(prompt, options(fetchImpl as unknown as typeof fetch));
    expect(result).toMatchObject({ ok: false, kind: 'invalid_output', attempts: 1 });
  });

  it('rejects output that leaks a secret', async () => {
    const leaked = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
    const fetchImpl = vi.fn(async () => json(200, completion(JSON.stringify({ ...validOutput, summary: `Uses key ${leaked} in code` }))));
    const result = await generateAiAnalysis(prompt, options(fetchImpl as unknown as typeof fetch));
    expect(result).toMatchObject({ ok: false, kind: 'invalid_output' });
    if (!result.ok) expect(result.error).toContain('secret');
  });

  it('rejects an empty response', async () => {
    const fetchImpl = vi.fn(async () => json(200, completion(null)));
    const result = await generateAiAnalysis(prompt, options(fetchImpl as unknown as typeof fetch));
    expect(result).toMatchObject({ ok: false, kind: 'invalid_output' });
  });

  it('retries a rate limit once, honouring Retry-After, then succeeds', async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(429, { error: { message: 'rate limited' } }, { 'retry-after': '2' }))
      .mockResolvedValueOnce(json(200, completion(JSON.stringify(validOutput))));
    const result = await generateAiAnalysis(prompt, options(fetchImpl as unknown as typeof fetch, { sleep }));
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('gives up after the attempt limit on persistent service errors', async () => {
    const fetchImpl = vi.fn(async () => json(503, { error: { message: 'unavailable' } }));
    const result = await generateAiAnalysis(prompt, options(fetchImpl as unknown as typeof fetch));
    expect(result).toMatchObject({ ok: false, kind: 'unavailable', attempts: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('treats rejected credentials as a configuration failure without retry', async () => {
    const fetchImpl = vi.fn(async () => json(401, { error: { message: 'bad key' } }));
    const result = await generateAiAnalysis(prompt, options(fetchImpl as unknown as typeof fetch));
    expect(result).toMatchObject({ ok: false, kind: 'config', attempts: 1 });
  });

  it('aborts a hanging request at the deadline and clears timers', async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          signals.push(signal);
          signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    );
    const started = Date.now();
    const result = await generateAiAnalysis(prompt, options(fetchImpl as unknown as typeof fetch, { timeoutMs: 1000 }));
    expect(result).toMatchObject({ ok: false, kind: 'unavailable', attempts: 2 });
    expect(result.ok || result.error).toBe('AI request timed out');
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
