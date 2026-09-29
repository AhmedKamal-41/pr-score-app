import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Centralized, typed configuration.
 *
 * Entry points call `loadConfig()` once (after `dotenv` has populated
 * `process.env`) and pass the result down. Library modules never read
 * `process.env` directly, so importing them has no side effects.
 *
 * Modes:
 *  - GITHUB_ENABLED=false (default outside production): local demo/mock mode.
 *    No GitHub credentials are needed; the webhook endpoint answers 503.
 *  - GITHUB_ENABLED=true: live mode. App id, private key, webhook secret and the
 *    workspace installation allowlist are required and validated up front.
 *  - AI_ENABLED / GITHUB_POST_COMMENTS: optional enrichment, off by default.
 */

/**
 * scrypt hash of the local-only example password `local-dev-password-change-me`
 * shipped in .env.example. Rejected when NODE_ENV=production.
 */
export const EXAMPLE_ADMIN_PASSWORD_HASH =
  'scrypt$17$8$1$yb2WYx_F2tjBN5OOXwGUIQ$bBoUsaCQatOP5W1yoYWPZ5t0wLCxUPksJQiGkVe-_5vNzvmlIRWMKPeZqNNgCBSCydcPkgbVveARxXbbzeJoew';

const boolFromEnv = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const csvIds = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (!v || v.trim() === '') return [] as bigint[];
    const out: bigint[] = [];
    for (const part of v.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!/^\d+$/.test(part)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid installation id "${part}"` });
        return z.NEVER;
      }
      out.push(BigInt(part));
    }
    return out;
  });

const csvRepos = z
  .string()
  .optional()
  .transform((v) =>
    !v ? [] : v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  );

const rawSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://127.0.0.1:6379'),
  /** Public origin of the dashboard; mutations must come from this Origin. */
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),
  TRUST_PROXY: boolFromEnv,

  ADMIN_USERNAME: z.string().min(1).default('admin'),
  ADMIN_PASSWORD_HASH: z.string().optional(),
  SESSION_TTL_HOURS: z.coerce.number().positive().max(24 * 30).default(12),

  GITHUB_ENABLED: boolFromEnv,
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_PRIVATE_KEY: z.string().optional(),
  GITHUB_PRIVATE_KEY_PATH: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  GITHUB_API_URL: z.string().url().default('https://api.github.com'),
  WORKSPACE_INSTALLATION_IDS: csvIds,
  WORKSPACE_REPOSITORIES: csvRepos,
  GITHUB_POST_COMMENTS: boolFromEnv,

  AI_ENABLED: boolFromEnv,
  AI_PROVIDER: z.enum(['openai']).default('openai'),
  AI_MODEL: z.string().min(1).default('gpt-4o-mini'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().optional(),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),

  DEMO_ENABLED: boolFromEnv,

  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
  DELIVERY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(6),
  DISPATCHER_INTERVAL_MS: z.coerce.number().int().min(250).default(15_000),
});

export type RawEnv = z.infer<typeof rawSchema>;

export interface AppConfig {
  nodeEnv: RawEnv['NODE_ENV'];
  isProduction: boolean;
  logLevel: RawEnv['LOG_LEVEL'];
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  frontendOrigin: string;
  trustProxy: boolean;
  auth: {
    username: string;
    passwordHash: string | null;
    sessionTtlMs: number;
  };
  github: {
    enabled: boolean;
    appId: string | null;
    privateKey: string | null;
    webhookSecret: string | null;
    apiUrl: string;
    installationIds: bigint[];
    repositories: string[];
    postComments: boolean;
  };
  ai: {
    enabled: boolean;
    provider: 'openai';
    model: string;
    apiKey: string | null;
    baseUrl: string | null;
    timeoutMs: number;
  };
  demoEnabled: boolean;
  worker: {
    concurrency: number;
    deliveryMaxAttempts: number;
    dispatcherIntervalMs: number;
  };
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

function readPrivateKey(env: RawEnv, problems: string[]): string | null {
  if (env.GITHUB_PRIVATE_KEY_PATH) {
    try {
      return readFileSync(env.GITHUB_PRIVATE_KEY_PATH, 'utf8');
    } catch {
      problems.push(`GITHUB_PRIVATE_KEY_PATH could not be read: ${env.GITHUB_PRIVATE_KEY_PATH}`);
      return null;
    }
  }
  if (env.GITHUB_PRIVATE_KEY) {
    // Allow single-line PEMs with literal "\n" escapes (common in .env files).
    return env.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n');
  }
  return null;
}

export function loadConfig(input: NodeJS.ProcessEnv = process.env): AppConfig {
  // Blank values (e.g. `OPENAI_BASE_URL=` in .env) mean "not set".
  const source: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
  const parsed = rawSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.errors.map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`),
    );
  }
  const env = parsed.data;
  const problems: string[] = [];
  const isProduction = env.NODE_ENV === 'production';

  // GitHub defaults to enabled in production, disabled elsewhere, unless set explicitly.
  const githubEnabled = source.GITHUB_ENABLED ? env.GITHUB_ENABLED : isProduction;
  const privateKey = githubEnabled ? readPrivateKey(env, problems) : null;

  if (githubEnabled) {
    if (!env.GITHUB_APP_ID) problems.push('GITHUB_APP_ID is required when GITHUB_ENABLED=true');
    if (!privateKey) {
      problems.push('GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_PATH is required when GITHUB_ENABLED=true');
    } else if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey)) {
      problems.push('GITHUB_PRIVATE_KEY does not look like a PEM private key');
    }
    if (!env.GITHUB_WEBHOOK_SECRET || env.GITHUB_WEBHOOK_SECRET.length < 16) {
      problems.push('GITHUB_WEBHOOK_SECRET (>= 16 characters) is required when GITHUB_ENABLED=true');
    }
    if (env.WORKSPACE_INSTALLATION_IDS.length === 0) {
      problems.push(
        'WORKSPACE_INSTALLATION_IDS is required when GITHUB_ENABLED=true (comma-separated GitHub App installation ids this workspace may process)',
      );
    }
  }

  if (env.AI_ENABLED && !env.OPENAI_API_KEY) {
    problems.push('OPENAI_API_KEY is required when AI_ENABLED=true');
  }
  if (env.GITHUB_POST_COMMENTS && !(githubEnabled && env.AI_ENABLED)) {
    problems.push('GITHUB_POST_COMMENTS=true requires GITHUB_ENABLED=true and AI_ENABLED=true');
  }

  if (!env.ADMIN_PASSWORD_HASH) {
    problems.push('ADMIN_PASSWORD_HASH is required (generate one with `pnpm --filter backend auth:hash-password`)');
  } else if (!env.ADMIN_PASSWORD_HASH.startsWith('scrypt$')) {
    problems.push('ADMIN_PASSWORD_HASH must be produced by `pnpm --filter backend auth:hash-password`');
  }

  if (isProduction) {
    if (env.ADMIN_PASSWORD_HASH === EXAMPLE_ADMIN_PASSWORD_HASH) {
      problems.push('ADMIN_PASSWORD_HASH is the published example hash; set a real password in production');
    }
    if (env.DEMO_ENABLED) problems.push('DEMO_ENABLED must not be true in production');
    if (!env.FRONTEND_URL.startsWith('https://')) {
      problems.push('FRONTEND_URL must be an https:// origin in production (session cookies are Secure)');
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    nodeEnv: env.NODE_ENV,
    isProduction,
    logLevel: env.LOG_LEVEL,
    host: env.HOST,
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    frontendOrigin: new URL(env.FRONTEND_URL).origin,
    trustProxy: env.TRUST_PROXY,
    auth: {
      username: env.ADMIN_USERNAME,
      passwordHash: env.ADMIN_PASSWORD_HASH ?? null,
      sessionTtlMs: env.SESSION_TTL_HOURS * 3600_000,
    },
    github: {
      enabled: githubEnabled,
      appId: env.GITHUB_APP_ID ?? null,
      privateKey,
      webhookSecret: env.GITHUB_WEBHOOK_SECRET ?? null,
      apiUrl: env.GITHUB_API_URL.replace(/\/+$/, ''),
      installationIds: env.WORKSPACE_INSTALLATION_IDS,
      repositories: env.WORKSPACE_REPOSITORIES,
      postComments: env.GITHUB_POST_COMMENTS,
    },
    ai: {
      enabled: env.AI_ENABLED,
      provider: env.AI_PROVIDER,
      model: env.AI_MODEL,
      apiKey: env.OPENAI_API_KEY ?? null,
      baseUrl: env.OPENAI_BASE_URL ?? null,
      timeoutMs: env.AI_TIMEOUT_MS,
    },
    demoEnabled: env.DEMO_ENABLED && !isProduction,
    worker: {
      concurrency: env.WORKER_CONCURRENCY,
      deliveryMaxAttempts: env.DELIVERY_MAX_ATTEMPTS,
      dispatcherIntervalMs: env.DISPATCHER_INTERVAL_MS,
    },
  };
}

/** Is this installation/repository part of the configured workspace? */
export function isInWorkspace(
  config: AppConfig,
  installationId: bigint | number | null | undefined,
  repoFullName?: string | null,
): boolean {
  if (installationId === null || installationId === undefined) return false;
  const id = BigInt(installationId);
  if (!config.github.installationIds.some((allowed) => allowed === id)) return false;
  if (config.github.repositories.length > 0 && repoFullName) {
    return config.github.repositories.includes(repoFullName.toLowerCase());
  }
  return true;
}
