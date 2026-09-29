import { Redis } from 'ioredis';

/**
 * Connection used by BullMQ workers and blocking commands: BullMQ requires
 * maxRetriesPerRequest=null so blocking calls survive reconnects.
 */
export function createWorkerRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false });
}

/**
 * Connection for request-path producers (API). Commands issued while Redis is
 * unreachable are failed after one reconnection attempt (maxRetriesPerRequest=1),
 * and every call site also bounds them with `withTimeout`, so a webhook request
 * never hangs; durably stored deliveries are re-dispatched later.
 * (enableOfflineQueue=false is deliberately not used: with a database index in
 * REDIS_URL, ioredis then rejects its own initial SELECT as an unhandled error.)
 */
export function createProducerRedis(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    retryStrategy: (times) => Math.min(times * 200, 2_000),
  });
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type { Redis };
