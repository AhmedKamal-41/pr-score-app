import OpenAI, { type ClientOptions } from 'openai';
import type { AiOutput } from './types.js';
import { validateAiOutput } from './validator.js';

/**
 * OpenAI chat-completions client for the structured PR review.
 *
 * Retry policy (the only one; the SDK's own retries are disabled):
 *   - at most `maxAttempts` (default 2) attempts in total;
 *   - retried: HTTP 429, HTTP 5xx, connection errors and our timeout;
 *   - not retried: other 4xx, empty/malformed JSON, schema or safety failures;
 *   - backoff: 1 s, or Retry-After when the provider sends one (capped at 5 s).
 * Every attempt has a real deadline: an AbortController cancels the HTTP
 * request and its timer is always cleared.
 */

export interface AiClientOptions {
  apiKey: string | null;
  model: string;
  baseUrl?: string | null;
  timeoutMs: number;
  maxAttempts?: number;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export type AiFailureKind =
  /** Missing credentials or configuration. */
  | 'config'
  /** Provider unreachable, rate limited, timed out or erroring. */
  | 'unavailable'
  /** Provider answered, but not with valid, safe output. */
  | 'invalid_output';

export type AiResult =
  | { ok: true; output: AiOutput; attempts: number }
  | { ok: false; kind: AiFailureKind; error: string; attempts: number };

const MAX_RETRY_AFTER_MS = 5_000;
const DEFAULT_BACKOFF_MS = 1_000;
const MAX_OUTPUT_TOKENS = 1000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class AttemptError extends Error {
  constructor(
    message: string,
    public readonly kind: AiFailureKind,
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** openai v4 exposes error headers as a plain record; tolerate a Headers instance too. */
function retryAfterMs(headers: unknown): number | undefined {
  let value: string | null | undefined;
  if (headers instanceof Headers) value = headers.get('retry-after');
  else if (headers && typeof headers === 'object') value = (headers as Record<string, string | undefined>)['retry-after'];
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  return undefined;
}

function classify(err: unknown, timedOut: boolean): AttemptError {
  if (timedOut) return new AttemptError('AI request timed out', 'unavailable', true);
  if (err instanceof OpenAI.APIError && typeof err.status === 'number') {
    const status = err.status;
    if (status === 429) return new AttemptError('AI provider rate limited the request (429)', 'unavailable', true, retryAfterMs(err.headers));
    if (status >= 500) return new AttemptError(`AI provider error (${status})`, 'unavailable', true);
    if (status === 401 || status === 403) return new AttemptError(`AI provider rejected credentials (${status})`, 'config', false);
    return new AttemptError(`AI provider rejected the request (${status})`, 'unavailable', false);
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new AttemptError('AI provider connection failed', 'unavailable', true);
  }
  if (err instanceof AttemptError) return err;
  return new AttemptError(`AI request failed: ${err instanceof Error ? err.name : 'unknown error'}`, 'unavailable', false);
}

export async function generateAiAnalysis(
  prompt: { system: string; user: string },
  options: AiClientOptions,
): Promise<AiResult> {
  if (!options.apiKey) {
    return { ok: false, kind: 'config', error: 'OPENAI_API_KEY not configured', attempts: 0 };
  }
  const maxAttempts = options.maxAttempts ?? 2;
  const sleep = options.sleep ?? defaultSleep;
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl ?? undefined,
    maxRetries: 0,
    // Backstop only; the per-attempt AbortController below is authoritative.
    timeout: options.timeoutMs + 5_000,
    // The SDK declares its own structural Fetch type (URLLike etc.); the
    // platform fetch is runtime-compatible, so adapt it at this boundary.
    fetch: (options.fetch ?? globalThis.fetch) as unknown as ClientOptions['fetch'],
  });

  let last: AttemptError | undefined;
  let attemptsMade = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attemptsMade = attempt;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs);
    try {
      const completion = await client.chat.completions.create(
        {
          model: options.model,
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.2,
          max_tokens: MAX_OUTPUT_TOKENS,
        },
        { signal: controller.signal },
      );
      const content = completion.choices[0]?.message?.content;
      if (!content) throw new AttemptError('AI returned an empty response', 'invalid_output', false);
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new AttemptError('AI response was not valid JSON', 'invalid_output', false);
      }
      const validation = validateAiOutput(parsed);
      if (!validation.valid) throw new AttemptError(validation.error, 'invalid_output', false);
      return { ok: true, output: validation.data, attempts: attempt };
    } catch (err) {
      last = classify(err, timedOut);
      if (!last.retryable || attempt === maxAttempts) break;
      await sleep(last.retryAfterMs ?? DEFAULT_BACKOFF_MS);
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    ok: false,
    kind: last?.kind ?? 'unavailable',
    error: last?.message ?? 'AI analysis failed',
    attempts: attemptsMade,
  };
}
