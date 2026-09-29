# PR Risk Scorer

[![CI](https://github.com/AhmedKamal-41/pr-score-app/actions/workflows/ci.yml/badge.svg)](https://github.com/AhmedKamal-41/pr-score-app/actions/workflows/ci.yml)

A GitHub App that gives every pull request a **deterministic 0–100 risk score** (size, sensitive areas, missing tests, CI failure), with an **optional AI review** and an optional single PR comment, shown in a private single-workspace dashboard.

- **Backend** (`backend/`): Fastify 5 API + BullMQ worker, TypeScript, Prisma 5 / PostgreSQL 16, Redis 7.
- **Frontend** (`frontend/`): Next.js 15 (App Router, React 19), Tailwind CSS.
- Full technical reference (architecture, data pipeline, scoring contract, security model, test inventory, repair log): **[project.md](project.md)**.

## Requirements

| Tool | Version |
|---|---|
| Node.js | 24 LTS (`.nvmrc`; `engines` enforces `>=24 <25`) |
| pnpm | 12.3.4 (pinned in `packageManager`; `corepack enable` picks it up) |
| Docker + Compose | for PostgreSQL and Redis |

## Quick start (local demo mode — no GitHub or OpenAI credentials)

```bash
corepack enable                      # uses the pinned pnpm version
pnpm install --frozen-lockfile
pnpm services:up                     # PostgreSQL :5432 and Redis :6379, bound to 127.0.0.1
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local
pnpm --filter backend db:deploy      # apply migrations
pnpm --filter backend db:seed        # optional: deterministic demo data (safe to repeat)
pnpm dev                             # API :4000 + worker + dashboard :3000
```

Open http://localhost:3000 and sign in as `admin` / `local-dev-password-change-me` (the example password, which is **rejected when `NODE_ENV=production`**).

`pnpm dev` runs all three processes. Individually: `pnpm --filter backend dev:api`, `pnpm --filter backend dev:worker`, `pnpm --filter frontend dev`.

## Commands

| Command | What it does |
|---|---|
| `pnpm lint` | ESLint 9 (flat config) for backend and frontend, zero warnings allowed |
| `pnpm typecheck` | `tsc --noEmit` for both packages (backend includes tests and Prisma files) |
| `pnpm test` | Unit tests: backend (Vitest, with coverage) + frontend (Vitest + Testing Library) |
| `pnpm test:integration` | Backend integration tests against **disposable** PostgreSQL/Redis (see below) |
| `pnpm test:e2e` | Builds everything, then runs the compiled API + worker + `next start` against real PostgreSQL/Redis and mocked GitHub/OpenAI |
| `pnpm build` | Production builds (`backend/dist`, `frontend/.next`); the frontend builds without a running backend |
| `pnpm start` | Runs the three production processes together (or see "Production" below) |
| `pnpm --filter backend db:deploy` | Apply pending migrations (`prisma migrate deploy`) |
| `pnpm --filter backend db:status` | Show migration status |
| `pnpm --filter backend db:check` | Verify migrations reproduce `schema.prisma` (needs `SHADOW_DATABASE_URL`, a throwaway DB) |
| `pnpm --filter backend db:seed` | Deterministic demo data (refuses to run with `NODE_ENV=production`) |
| `pnpm --filter backend auth:hash-password` | Generate `ADMIN_PASSWORD_HASH` |
| `pnpm --filter backend deliveries:recover` | Re-dispatch failed webhook deliveries (`--include-dead`, `--id <guid>`, `--list`) |
| `pnpm --filter backend report:legacy-identity` | List pre-migration PR rows whose history cannot be verified |

### Test services

Integration and e2e tests never touch development data. They use `docker-compose.test.yml` (tmpfs PostgreSQL on `127.0.0.1:55432`, Redis on `127.0.0.1:56379`), refuse any database whose name does not end in `_test`, and block every non-loopback network connection, so real GitHub/OpenAI can never be called.

```bash
pnpm test-services:up
pnpm test:integration
pnpm test:e2e
pnpm test-services:down
```

Override with `TEST_DATABASE_URL` / `TEST_REDIS_URL` (CI uses service containers on the same ports).

## Configuration

All backend settings are documented in [`backend/.env.example`](backend/.env.example) and validated at startup by `backend/src/config/env.ts`; invalid or incomplete configuration stops the process with a list of every problem. The dashboard only needs `API_INTERNAL_URL` ([`frontend/.env.example`](frontend/.env.example)); it holds **no secrets** and nothing is exposed via `NEXT_PUBLIC_*`.

| Mode | Settings |
|---|---|
| Local demo | defaults: `GITHUB_ENABLED=false`, `AI_ENABLED=false`, `DEMO_ENABLED=true` |
| Live GitHub | `GITHUB_ENABLED=true`, `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY` or `GITHUB_PRIVATE_KEY_PATH`, `GITHUB_WEBHOOK_SECRET` (≥16 chars), `WORKSPACE_INSTALLATION_IDS` |
| AI review (paid) | `AI_ENABLED=true`, `OPENAI_API_KEY` (optional `AI_MODEL`, `OPENAI_BASE_URL`) |
| PR comments | `GITHUB_POST_COMMENTS=true` (requires live GitHub and AI) |
| Production | `NODE_ENV=production`: GitHub on by default, `FRONTEND_URL` must be `https://`, a real `ADMIN_PASSWORD_HASH`, `DEMO_ENABLED` forbidden, cookies `Secure` |

### Dashboard access

There is one workspace administrator. Set `ADMIN_USERNAME` and generate `ADMIN_PASSWORD_HASH`:

```bash
pnpm --filter backend auth:hash-password     # prompts; or: printf '%s' "$PASSWORD" | pnpm --filter backend auth:hash-password
```

Sessions are server-side (PostgreSQL, token hashed), in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` in production), expire after `SESSION_TTL_HOURS`, rotate on login and are revoked on logout. Failed logins are throttled (5 per IP / 20 per username per 15 minutes). Mutations require the dashboard's `Origin`. The dashboard shows only repositories of the configured installations (plus demo data), and hides repositories whose access was removed.

## GitHub App setup

1. **Create the App** (Settings → Developer settings → GitHub Apps → New GitHub App).
   - Webhook URL: `https://<your-api-host>/webhooks/github` (local: see below). Content type **application/json**. Set a webhook secret (≥16 characters) → `GITHUB_WEBHOOK_SECRET`.
   - Repository permissions:

     | Permission | Access | Used for |
     |---|---|---|
     | Metadata | Read (mandatory) | repository identity |
     | Pull requests | Read | PR metadata, paginated changed files and patches |
     | Checks | Read | check runs for the exact head SHA |
     | Commit statuses | Read | legacy commit statuses for the head SHA |
     | Issues | Read & write — **only if** `GITHUB_POST_COMMENTS=true` | find/create/update the single analysis comment |

     Contents permission is not needed. Missing Checks/Commit statuses permission is tolerated: CI is then reported as `unknown` ("CI data unavailable") and never counted as success.
   - Subscribe to events: **Pull request**, **Check suite**, **Status**. (`installation` and `installation_repositories` are always delivered to Apps and are handled to revoke/restore repository access.)
2. Generate a private key → `GITHUB_PRIVATE_KEY_PATH=/path/key.pem` (or paste into `GITHUB_PRIVATE_KEY` with `\n` escapes). Note the App ID → `GITHUB_APP_ID`.
3. Install the App on the repositories to monitor. The installation id (URL of the installation settings page) goes into `WORKSPACE_INSTALLATION_IDS`; events from other installations are acknowledged and ignored. Optionally restrict to `WORKSPACE_REPOSITORIES=owner/name,…`.

Handled pull request actions: `opened`, `synchronize`, `reopened`, `ready_for_review` (full analysis); `edited` (metadata, or full analysis if the base branch changed); `converted_to_draft`, `closed` incl. merges (metadata only — no AI re-run). `check_suite.completed` and `status` re-score open PRs whose **current** head is that SHA; events for obsolete heads and this App's own check suites are ignored.

### Local webhooks

Expose the local API with [smee.io](https://smee.io) (or ngrok) and use that URL as the App's webhook URL:

```bash
npx smee-client -u https://smee.io/<channel> --target http://127.0.0.1:4000/webhooks/github
```

Keep `AI_ENABLED=false` and `GITHUB_POST_COMMENTS=false` while developing unless you intend paid calls and real comments.

## Delivery guarantees and recovery

- A webhook is acknowledged (`202`) **only after** it is stored in `webhook_deliveries`. If it cannot be stored, the API answers `503`.
- **GitHub does not automatically redeliver failed deliveries.** After an outage, redeliver them yourself: GitHub App settings → **Advanced → Recent Deliveries** → select a failed delivery → **Redeliver** (or the REST API: `GET /app/hook/deliveries`, then `POST /app/hook/deliveries/{id}/attempts`, authenticated as the App).
- Redelivering is always safe: identical replays are de-duplicated; a replay of a delivery that previously failed here is processed again; a delivery id reused with different content is rejected (`409`).
- If Redis was down, stored deliveries are enqueued automatically by the worker's dispatcher (every `DISPATCHER_INTERVAL_MS`). Deliveries abandoned by a crashed worker are taken over after 10 minutes.
- Failed deliveries are retried with backoff (30 s … 30 min, or at the GitHub rate-limit reset) up to `DELIVERY_MAX_ATTEMPTS`, then marked `dead`. After fixing the cause:

  ```bash
  pnpm --filter backend deliveries:recover --list
  pnpm --filter backend deliveries:recover --include-dead      # or --id <delivery-guid>
  ```

  or call `POST /api/admin/deliveries/recover` (authenticated) — the worker must be running.
- Processing is at-least-once; results are idempotent: one analysis run per (PR, input fingerprint), so retries never duplicate scores, AI results or comments. External writes cannot be exactly-once: a comment created by GitHub whose id was lost in a crash is found by its hidden marker and updated instead of duplicated.

## Production

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm --filter backend db:deploy
# three long-running processes under a process manager (systemd, PM2, containers, …).
# Run node directly: pnpm does not forward SIGTERM to its child, which would skip graceful shutdown.
node backend/dist/server.js                                   # API          (cwd: backend/ or set env explicitly)
node backend/dist/worker.js                                   # worker + dispatcher
cd frontend && node node_modules/next/dist/bin/next start -p 3000   # dashboard (set API_INTERNAL_URL)
```

`pnpm start` runs all three together for a quick local check of the production build.

- Health: `GET /health` (liveness, no dependencies), `GET /ready` (PostgreSQL + Redis; `503` with `{"database":"down"|"up","redis":…}`, never credentials).
- `SIGTERM`/`SIGINT` shut down gracefully: the API stops accepting and drains requests; the worker finishes active jobs; queues, Redis and Prisma are closed.
- Put the API and dashboard behind HTTPS. Only `/webhooks/github` needs to be reachable from GitHub; the dashboard reaches the API via `API_INTERNAL_URL`. Set `TRUST_PROXY=true` only behind a trusted proxy.
- Keep PostgreSQL and Redis private (the Compose files bind them to `127.0.0.1`). Redis must use `maxmemory-policy noeviction` (BullMQ requirement).

## Troubleshooting

| Symptom | Check |
|---|---|
| Process exits with `Invalid configuration:` | Every problem is listed; fix `backend/.env` (blank values count as unset). |
| Webhooks return `401` | `GITHUB_WEBHOOK_SECRET` must equal the App's secret; payloads must be sent unmodified (proxies must not re-encode JSON). |
| Webhooks return `503 GITHUB_DISABLED` | `GITHUB_ENABLED=false` (local demo mode). |
| Webhooks `202` but nothing is processed | The worker is not running (`pnpm dev` starts it). `deliveries:recover --list` shows stuck deliveries. |
| `/ready` reports `redis: down` | Webhooks are still accepted and stored; they are dispatched when Redis returns. |
| Deliveries `dead` with `403` | App permissions (see table) — then `deliveries:recover --include-dead`. |
| CI shows `unknown` | No checks yet, only neutral/skipped/cancelled runs, or missing Checks/Commit statuses permission — see the uncertainty note on the PR page. |
| Dashboard redirects to `/login` | Session expired or revoked; unauthenticated requests are never served data. |
| `pnpm install` fails on build scripts | pnpm ≥10 only runs allow-listed build scripts (`allowBuilds` in `pnpm-workspace.yaml`). |
| Integration tests cannot connect | `pnpm test-services:up`; they refuse databases not named `*_test`. |

## Project layout

```
backend/
  prisma/                 schema.prisma + append-only migrations
  src/server.ts           API entry point        src/worker.ts   worker entry point
  src/app.ts              Fastify app factory (no side effects on import)
  src/config/             typed configuration, constants
  src/http/ src/routes/   plugins (errors, request ids, sessions) and routes
  src/webhooks/           signature verification, payload classification, durable inbox
  src/jobs/               delivery processor, dispatcher/recovery
  src/analysis/           per-PR orchestration, leases, fingerprints
  src/github/             App auth, paginated fetching, CI normalisation, comments, retry policy
  src/scoring/            deterministic scoring contract v2
  src/ai/                 file selection, redaction, prompt, client, output validation
  src/api/                API view models and SQL aggregation
  src/demo/ src/cli/      demo seed and operational CLIs
  test/                   integration + e2e suites, mocks, guarded setup
frontend/
  src/app/                pages (/, /login, /prs, /prs/[id], /stats) and the /api proxy
  src/components/ src/lib/
docker-compose.yml        development services     docker-compose.test.yml  disposable test services
.github/workflows/ci.yml  CI
```

## License

Private.
