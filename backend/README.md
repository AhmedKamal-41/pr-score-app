# Backend (API + worker)

Setup, configuration, GitHub App permissions, recovery and troubleshooting are in the [root README](../README.md); architecture, the data pipeline, the scoring contract and the security model are in [project.md](../project.md).

## Processes

| Process | Dev | Production | Role |
|---|---|---|---|
| API | `pnpm dev:api` | `pnpm start` → `node dist/server.js` | webhooks (durable inbox), dashboard API, health/readiness |
| Worker | `pnpm dev:worker` | `pnpm start:worker` → `node dist/worker.js` | processes deliveries, re-dispatches due/lost deliveries |

`pnpm dev` runs both. Both read `backend/.env` (see `.env.example`).

## HTTP API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | public | liveness `{ ok: true }` |
| GET | `/ready` | public | `{ ok, checks: { database, redis } }`, 503 when a dependency is down |
| GET | `/api/version` | public | `{ version }` |
| POST | `/webhooks/github` | HMAC (`X-Hub-Signature-256`) | GitHub webhooks → `202` after durable storage |
| POST | `/api/auth/login` | Origin | `{ username, password }` → session cookie |
| POST | `/api/auth/logout` | Origin | revokes the session |
| GET | `/api/auth/session` | cookie (optional) | `{ authenticated, username? }` |
| GET | `/api/prs?limit=1..100&offset=` | session | PRs, newest update first, with the current-head score |
| GET | `/api/prs/:id` | session | PR detail, score history, AI state for the current head |
| GET | `/api/stats` | session | totals, level counts, average, top-10 folders |
| GET | `/api/admin/deliveries?status=&limit=` | session | webhook inbox (sanitised) |
| POST | `/api/admin/deliveries/recover` | session + Origin | `{ ids?, include_dead? }` → re-dispatch |
| POST | `/api/demo/seed` | session + Origin, `DEMO_ENABLED` | deterministic demo data (never in production) |
| GET | `/api/demo/status` | session | `{ enabled }` |

Errors always use `{ "error": { "message", "code", "requestId", "details"? } }`; every response carries `X-Request-ID`.

API compatibility: `github_pr_id` is kept as a deprecated alias of `number` (it always held the PR number); the real GitHub pull request id is exposed as `github_id` (string).

## Tests

```bash
pnpm test                 # unit (src/**/*.test.ts), with coverage
pnpm test:integration     # test/integration — needs `pnpm test-services:up` at the repository root
pnpm test:e2e             # builds, then test/e2e/smoke.test.ts
```
