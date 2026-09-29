import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { isInWorkspace, type AppConfig } from '../config/env.js';

/**
 * Turn a verified webhook into one of: ping, ignore (no job), invalid (400),
 * or accept (store in the durable inbox and process).
 *
 * Subscribed events: pull_request, check_suite, status, installation,
 * installation_repositories (plus ping). See project.md → GitHub App setup.
 */

const positiveInt = z.number().int().positive();
const sha = z.string().regex(/^[0-9a-f]{40}$/, 'must be a 40-character hex commit SHA');
const repository = z.object({
  id: positiveInt,
  name: z.string().min(1),
  full_name: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'must be owner/name'),
  owner: z.object({ login: z.string().min(1) }),
  private: z.boolean(),
});
const installation = z.object({ id: positiveInt });
const repoRef = z.object({ id: positiveInt, full_name: z.string().min(1) });

export const PR_ACTIONS = ['opened', 'synchronize', 'reopened', 'edited', 'ready_for_review', 'converted_to_draft', 'closed'] as const;
export type PrAction = (typeof PR_ACTIONS)[number];

const pullRequestEvent = z.object({
  action: z.enum(PR_ACTIONS),
  number: positiveInt,
  pull_request: z.object({
    id: positiveInt,
    number: positiveInt,
    head: z.object({ sha }),
    base: z.object({ ref: z.string().min(1) }),
  }),
  repository,
  installation,
  changes: z.object({ base: z.unknown().optional() }).passthrough().optional(),
});

const checkSuiteEvent = z.object({
  action: z.literal('completed'),
  check_suite: z.object({
    head_sha: sha,
    conclusion: z.string().nullable().optional(),
    app: z.object({ id: z.number().int() }).nullable().optional(),
  }),
  repository,
  installation,
});

const statusEvent = z.object({
  sha,
  state: z.enum(['pending', 'success', 'failure', 'error']),
  context: z.string().optional(),
  repository,
  installation,
});

const installationEvent = z.object({
  action: z.enum(['created', 'deleted', 'suspend', 'unsuspend', 'new_permissions_accepted']),
  installation,
  repositories: z.array(repoRef).optional(),
});

const installationRepositoriesEvent = z.object({
  action: z.enum(['added', 'removed']),
  installation,
  repositories_added: z.array(repoRef).default([]),
  repositories_removed: z.array(repoRef).default([]),
});

export interface InboxRow {
  event: string;
  action: string | null;
  installation_id: bigint | null;
  repo_github_id: bigint | null;
  repo_full_name: string | null;
  pr_number: number | null;
  head_sha: string | null;
  payload: Prisma.InputJsonValue;
}

export type Classification =
  | { kind: 'ping' }
  | { kind: 'ignore'; reason: string }
  | { kind: 'invalid'; message: string; details: { path: string; message: string }[] }
  | { kind: 'accept'; row: InboxRow };

function invalid(error: z.ZodError, event: string): Classification {
  return {
    kind: 'invalid',
    message: `Malformed ${event} payload`,
    details: error.errors.slice(0, 10).map((e) => ({ path: e.path.join('.'), message: e.message })),
  };
}

function repoPayload(r: z.infer<typeof repository>) {
  return { id: r.id, full_name: r.full_name, owner: r.owner.login, name: r.name, private: r.private };
}

export function classifyWebhook(event: string, body: unknown, config: AppConfig): Classification {
  if (event === 'ping') return { kind: 'ping' };
  const action = (body as { action?: unknown } | null)?.action;

  switch (event) {
    case 'pull_request': {
      if (typeof action === 'string' && !(PR_ACTIONS as readonly string[]).includes(action)) {
        return { kind: 'ignore', reason: `pull_request.${action} does not affect risk analysis` };
      }
      const parsed = pullRequestEvent.safeParse(body);
      if (!parsed.success) return invalid(parsed.error, 'pull_request');
      const p = parsed.data;
      if (p.number !== p.pull_request.number) {
        return { kind: 'invalid', message: 'Malformed pull_request payload', details: [{ path: 'number', message: 'does not match pull_request.number' }] };
      }
      if (!isInWorkspace(config, p.installation.id, p.repository.full_name)) {
        return { kind: 'ignore', reason: 'installation or repository is not part of this workspace' };
      }
      return {
        kind: 'accept',
        row: {
          event,
          action: p.action,
          installation_id: BigInt(p.installation.id),
          repo_github_id: BigInt(p.repository.id),
          repo_full_name: p.repository.full_name,
          pr_number: p.number,
          head_sha: p.pull_request.head.sha,
          payload: {
            action: p.action,
            number: p.number,
            github_id: String(p.pull_request.id),
            head_sha: p.pull_request.head.sha,
            base_changed: Boolean(p.changes?.base),
            repository: repoPayload(p.repository),
          },
        },
      };
    }
    case 'check_suite': {
      if (action !== 'completed') return { kind: 'ignore', reason: `check_suite.${String(action)} is not a completion` };
      const parsed = checkSuiteEvent.safeParse(body);
      if (!parsed.success) return invalid(parsed.error, 'check_suite');
      const p = parsed.data;
      if (p.check_suite.app?.id !== undefined && String(p.check_suite.app.id) === config.github.appId) {
        return { kind: 'ignore', reason: "check suite created by this app (prevents feedback loops)" };
      }
      if (!isInWorkspace(config, p.installation.id, p.repository.full_name)) {
        return { kind: 'ignore', reason: 'installation or repository is not part of this workspace' };
      }
      return {
        kind: 'accept',
        row: {
          event,
          action: 'completed',
          installation_id: BigInt(p.installation.id),
          repo_github_id: BigInt(p.repository.id),
          repo_full_name: p.repository.full_name,
          pr_number: null,
          head_sha: p.check_suite.head_sha,
          payload: { head_sha: p.check_suite.head_sha, conclusion: p.check_suite.conclusion ?? null, repository: repoPayload(p.repository) },
        },
      };
    }
    case 'status': {
      const parsed = statusEvent.safeParse(body);
      if (!parsed.success) return invalid(parsed.error, 'status');
      const p = parsed.data;
      if (!isInWorkspace(config, p.installation.id, p.repository.full_name)) {
        return { kind: 'ignore', reason: 'installation or repository is not part of this workspace' };
      }
      return {
        kind: 'accept',
        row: {
          event,
          action: p.state,
          installation_id: BigInt(p.installation.id),
          repo_github_id: BigInt(p.repository.id),
          repo_full_name: p.repository.full_name,
          pr_number: null,
          head_sha: p.sha,
          payload: { head_sha: p.sha, state: p.state, context: p.context ?? null, repository: repoPayload(p.repository) },
        },
      };
    }
    case 'installation': {
      const parsed = installationEvent.safeParse(body);
      if (!parsed.success) {
        if (typeof action === 'string') return { kind: 'ignore', reason: `installation.${action} is not handled` };
        return invalid(parsed.error, 'installation');
      }
      const p = parsed.data;
      if (!isInWorkspace(config, p.installation.id)) return { kind: 'ignore', reason: 'installation is not part of this workspace' };
      return {
        kind: 'accept',
        row: {
          event,
          action: p.action,
          installation_id: BigInt(p.installation.id),
          repo_github_id: null,
          repo_full_name: null,
          pr_number: null,
          head_sha: null,
          payload: { action: p.action, repositories: (p.repositories ?? []).map((r) => ({ id: r.id, full_name: r.full_name })) },
        },
      };
    }
    case 'installation_repositories': {
      const parsed = installationRepositoriesEvent.safeParse(body);
      if (!parsed.success) return invalid(parsed.error, 'installation_repositories');
      const p = parsed.data;
      if (!isInWorkspace(config, p.installation.id)) return { kind: 'ignore', reason: 'installation is not part of this workspace' };
      return {
        kind: 'accept',
        row: {
          event,
          action: p.action,
          installation_id: BigInt(p.installation.id),
          repo_github_id: null,
          repo_full_name: null,
          pr_number: null,
          head_sha: null,
          payload: {
            action: p.action,
            added: p.repositories_added.map((r) => ({ id: r.id, full_name: r.full_name })),
            removed: p.repositories_removed.map((r) => ({ id: r.id, full_name: r.full_name })),
          },
        },
      };
    }
    default:
      return { kind: 'ignore', reason: `event "${event}" is not subscribed` };
  }
}
