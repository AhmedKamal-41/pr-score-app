# PR Risk Scorer — Complete Project Reference

> Everything about this project in one document: what it does, how to run it, how every part works, every configuration setting, endpoint, table, script and file, how it is tested and verified, and what changed in the repair of the original commit `6a7680b`.
> All numbers in this document come from executed runs (see [§22](#22-verification-results)).

## Contents

**Part I — Using the project**
1. [What it is](#1-what-it-is)
2. [Technology stack](#2-technology-stack)
3. [Quick start (local demo)](#3-quick-start-local-demo)
4. [All commands and scripts](#4-all-commands-and-scripts)
5. [Configuration reference (every setting)](#5-configuration-reference-every-setting)
6. [GitHub App setup](#6-github-app-setup)
7. [Running in production](#7-running-in-production)
8. [Operations: delivery recovery and legacy data](#8-operations-delivery-recovery-and-legacy-data)
9. [Troubleshooting](#9-troubleshooting)

**Part II — How it works**
10. [Architecture](#10-architecture)
11. [Webhook intake and the durable inbox](#11-webhook-intake-and-the-durable-inbox)
12. [Delivery processing, retries and recovery](#12-delivery-processing-retries-and-recovery)
13. [Per-PR analysis: revisions, idempotency, concurrency](#13-per-pr-analysis-revisions-idempotency-concurrency)
14. [GitHub integration](#14-github-integration)
15. [Scoring contract v2](#15-scoring-contract-v2)
16. [AI review](#16-ai-review)
17. [PR comments](#17-pr-comments)
18. [Data model and migrations](#18-data-model-and-migrations)
19. [HTTP API reference](#19-http-api-reference)
20. [Dashboard (frontend)](#20-dashboard-frontend)
21. [Security model](#21-security-model)

**Part III — Quality and history**
22. [Verification results](#22-verification-results)
23. [Testing: strategy and full inventory](#23-testing-strategy-and-full-inventory)
24. [Continuous integration](#24-continuous-integration)
25. [Demo data](#25-demo-data)
26. [Tunables](#26-tunables)
27. [File-by-file index](#27-file-by-file-index)
28. [Repair log: issues → fixes → verification](#28-repair-log-issues--fixes--verification)
29. [Known limitations and unverified live checks](#29-known-limitations-and-unverified-live-checks)
30. [Glossary](#30-glossary)

---

# Part I — Using the project

## 1. What it is

**PR Risk Scorer** is a single-workspace GitHub App with a private dashboard. For every pull request revision in the GitHub App installations you configure, it:

1. receives GitHub's signed webhook and **stores it durably before acknowledging it**,
2. fetches the pull request, **all** of its changed files (paginated) and the CI results for the exact head commit,
3. computes a **deterministic 0–100 risk score** with the top three reasons, every rule's contribution and explicit uncertainties (for example "CI still running"),
4. optionally (`AI_ENABLED=true`) asks an LLM (OpenAI, `gpt-4o-mini` by default) for a structured review of the three riskiest diffs: summary, what to review first, tests to add, rollback risk, model-reported confidence, warnings,
5. optionally (`GITHUB_POST_COMMENTS=true`) keeps **one** comment by the App on the pull request up to date,
6. shows everything per revision in an authenticated dashboard: pull request list, detail page with score history and AI review, and workspace statistics including the riskiest folders.

**"Risk"** here is a review-prioritisation heuristic built from size (files and lines), whether sensitive areas are touched (authentication, payments, configuration, infrastructure, migrations, CI workflows), whether tests changed, and whether CI failed. It does not execute or statically analyse code, and a high or low score is not proof of anything.

**Out of scope:** public sign-up, multi-tenant SaaS, trained/learned risk models, automatic code fixes, automatic merging. Code from pull requests is never executed; diffs are only read as text.

## 2. Technology stack

| Layer | Technology (version) | Role / notes |
|---|---|---|
| Monorepo | pnpm workspaces (`backend`, `frontend`) | pnpm **12.3.4** pinned in `packageManager` |
| Runtime | Node.js **24 LTS** | `.nvmrc`; `engines: >=24 <25` in every package |
| Language | TypeScript 5.9 (strict) | both packages |
| API server | Fastify **5.12**, `fastify-raw-body` 5, `@fastify/cookie` 11, `fastify-plugin` 5 | webhooks + dashboard API |
| Queue | BullMQ 5 on Redis 7 (`ioredis` 5) | carries only a pointer to the stored delivery |
| Database | PostgreSQL 16, Prisma **5.22** | system of record, append-only migrations |
| GitHub | `@octokit/rest` 20, `@octokit/auth-app` 6 | GitHub App installation authentication |
| AI | `openai` 4 (Chat Completions, JSON mode) | off by default |
| Validation | Zod 3 | configuration, requests, webhook payloads, AI output |
| Logging | Pino 9 (+ `pino-pretty` in development) | structured JSON, redacted |
| Frontend | Next.js **15.5.26** (App Router), React 19, Tailwind CSS 3 | every data page rendered per request |
| Tests | Vitest **4.1**, Testing Library, jsdom, `pg` | real PostgreSQL/Redis for integration and e2e |
| Lint | ESLint 9 flat config, typescript-eslint 8.70, eslint-config-next 15 | zero warnings allowed |
| Local infrastructure | Docker Compose | `docker-compose.yml` (dev), `docker-compose.test.yml` (tests) |
| CI | GitHub Actions | `.github/workflows/ci.yml` |

Dependency audit: `pnpm audit` reports **no known vulnerabilities** (after upgrading Fastify 4→5, Next 14→15.5.26, Vitest→4.1.11 and overriding the `postcss` copy pinned inside Next). Prisma 5, Octokit 20/6 and openai 4 are older majors with no published advisories; they were kept to avoid unrelated migrations.

## 3. Quick start (local demo)

Local demo mode needs **no GitHub or OpenAI credentials**.

**Requirements:** Node 24, pnpm 12.3.4 (`corepack enable` picks the pinned version), Docker with Compose.

```bash
corepack enable                               # use the pinned pnpm version
pnpm install --frozen-lockfile                # exact dependency versions from pnpm-lock.yaml
pnpm services:up                              # PostgreSQL :5432 and Redis :6379, bound to 127.0.0.1
cp backend/.env.example backend/.env          # local demo configuration
cp frontend/.env.example frontend/.env.local  # dashboard → API address
pnpm --filter backend db:deploy               # apply database migrations
pnpm --filter backend db:seed                 # optional: 11 deterministic demo PRs (safe to repeat)
pnpm dev                                      # API :4000 + worker + dashboard :3000
```

Open **http://localhost:3000** and sign in as **`admin` / `local-dev-password-change-me`**. This example password is refused when `NODE_ENV=production`.

`pnpm dev` starts all three processes (API, worker, dashboard). They can also be started individually: `pnpm --filter backend dev:api`, `pnpm --filter backend dev:worker`, `pnpm --filter frontend dev`.

To stop the services: `pnpm services:down` (data is kept in Docker volumes).

## 4. All commands and scripts

### Root (`package.json`)

| Command | What it does |
|---|---|
| `pnpm dev` | API + worker + dashboard in watch mode (via `concurrently`) |
| `pnpm build` | backend build (`prisma generate` + `tsc` → `backend/dist`) then frontend production build (`frontend/.next`) |
| `pnpm start` | runs the three production processes together (a quick local check of the build) |
| `pnpm lint` | ESLint in both packages, `--max-warnings 0` |
| `pnpm typecheck` | `tsc --noEmit` in both packages (backend includes tests and Prisma files) |
| `pnpm test` | backend unit tests (with coverage) + frontend tests |
| `pnpm test:integration` | backend integration tests (needs the test services) |
| `pnpm test:e2e` | builds everything, then the end-to-end smoke test |
| `pnpm services:up` / `services:down` | development PostgreSQL + Redis (`docker-compose.yml`) |
| `pnpm test-services:up` / `test-services:down` | disposable test PostgreSQL + Redis (`docker-compose.test.yml`) |

### Backend (`pnpm --filter backend <script>`)

| Script | Command | Purpose |
|---|---|---|
| `dev` | `concurrently dev:api dev:worker` | both backend processes in watch mode |
| `dev:api` | `tsx watch src/server.ts` | API in watch mode |
| `dev:worker` | `tsx watch src/worker.ts` | worker in watch mode |
| `build` | `prisma generate && tsc -p tsconfig.build.json` | compile `src/` to `dist/` |
| `start` | `node dist/server.js` | production API |
| `start:worker` | `node dist/worker.js` | production worker |
| `lint` | `eslint . --max-warnings 0` | lint |
| `typecheck` | `prisma generate && tsc -p tsconfig.json --noEmit` | type-check source, tests and Prisma files |
| `test` | `vitest run --project unit --coverage` | unit tests with coverage (`backend/coverage/`) |
| `test:watch` | `vitest --project unit` | unit tests in watch mode |
| `test:integration` | `vitest run --project integration` | integration tests |
| `test:e2e` | build backend + frontend, `vitest run --project e2e` | end-to-end smoke test |
| `db:generate` | `prisma generate` | generate the Prisma client |
| `db:migrate` | `prisma migrate dev` | create/apply migrations during development |
| `db:deploy` | `prisma migrate deploy` | apply pending migrations (production and upgrades) |
| `db:status` | `prisma migrate status` | show migration status |
| `db:check` | `prisma validate && prisma migrate diff … --exit-code` | prove the migrations reproduce `schema.prisma` (needs `SHADOW_DATABASE_URL`, a throwaway database) |
| `db:seed` | `tsx src/cli/seed-demo.ts` | deterministic demo data (refuses `NODE_ENV=production`) |
| `db:studio` | `prisma studio` | browse the database |
| `auth:hash-password` | `tsx src/cli/hash-password.ts` | produce `ADMIN_PASSWORD_HASH` |
| `deliveries:recover` | `tsx src/cli/recover-deliveries.ts` | re-dispatch failed webhook deliveries (`--list`, `--include-dead`, `--id <guid>`) |
| `report:legacy-identity` | `tsx src/cli/report-legacy-identity.ts` | list pre-migration PR rows whose history cannot be verified |

### Frontend (`pnpm --filter frontend <script>`)

| Script | Command |
|---|---|
| `dev` | `next dev -p 3000` |
| `build` | `next build` (does not need a running backend) |
| `start` | `next start -p ${PORT:-3000}` |
| `lint` | `eslint . --max-warnings 0` |
| `typecheck` | `tsc --noEmit` |
| `test` | `vitest run` (jsdom + Testing Library) |

### Running the tests

```bash
pnpm test-services:up        # tmpfs PostgreSQL on 127.0.0.1:55432, Redis on 127.0.0.1:56379
pnpm lint && pnpm typecheck && pnpm test
pnpm test:integration
pnpm test:e2e
pnpm test-services:down
```

## 5. Configuration reference (every setting)

Backend settings are read from `backend/.env` (template: `backend/.env.example`) by both the API and the worker, and validated at startup by `backend/src/config/env.ts`. Invalid or incomplete configuration stops the process and prints **every** problem. Blank values (`KEY=`) mean "not set".

### Modes

| Mode | How to enable | Requirements |
|---|---|---|
| Local demo | defaults (`GITHUB_ENABLED=false`) | `DATABASE_URL`, `ADMIN_PASSWORD_HASH` |
| Live GitHub | `GITHUB_ENABLED=true` (default when `NODE_ENV=production`) | `GITHUB_APP_ID`, a private key, `GITHUB_WEBHOOK_SECRET` (≥ 16 chars), `WORKSPACE_INSTALLATION_IDS` |
| AI review | `AI_ENABLED=true` | `OPENAI_API_KEY` |
| PR comments | `GITHUB_POST_COMMENTS=true` | live GitHub **and** AI enabled |
| Production | `NODE_ENV=production` | `FRONTEND_URL` must be `https://`; a real `ADMIN_PASSWORD_HASH` (the example hash is rejected); `DEMO_ENABLED` must not be true |

### Backend variables

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV` | `development` | `development` (pretty logs), `test`, or `production` (Secure cookies, strict checks, GitHub on by default) |
| `LOG_LEVEL` | `info` | `fatal`…`trace` or `silent` |
| `HOST` | `127.0.0.1` | API listen address |
| `PORT` | `4000` | API port |
| `DATABASE_URL` | — (required) | PostgreSQL connection string |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection string (a database index such as `/1` is allowed) |
| `FRONTEND_URL` | `http://localhost:3000` | public dashboard origin; state-changing requests must carry this `Origin` |
| `TRUST_PROXY` | `false` | trust `X-Forwarded-*` (only behind a trusted reverse proxy) |
| `ADMIN_USERNAME` | `admin` | dashboard username |
| `ADMIN_PASSWORD_HASH` | — (required) | scrypt hash from `auth:hash-password` |
| `SESSION_TTL_HOURS` | `12` | session lifetime (max 720) |
| `DEMO_ENABLED` | `false` | allow `POST /api/demo/seed` (never in production) |
| `GITHUB_ENABLED` | `false` (`true` in production) | live GitHub integration; when false the webhook answers `503` |
| `GITHUB_APP_ID` | — | GitHub App id |
| `GITHUB_PRIVATE_KEY` | — | App private key PEM (single line with `\n` escapes accepted) |
| `GITHUB_PRIVATE_KEY_PATH` | — | alternative: path to the `.pem` file |
| `GITHUB_WEBHOOK_SECRET` | — | webhook secret, ≥ 16 characters, must match the App settings |
| `GITHUB_API_URL` | `https://api.github.com` | GitHub Enterprise Server: `https://<host>/api/v3` |
| `WORKSPACE_INSTALLATION_IDS` | — | comma-separated installation ids this workspace processes and shows |
| `WORKSPACE_REPOSITORIES` | — | optional allowlist `owner/name,…` within those installations |
| `GITHUB_POST_COMMENTS` | `false` | maintain one analysis comment per PR |
| `AI_ENABLED` | `false` | enable the AI review (paid) |
| `AI_PROVIDER` | `openai` | only `openai` is supported |
| `AI_MODEL` | `gpt-4o-mini` | model name, stored with each analysis |
| `OPENAI_API_KEY` | — | OpenAI key |
| `OPENAI_BASE_URL` | — | alternative OpenAI-compatible endpoint (tests use a local mock) |
| `AI_TIMEOUT_MS` | `20000` | per-attempt deadline (1,000–120,000) |
| `WORKER_CONCURRENCY` | `5` | parallel deliveries per worker process |
| `DELIVERY_MAX_ATTEMPTS` | `6` | attempts before a delivery is marked `dead` |
| `DISPATCHER_INTERVAL_MS` | `15000` | how often the worker re-dispatches due/lost deliveries |

### Frontend variables (`frontend/.env.local`)

| Variable | Default | Meaning |
|---|---|---|
| `API_INTERNAL_URL` | `http://127.0.0.1:4000` | backend URL used by server rendering and the `/api` proxy — server-only, never sent to the browser |
| `NEXT_TELEMETRY_DISABLED` | — | set `1` to disable Next.js telemetry |
| `PORT` | `3000` | port for `pnpm --filter frontend start` |

The dashboard holds **no secrets**, and nothing is exposed through `NEXT_PUBLIC_*`.

### Test variables

| Variable | Default |
|---|---|
| `TEST_DATABASE_URL` | `postgresql://postgres:postgres@127.0.0.1:55432/pr_risk_scorer_test` (name must end in `_test`) |
| `TEST_REDIS_URL` | `redis://127.0.0.1:56379/1` |
| `SHADOW_DATABASE_URL` | throwaway database for `db:check` |

### Dashboard login

There is one workspace administrator.

```bash
pnpm --filter backend auth:hash-password                          # prompts for the password (≥ 12 characters)
printf '%s' "$PASSWORD" | pnpm --filter backend auth:hash-password # non-interactive
```

Put the output in `ADMIN_PASSWORD_HASH`. Sessions are stored server-side and delivered in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` in production); see [§21](#21-security-model).

## 6. GitHub App setup

1. **Create the App** (GitHub → Settings → Developer settings → GitHub Apps → New GitHub App).
   - **Webhook URL:** `https://<your-api-host>/webhooks/github` (for local development see "Local webhooks" below). Content type **application/json**.
   - **Webhook secret:** a random string of at least 16 characters → `GITHUB_WEBHOOK_SECRET`.
   - **Repository permissions:**

     | Permission | Access | Used for |
     |---|---|---|
     | Metadata | Read (mandatory) | repository identity |
     | Pull requests | Read | PR metadata, paginated changed files and patches |
     | Checks | Read | check runs for the exact head SHA |
     | Commit statuses | Read | legacy commit statuses for the head SHA |
     | Issues | Read & write — **only if** `GITHUB_POST_COMMENTS=true` | find, create and update the single analysis comment |

     Contents permission is **not** needed. If Checks or Commit statuses permission is missing, CI is reported as `unknown` ("CI data unavailable") and never counted as success.
   - **Subscribe to events:** **Pull request**, **Check suite**, **Status**. The `installation` and `installation_repositories` events are always delivered to Apps; they are used to revoke and restore repository access.
2. **Generate a private key** → `GITHUB_PRIVATE_KEY_PATH=/path/to/key.pem`, or paste it into `GITHUB_PRIVATE_KEY` with `\n` escapes. Copy the **App ID** → `GITHUB_APP_ID`.
3. **Install the App** on the repositories to monitor. The installation id (the number in the installation settings page URL) goes into `WORKSPACE_INSTALLATION_IDS`. Events from other installations are acknowledged and ignored. Optionally restrict repositories with `WORKSPACE_REPOSITORIES`.
4. Set `GITHUB_ENABLED=true` and restart the API and worker.

**Handled pull request actions**

| Action | Processing |
|---|---|
| `opened`, `synchronize`, `reopened`, `ready_for_review` | full analysis |
| `edited` | full analysis if the base branch changed, otherwise metadata refresh |
| `converted_to_draft`, `closed` (including merges) | metadata refresh only — no AI re-run |
| other actions (`labeled`, `assigned`, …) | acknowledged and ignored |

`check_suite.completed` and `status` events re-score open PRs whose **current** head is that commit. Events for older heads, and check suites created by this App itself, are ignored.

### Local webhooks

Expose the local API with [smee.io](https://smee.io) (or ngrok) and use that URL as the App's webhook URL:

```bash
npx smee-client -u https://smee.io/<channel> --target http://127.0.0.1:4000/webhooks/github
```

Keep `AI_ENABLED=false` and `GITHUB_POST_COMMENTS=false` while developing unless you intend to make paid AI calls and post real comments.

## 7. Running in production

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm --filter backend db:deploy
```

Run three long-lived processes under a process manager (systemd, PM2, containers …). **Run `node` directly** — pnpm does not forward `SIGTERM` to its child, which would skip graceful shutdown:

```bash
node backend/dist/server.js                                        # API
node backend/dist/worker.js                                        # worker + dispatcher
cd frontend && node node_modules/next/dist/bin/next start -p 3000  # dashboard (set API_INTERNAL_URL)
```

- **Health:** `GET /health` (liveness, no dependencies) and `GET /ready` (PostgreSQL + Redis; `503` with `{"database":"up|down","redis":"up|down"}`, never credentials).
- **Shutdown:** on `SIGTERM`/`SIGINT` the API stops accepting connections and drains requests (forced exit after 15 s); the worker stops dispatching, finishes active jobs (forced exit after 60 s) and closes the queue, Redis and Prisma.
- Serve the API and dashboard over HTTPS. Only `/webhooks/github` must be reachable from GitHub; the dashboard reaches the API through `API_INTERNAL_URL`. Set `TRUST_PROXY=true` only behind a trusted proxy.
- Keep PostgreSQL and Redis private (the Compose files bind them to `127.0.0.1`). Redis must use `maxmemory-policy noeviction` (a BullMQ requirement; set in both Compose files).
- More than one worker process may run: work on a PR is serialised by a database lease and deliveries are claimed atomically.

## 8. Operations: delivery recovery and legacy data

### Delivery guarantees

- A webhook is acknowledged (`202`) **only after** it is stored in the `webhook_deliveries` table. If it cannot be stored, the API answers `503`.
- Processing is **at-least-once**; results are **idempotent** (one analysis run per pull request and input fingerprint), so retries never duplicate scores, AI results or comments.
- External writes cannot be exactly-once: a comment that GitHub created but whose id was lost in a crash is found by its hidden marker and updated, not duplicated.

### Recovery procedure

1. **GitHub never redelivers failed webhooks by itself.** After an outage in which the API returned an error or was unreachable, redeliver from *GitHub App settings → Advanced → Recent Deliveries → Redeliver*, or via the REST API (`GET /app/hook/deliveries`, then `POST /app/hook/deliveries/{id}/attempts`, authenticated as the App). Redelivery is always safe:
   - an identical replay is recognised as a duplicate,
   - a replay of a delivery that failed here is processed again,
   - the same delivery id with different content is rejected (`409`).
2. **Deliveries stored but failed or given up ("dead")** — after fixing the cause:

   ```bash
   pnpm --filter backend deliveries:recover --list            # show deliveries not yet succeeded/ignored
   pnpm --filter backend deliveries:recover                   # retry failed deliveries now
   pnpm --filter backend deliveries:recover --include-dead    # also retry dead ones
   pnpm --filter backend deliveries:recover --id <guid>       # specific deliveries
   ```

   or `POST /api/admin/deliveries/recover` from an authenticated session. The worker must be running.
3. **Redis outages need no action:** stored deliveries are enqueued automatically by the worker's dispatcher when Redis returns. Deliveries abandoned by a crashed worker are taken over after 10 minutes.

### Upgrading a database created by the original code

1. Back up the database.
2. `pnpm --filter backend db:deploy` (applies the additive migration; nothing is deleted).
3. `pnpm --filter backend report:legacy-identity` — lists every PR row that predates the identity fix and flags possible cross-repository collisions (see [§18](#18-data-model-and-migrations)).
4. Review the flagged rows. Their legacy history stays labelled `legacy_unknown`; new data attaches correctly.

## 9. Troubleshooting

| Symptom | What to check |
|---|---|
| Process exits with `Invalid configuration:` | every problem is listed; fix `backend/.env` (blank values count as unset) |
| Webhooks return `401` | `GITHUB_WEBHOOK_SECRET` must equal the App's secret; proxies must not re-encode the JSON body |
| Webhooks return `503 GITHUB_DISABLED` | `GITHUB_ENABLED=false` (local demo mode) |
| Webhooks return `202` but nothing is processed | the worker is not running (`pnpm dev` starts it); `deliveries:recover --list` shows stuck deliveries |
| `/ready` reports `redis: down` | webhooks are still accepted and stored; they are dispatched when Redis returns |
| Deliveries end `dead` with `403` | App permissions (see [§6](#6-github-app-setup)), then `deliveries:recover --include-dead` |
| CI shows `unknown` | no checks yet, only neutral/skipped/cancelled runs, or missing Checks/Commit statuses permission — see the uncertainty note on the PR page |
| AI status `unavailable` / `failed` | provider error/timeout, or output rejected as invalid or unsafe; the deterministic score is unaffected |
| Dashboard redirects to `/login` | session expired or revoked |
| `pnpm install` stops on build scripts | pnpm ≥ 10 only runs allow-listed build scripts (`allowBuilds` in `pnpm-workspace.yaml`) |
| Integration tests cannot connect | `pnpm test-services:up`; tests refuse databases whose name does not end in `_test` |
| A process ignores `SIGTERM` in production | run `node dist/*.js` directly, not through pnpm |

---

# Part II — How it works

## 10. Architecture

```mermaid
flowchart LR
  GH[GitHub] -- signed webhook --> API
  subgraph API process
    API[Fastify /webhooks/github] -- 1. verify HMAC on raw bytes --> V{valid?}
    V -- 2. INSERT --> INBOX[(webhook_deliveries)]
    V -- 3. enqueue pointer --> Q[(Redis: pr_events)]
    DASHAPI[/api/* authenticated/] --> DB[(PostgreSQL)]
  end
  subgraph Worker process
    Q --> W[BullMQ worker] -- claim row --> INBOX
    D[dispatcher every 15 s] -- due / lost / crashed --> Q
    W --> AN[analyzePullRequest\nper-PR lease]
    AN -- installation token --> GHAPI[GitHub REST]
    AN --> SC[scoring v2] --> DB
    AN -- optional --> AI[OpenAI] --> DB
    AN -- optional --> CM[one PR comment] --> GHAPI
  end
  Browser -- same origin --> WEB[Next.js] -- /api proxy + SSR with session cookie --> DASHAPI
```

| Process | Entry point | Responsibility |
|---|---|---|
| API | `backend/src/server.ts` → `dist/server.js` | webhook intake (durable inbox), dashboard API, auth, health/readiness |
| Worker | `backend/src/worker.ts` → `dist/worker.js` | processes deliveries (GitHub fetch, scoring, AI, comments), runs the recovery dispatcher, prunes old sessions |
| Dashboard | `frontend/` (Next.js) | pages rendered per request; same-origin `/api` proxy to the API |

- The browser only talks to the dashboard origin. Next.js forwards `/api/*` to the API (`app/api/[...path]/route.ts`) and server components call the API with the user's session cookie and `cache: 'no-store'`.
- Every backend module except `server.ts` and `worker.ts` is side-effect free: importing it starts no listeners, connections or writes. Resources are built by factories that take the typed configuration.
- The queue payload is only `{ deliveryId }`; PostgreSQL is the source of truth for all work.

## 11. Webhook intake and the durable inbox

`POST /webhooks/github` (`routes/webhooks.ts`) runs these steps in order:

| Step | On failure |
|---|---|
| GitHub integration enabled | `503 GITHUB_DISABLED` |
| `fastify-raw-body` captured the exact request bytes (`global:false`, route `config.rawBody:true`, `encoding:false`) | `500` |
| `X-Hub-Signature-256` equals `sha256=` + HMAC-SHA256(secret, raw bytes), compared in constant time | `401` (missing / malformed / invalid) — nothing is stored |
| `X-GitHub-Event` and `X-GitHub-Delivery` well-formed; `Content-Type: application/json` | `400` / `415` |
| Body is valid JSON (parsed leniently so a bad signature always gets `401` first) | `400` |
| Event classified and payload validated with Zod (`webhooks/classify.ts`) | `400 INVALID_PAYLOAD` with field details |
| `ping` | `200`, not stored |
| Unsupported event/action, installation or repository outside the workspace, this App's own check suite | `202 {status:"ignored", reason}`, not stored, no job |
| `INSERT` into `webhook_deliveries` with a **minimal** payload (action, numbers, SHAs, repository identity — no bodies, titles, senders or diffs) | `503 STORAGE_UNAVAILABLE` (redeliver from GitHub later) |
| Enqueue `{deliveryId}` with job id `delivery__<id>__<attempt>` (bounded to 3 s) | still `202 {queued:false}`; the dispatcher enqueues it later |
| Same delivery id with the same payload hash | `200 {status:"duplicate"}`; if it had failed or died it is reset and re-queued (`202 {status:"requeued"}`) |
| Same delivery id with a different payload | `409 DELIVERY_ID_CONFLICT` |

Validated per event: positive PR number equal to `pull_request.number`, installation id, repository id and `owner/name`, a 40-hex head SHA, and an action within the handled set.

## 12. Delivery processing, retries and recovery

Delivery states: `received → queued → processing → succeeded | ignored | failed → … → dead`.

- **Claim** (`jobs/process-delivery.ts`): a conditional `UPDATE … SET status='processing', attempts=attempts+1 WHERE status IN (received, queued, failed) OR (processing AND stale)`. Two jobs for the same delivery can never run it concurrently.
- **Routing:**
  - `pull_request` → full analysis or metadata refresh (see the table in [§6](#6-github-app-setup));
  - `check_suite.completed` / `status` → full analysis of each open PR whose current head equals the SHA; otherwise `ignored` (obsolete or unknown revision);
  - `installation`: `deleted`/`suspend` → revoke access to that installation's repositories; `created`/`unsuspend`/`new_permissions_accepted` → restore;
  - `installation_repositories`: `removed` → revoke; `added` → restore.
- **Outcomes:** success → `succeeded` or `ignored`. `PermanentError` (403 permission, 404, other 4xx, GitHub disabled) → `dead`. `RetryableError` → `failed`, with `next_attempt_at` set to GitHub's rate-limit reset / `Retry-After`, or a backoff of 30 s · 2ⁿ⁻¹ (capped at 30 min). After `DELIVERY_MAX_ATTEMPTS` (default 6) → `dead`. Waiting for another job's PR lease (`pr_locked`) does not consume an attempt.
- **Dispatcher** (`jobs/dispatch.ts`, inside the worker, every `DISPATCHER_INTERVAL_MS`): enqueues deliveries that are `received`, `failed` and due, `queued` for more than 5 minutes (lost job, e.g. Redis flushed), or `processing` for more than 10 minutes (crashed worker). A finished BullMQ job with the same id is removed first so it can run again.
- **Retry layering:** GitHub calls retry in-process only for short waits (rate limit ≤ 10 s, at most 2 transient retries); longer waits become a durable reschedule. BullMQ is configured with `attempts: 1`. The AI client has its own bounded policy ([§16](#16-ai-review)). No layer multiplies another's retries.

## 13. Per-PR analysis: revisions, idempotency, concurrency

`analysis/analyze.ts → analyzePullRequest()`:

1. **Lease.** `INSERT … ON CONFLICT DO UPDATE … WHERE expired` on `processing_leases`, keyed `<repo_github_id>:<number>`, TTL 5 minutes. All work on one PR is serialised across every worker process.
2. **Snapshot** (`github/pr-snapshot.ts`). Read the PR, then all files (paginated), then CI for that head, then the PR again. If the head moved, rebuild (up to 3 times). Files, CI and metadata therefore always belong to one revision.
3. **Conditional metadata write.** Newer `github_updated_at` is never overwritten by an older snapshot. A successful installation-scoped fetch re-activates the repository.
4. **Run identity.** `input_fingerprint` = SHA-256 of the scoring version, head SHA, base ref, counts, sorted per-file (name, status, additions, deletions), file-list completeness and CI status. `analysis_runs (pull_request_id, input_fingerprint)` and `pr_scores (pull_request_id, input_fingerprint)` are unique:
   - replaying an event or retrying a job creates nothing new,
   - a CI change on the same SHA creates a new run (new history),
   - a new head creates a new run.
5. **Supersede.** Unfinished AI/comment work of runs for older heads is marked `superseded`.
6. **AI stage.** Runs only for the current head, at most 3 attempts per run. Identical AI inputs reuse a stored result without a paid call. Outcomes: `pending`, `disabled`, `succeeded`, `unavailable`, `failed`, `superseded`. A failure never discards the score and sets the comment status to `skipped` (an older analysis is never published instead).
7. **Comment stage.** Publishes only this run's own analysis, after re-checking the live head on GitHub (`superseded` if it moved).
8. **Release** the lease.

The API shows a score or AI analysis as **current** only when its `head_sha` equals the PR's head; others are labelled `previous_head`, or `legacy_unknown` for pre-migration rows.

## 14. GitHub integration

- **Authentication** (`github/client.ts`): `new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey, installationId }, baseUrl })`. One client is cached per installation. Every request uses an installation token scoped to that installation; `@octokit/auth-app` caches tokens for 59 minutes and requests a new one afterwards. PEMs with `\n` escapes and `GITHUB_PRIVATE_KEY_PATH` are both supported.
- **Changed files:** `octokit.paginate(pulls.listFiles, per_page 100)`. GitHub lists at most **3,000** files; if fewer files are listed than the PR's `changed_files`, coverage is stored as incomplete with a reason and shown as an uncertainty. Files without a patch (binary or very large) are counted. The same list feeds scoring and AI selection — nothing is fetched twice.
- **CI** (`github/ci-status.ts`): the Checks API (`filter=latest`, paginated, this App's own runs ignored) plus the combined commit status, both for the exact SHA, normalised to:

  | Status | When |
  |---|---|
  | `failure` | any check concluded `failure`, `timed_out`, `action_required` or `startup_failure`, or any status is `failure`/`error` |
  | `pending` | otherwise, any check not completed or any status `pending` |
  | `success` | otherwise, at least one success and everything else success/neutral/skipped, with both sources readable |
  | `unknown` | no CI, only neutral/skipped, only cancelled/stale, or a source unreadable (missing permission) — with a reason |

- **Errors and rate limits** (`github/retry.ts`):

  | Response | Classification |
  |---|---|
  | 403/429 with `x-ratelimit-remaining: 0` | primary rate limit, retry at `x-ratelimit-reset` |
  | 403/429 with `Retry-After` or a "rate limit" message | secondary rate limit, retry after the given time (default 60 s) |
  | other 403 | permission error — permanent |
  | 404 | not found — permanent |
  | other 4xx | client error — permanent |
  | 5xx, network errors | transient — 1 s, 2 s backoff, then a durable retry |

## 15. Scoring contract v2

Implemented in `backend/src/scoring/rules.ts` (`SCORING_VERSION = 'v2'`). Within one rule, the higher threshold replaces the lower one.

| Rule | Points |
|---|---|
| Files changed | > 20 → +20; > 50 → +40 |
| Lines changed (additions + deletions) | > 500 → +20; > 1000 → +40 |
| Critical areas touched | 1 category → +20; 2 or more → +40 |
| No test file changed (and at least one file changed) | +20 |
| CI | `failure` → +20; `success` → 0; `pending`/`unknown` → 0, listed as an **uncertainty** |

- **Score** = min(100, sum). The uncapped sum is kept in `features.raw_score` (maximum 160). Possible scores: 0, 20, 40, 60, 80, 100.
- **Levels:** **LOW ≤ 30, MED ≤ 70, HIGH > 70.** The same boundaries drive the API level, dashboard badges, folder statistics, seeds and documentation (the frontend's `lib/levels.ts` mirrors the backend and both are tested).
- **Reasons:** the top 3 contributions by points, then a fixed rule order (deterministic). Every contribution is stored in `pr_scores.contributions`.

**Critical-area and test-file conventions** (`scoring/paths.ts`, shared with AI file selection). Matching uses whole path segments and filename tokens (split on separators and camelCase), never substrings:

| Category | Matches |
|---|---|
| Authentication | tokens `auth`, `authentication`, `authn`, `authz`, `login`, `logout`, `session(s)`, `oauth`, `sso`, `jwt`, `passport` |
| Payments | `payment(s)`, `billing`, `invoice(s)` |
| Configuration | `config(s)`, `configuration`, `settings`; `.env*` files |
| Infrastructure | `infra`, `infrastructure`, `deploy`, `deployment(s)`, `terraform`, `helm`, `k8s`, `kubernetes`; `Dockerfile*`, `docker-compose*.yml`, `compose.yml` |
| Migrations | directories `migrations`, `migration`, `migrate`; `schema.prisma`, `schema.rb`, `structure.sql`, `schema.sql` |
| CI/CD workflows | `.github/workflows/`, `.github/actions/`, `.circleci/`, `.gitlab-ci.yml`, `.buildkite/` |

Test files: `*.test.*`, `*.spec.*`, `*_test.*`, `*_spec.*`, `test_*.py`, `*Test(s).java|kt|cs|swift`, or any file under a directory named `test`, `tests`, `__tests__`, `spec`, `specs`, `e2e` or `integration-tests`. Look-alikes such as `author.ts`, `latest.ts`, `inspector.ts`, `contest/` and `specification.md` match nothing. A file can belong to several categories (deduplicated across the PR); test files are never counted as critical.

**Worked examples**

| PR | Calculation | Score / level |
|---|---|---|
| 3 files, 70 lines, no tests, CI success | +20 (no tests) | 20 / LOW |
| 55 files, 300 lines, no tests, CI success | +40 (files) +20 (no tests) | 60 / MED |
| 25 files, 800 lines, auth + payments, no tests | +20 +20 +40 +20 | 100 / HIGH |
| 60 files, 1,700 lines, 3 categories, no tests, CI failed | 40+40+40+20+20 = 160 | 100 / HIGH (raw 160) |

**Intentional changes from the original (legacy) contract** — legacy scores keep `scoring_version='legacy'` and are never rewritten:
- CI is now fetched. The old code always sent "unknown", which added +20 to every PR; now only an actual failure is penalised.
- Substring matching is replaced by the conventions above. "GitHub Actions" is renamed "CI/CD workflows" and anchored to CI directories.
- All applicable categories per file are counted (the old code used the first match only); test files are excluded.
- The two original tests expecting > 70 for a lone size penalty were wrong: +40 (size) + 20 (no tests) = 60 (MED). The tests now assert that arithmetic; thresholds are unchanged.

## 16. AI review

Off unless `AI_ENABLED=true`. Pipeline: **select → redact → build prompt → call → validate → store.**

- **File selection** (`ai/file-selector.ts`): up to 3 files ranked by +200 for a critical-area file plus churn (additions + deletions); ties broken by filename.
- **Redaction** (`ai/redaction.ts`): 13 detectors — PEM private keys (including truncated blocks), credential URLs, GitHub / Stripe / AWS / Google / Slack / OpenAI-style keys, JWTs, `Authorization` headers, `*key/*secret/*token = value` and `*password = value` assignments (references such as `process.env.X` are left alone). Applied to diffs, file names, reasons and uncertainties; the number of redactions is recorded. Named capture groups guarantee the replacement never mistakes a match offset for a secret (the original bug). Output checking uses non-global regex copies, so repeated checks are stateless.
  **Limits:** pattern matching misses secrets with no recognisable shape, secrets split across lines or encoded, and unusual formats. It reduces accidental disclosure; it is not a guarantee.
- **Budgets** (`ai/prompt-builder.ts`): diffs ≤ **6,000** characters including truncation markers, allocated in ranking order (a file is *omitted* when fewer than 200 characters remain); file list ≤ 3,000 characters with an omitted count; reasons and uncertainties ≤ 10 × 300 characters; the whole user message ≤ **20,000** characters (worst case tested).
- **Limitations stored with each analysis:** selected, truncated, omitted and missing-patch files; number of file names left out; whether GitHub's file list was incomplete; number of redactions.
- **Prompt-injection hygiene:** PR content is placed inside `<untrusted_pr_data>` in the user message. The separate system message says that content is data, never instructions, and that output is advisory text for humans (no commands). Fence-closing text and control characters in PR content are neutralised. Model output is never executed and is rendered as plain text.
- **Client** (`ai/client.ts`): SDK retries disabled; each attempt has a real `AbortController` deadline (`AI_TIMEOUT_MS`) whose timer is always cleared; at most 2 attempts, retrying only 429, 5xx, connection errors and timeouts (honouring `Retry-After` up to 5 s, otherwise 1 s); no retry for other 4xx, empty, non-JSON or invalid output. Failure kinds: `config`, `unavailable`, `invalid_output`.
- **Output schema** (`ai/validator.ts`):

  | Field | Rule |
  |---|---|
  | `summary` | 10–500 characters |
  | `review_focus` | 3–5 items of 5–200 characters |
  | `test_suggestions` | 3–6 items of 5–200 characters |
  | `rollback_risk` | `LOW`, `MED` or `HIGH` |
  | `confidence` | finite number 0–1 — **reported by the model, not calibrated** |
  | `warnings` | optional, ≤ 5 items of ≤ 300 characters |

  After schema validation the whole output is scanned for secrets; any hit rejects it. A schema-valid answer can still be wrong.
- **Storage:** `pr_ai_analyses` (run, head SHA, model, prompt version `v2`, input fingerprint, limitations). Failures are recorded on the run (`ai_status`, sanitised `ai_error`).

## 17. PR comments

Off unless `GITHUB_POST_COMMENTS=true` (requires live GitHub and AI).

- **One comment per PR.** It is identified by the hidden marker `<!-- pr-risk-scorer:analysis -->` **and** `performed_via_github_app.id == GITHUB_APP_ID`, so a user comment containing the marker is never edited.
- **Lookup:** the stored comment id, verified; otherwise all comments are paginated and ours is picked. The comment is updated in place; one is created only if none exists.
- **Crash safety:** creation is not retried in-process (it is not idempotent). If GitHub created the comment but the response was lost, the next attempt finds it by marker instead of creating a duplicate. A deleted comment is recreated once.
- **Content:** the analyzed commit, score and level, CI status, uncertainties, AI summary, review focus, suggested tests, rollback risk, model-reported confidence, limitations and model warnings. `@mentions` and HTML comments in model text are neutralised.
- **Freshness:** published only for the current head and only from the current run's analysis; never an older analysis after a failed current run.

## 18. Data model and migrations

### Tables

**`repos`** — one row per repository.

| Column | Type | Meaning |
|---|---|---|
| `id` | text (UUID) | primary key |
| `github_repo_id` | bigint, unique | GitHub repository id (demo rows use reserved negative ids) |
| `full_name`, `owner`, `name` | text | `owner/name` |
| `installation_id` | bigint | GitHub App installation (demo rows: 0) |
| `private` | boolean | GitHub's private flag (trustworthy only when `visibility` is set) |
| `visibility` | text, nullable | `public`/`private`/`internal`; NULL = unknown (legacy) |
| `access_status` | text | `active` or `revoked` (revoked repos are neither processed nor served) |
| `access_revoked_at` | timestamp | when access was revoked |
| `is_demo` | boolean | demo data |
| `created_at`, `updated_at` | timestamp | local times |

**`pull_requests`** — one row per PR (repository + number).

| Column | Type | Meaning |
|---|---|---|
| `id` | text (UUID) | primary key (preserved across the migration) |
| `repo_id` | text → `repos.id` | owning repository |
| `number` | int, nullable | repository-local PR number; unique with `repo_id` (NULL only for invalid legacy values) |
| `github_id` | bigint, unique, nullable | GitHub's global PR id, only from GitHub data |
| `github_pr_id` | bigint, nullable | **legacy**: held the PR number in the old schema; no longer unique |
| `identity_status` | text | `verified`, `legacy_unverified`, `legacy_invalid_number` |
| `title`, `author` | text | from GitHub |
| `state` | text | `open` or `closed` (merged PRs are closed with `merged_at` set) |
| `draft` | boolean | draft PR |
| `head_sha`, `base_ref`, `head_ref` | text | current revision and branches |
| `additions`, `deletions`, `changed_files` | int | totals reported by GitHub |
| `changed_files_list` | jsonb | listed filenames (string array) |
| `github_created_at`, `github_updated_at`, `closed_at`, `merged_at` | timestamp | GitHub lifecycle times |
| `created_at` | timestamp | first ingestion into this system |
| `updated_at` | timestamp | last local write |
| `bot_comment_id`, `bot_comment_sha` | bigint / text | this App's comment and the revision it reflects |

**`pr_scores`** — append-only score history.

| Column | Meaning |
|---|---|
| `id`, `pull_request_id` | keys |
| `score` (float), `level` (text) | score and stored level (`low`/`medium`/`high`); the API derives the level from the score |
| `reasons` (jsonb) | top reasons (legacy seed rows may hold `{message}` objects; the API normalises them) |
| `features` (jsonb) | files/lines changed, files analysed, categories, test changes, CI status, raw score |
| `contributions` (jsonb) | every rule contribution |
| `coverage` (jsonb) | file-list completeness, files without patch, uncertainties, CI details |
| `head_sha` | revision scored (NULL = unknown, legacy) |
| `scoring_version` | `v2`, or `legacy` for pre-migration rows |
| `ci_status` | CI status used |
| `input_fingerprint`, `run_id` | idempotency key and owning run (unique) |
| `created_at`, `updated_at` | timestamps |

**`pr_ai_analyses`** — AI results: `analysis_json` (the validated output), `model`, `prompt_version`, `head_sha`, `input_fingerprint`, `limitations`, `run_id` (unique), timestamps.

**`analysis_runs`** — one deterministic analysis of one revision with one set of inputs: `pull_request_id`, `head_sha`, `input_fingerprint` (unique with the PR), `scoring_version`, `ci_status`, `trigger_delivery_id`, `ai_status` (`pending|disabled|succeeded|unavailable|failed|superseded`), `ai_error`, `ai_attempts`, `comment_status` (`disabled|pending|succeeded|failed|superseded|skipped`), `comment_error`, `created_at`, `updated_at`, `completed_at`.

**`webhook_deliveries`** — the durable inbox: `id` (GitHub delivery GUID), `event`, `action`, `payload_sha256`, `status` (`received|queued|processing|succeeded|ignored|failed|dead`), `installation_id`, `repo_github_id`, `repo_full_name`, `pr_number`, `head_sha`, `payload` (minimal fields only), `attempts`, `last_error` (sanitised), `ignored_reason`, `next_attempt_at`, `enqueued_at`, `received_at`, `updated_at`, `processed_at`.

**`processing_leases`** — `key` (`<repo_github_id>:<number>`), `owner`, `expires_at`.

**`admin_sessions`** — `id` (SHA-256 of the session token), `username`, `created_at`, `expires_at`, `last_seen_at`, `revoked_at`.

All child relations cascade on delete; `pr_scores.run_id` and `pr_ai_analyses.run_id` are set to NULL if a run is deleted.

### Indexes

`repos(installation_id)`; `pull_requests(repo_id, number)` unique, `(github_id)` unique, `(repo_id, head_sha)`, `(updated_at, id)`; `pr_scores(pull_request_id, input_fingerprint)` unique, `(run_id)` unique, `(pull_request_id, created_at, id)`; `pr_ai_analyses(run_id)` unique, `(pull_request_id, created_at, id)`; `analysis_runs(pull_request_id, input_fingerprint)` unique, `(pull_request_id, created_at, id)`; `webhook_deliveries(status, next_attempt_at)`, `(received_at)`; `admin_sessions(expires_at)`. Lists order by `(updated_at DESC, id DESC)` for stable pagination.

### Migrations

| Migration | Change |
|---|---|
| `20240101000000_init` | original: `repos`, `pull_requests`, `pr_scores` |
| `20240102000000_add_pr_fields` | original: additions, deletions, changed_files, changed_files_list |
| `20240103000000_add_ai_analysis` | original: `pr_ai_analyses` |
| `20260929000000_pr_identity_revisions_inbox` | repair (additive — see below) |

The repair migration:
- backfills `number = github_pr_id` where it is a valid PR number (1 … 2³¹−1); otherwise `number` stays NULL and `identity_status = 'legacy_invalid_number'` (the original value is preserved in `github_pr_id`);
- marks every pre-existing PR `legacy_unverified`, drops the incorrect global unique index on `github_pr_id`, and adds the `(repo_id, number)` unique index;
- marks existing scores `scoring_version='legacy'` with `head_sha` NULL, and existing AI analyses with `head_sha`/`run_id` NULL;
- adds the new columns, tables and indexes;
- deletes or rewrites **nothing**: every row, UUID and foreign key is kept.

**Legacy corruption that cannot be repaired.** Under the original schema, when two repositories had the same PR number, the second one overwrote the first row's metadata and appended its scores and AI analyses to it. Nothing recorded which repository each value came from, so the migration does not guess. `report:legacy-identity` lists every PR with legacy identity or legacy history and flags *potential* collisions whenever more than one repository exists. When GitHub next reports such a PR, its current metadata is refreshed from GitHub (same UUID, `identity_status='verified'`) while its legacy history stays labelled `legacy_unknown`; the same-numbered PR of the other repository gets its own new row.

## 19. HTTP API reference

Base URL: `http://127.0.0.1:4000` (the browser reaches it through the dashboard's `/api` proxy). Every response carries an `X-Request-ID` header (a valid incoming `X-Request-ID` is reused, otherwise a UUID is generated).

**Error envelope** (all errors):

```json
{ "error": { "message": "Authentication required", "code": "UNAUTHORIZED", "requestId": "3f1c…", "details": [] } }
```

Codes: `VALIDATION_ERROR`, `BAD_REQUEST`, `INVALID_PAYLOAD`, `UNAUTHORIZED`, `INVALID_CREDENTIALS`, `FORBIDDEN`, `NOT_FOUND`, `DELIVERY_ID_CONFLICT`, `UNSUPPORTED_MEDIA_TYPE`, `PAYLOAD_TOO_LARGE`, `TOO_MANY_ATTEMPTS`, `GITHUB_DISABLED`, `STORAGE_UNAVAILABLE`, `THROTTLE_UNAVAILABLE`, `INTERNAL_ERROR`. 5xx errors never include messages or stack traces.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | public | liveness `{ "ok": true }` |
| GET | `/ready` | public | `{ "ok": true, "checks": { "database": "up", "redis": "up" } }`; 503 when a dependency is down |
| GET | `/api/version` | public | `{ "version": "1.1.0" }` |
| POST | `/webhooks/github` | HMAC signature | GitHub webhooks ([§11](#11-webhook-intake-and-the-durable-inbox)) |
| POST | `/api/auth/login` | Origin check | `{ "username", "password" }` → session cookie |
| POST | `/api/auth/logout` | Origin check | revokes the session, clears the cookie |
| GET | `/api/auth/session` | optional cookie | `{ "authenticated": true, "username": "admin", "expires_at": "…" }` |
| GET | `/api/prs?limit=1..100&offset=` | session | PR list (default limit 50) |
| GET | `/api/prs/:id` | session | PR detail (`id` = UUID) |
| GET | `/api/stats` | session | workspace statistics |
| GET | `/api/admin/deliveries?status=&limit=1..200` | session | webhook inbox, newest first, sanitised |
| POST | `/api/admin/deliveries/recover` | session + Origin | `{ "ids"?: string[], "include_dead"?: boolean }` → `{ "reset", "due", "enqueued" }` |
| POST | `/api/demo/seed` | session + Origin + `DEMO_ENABLED` | deterministic demo data |
| GET | `/api/demo/status` | session | `{ "enabled": boolean }` |

Mutations (`POST` except the webhook) require `Origin` equal to `FRONTEND_URL` and a JSON body; otherwise `403` or `415`.

**`GET /api/prs`** (abridged):

```json
{
  "data": [{
    "id": "8a5c…", "number": 5, "github_pr_id": 5, "github_id": "700005",
    "identity_status": "verified", "title": "Refactor auth", "author": "dev",
    "state": "open", "draft": false, "merged": false,
    "repository": "acme/app", "repository_private": true, "repository_visibility": "private", "is_demo": false,
    "head_sha": "4f2a…", "additions": 43, "deletions": 6, "changed_files": 2,
    "created_at": "…", "updated_at": "…", "github_created_at": "…", "github_updated_at": "…",
    "merged_at": null, "closed_at": null,
    "latest_score": {
      "score": 40, "level": "medium", "reasons": ["Touches critical area: Authentication", "No test files changed"],
      "contributions": [{ "rule": "critical_paths", "points": 20, "severity": "MED", "reason": "…" }],
      "uncertainties": ["CI status is pending (checks still running); not scored"],
      "coverage": { "complete": true, "expected_files": 2, "listed_files": 2, "files_without_patch": 0, "reason": null },
      "ci_status": "pending", "head_sha": "4f2a…", "scoring_version": "v2", "revision_status": "current", "created_at": "…"
    },
    "ai_status": "succeeded",
    "processing": false
  }],
  "pagination": { "limit": 50, "offset": 0, "total": 1, "has_more": false }
}
```

`github_pr_id` is a **deprecated alias of `number`** (the field always held the PR number); the real GitHub pull request id is `github_id`.

**`GET /api/prs/:id`** adds `changed_files_list`, `base_ref`, `head_ref`, `score_history[]` (`score`, `level`, `head_sha`, `ci_status`, `scoring_version`, `revision_status`, `created_at`, newest first) and:

```json
"ai": {
  "enabled": true, "status": "succeeded", "error": null, "comment_status": "succeeded",
  "analyzed_sha": "4f2a…", "run_created_at": "…",
  "current": { "analysis": { "summary": "…", "review_focus": ["…"], "test_suggestions": ["…"], "rollback_risk": "MED", "confidence": 0.65, "warnings": [] },
               "model": "gpt-4o-mini", "prompt_version": "v2", "head_sha": "4f2a…", "revision_status": "current", "limitations": { … }, "created_at": "…" },
  "previous": null
}
```

`ai.status` is the status of the run for the current head, or `stale` (only an older revision was analysed — shown in `previous`), `missing` (not analysed yet) or `disabled`.

**`GET /api/stats`**:

```json
{ "total_prs": 11, "scored_prs": 11, "unscored_prs": 0, "average_score": 41.82,
  "counts_by_level": { "low": 5, "medium": 4, "high": 2 },
  "top_risky_folders": [{ "folder": "src/auth", "pr_count": 1, "average_score": 100, "level": "high" }] }
```

Statistics are computed in PostgreSQL over visible repositories. Each PR contributes its latest score, preferring the current head. `average_score` covers scored PRs only (`null` when none). Folders are the first two **directory** components of each changed path (root files have none; a filename is never a folder); each PR counts once per folder; top 10 by average, then PR count, then name.

**Visibility policy:** every data endpoint only returns repositories that are `active` and either demo data or part of `WORKSPACE_INSTALLATION_IDS` (and `WORKSPACE_REPOSITORIES`, if set). Other PRs answer `404`.

## 20. Dashboard (frontend)

| Route | File | Content |
|---|---|---|
| `/` | `app/page.tsx` | landing with links |
| `/login` | `app/login/page.tsx` + `components/LoginForm.tsx` | sign-in; returns to `?next=` (only same-site relative paths) |
| `/prs` | `app/prs/page.tsx` | table: title, number, state/draft/merged, author, repository (demo pill), risk badge with legacy/older-revision label, CI pill, AI/processing pill, GitHub update time; previous/next pagination with "Showing X–Y of Z"; empty state with "Load demo data" when demo is enabled |
| `/prs/[id]` | `app/prs/[id]/page.tsx` | header (repository, number, author, state, visibility, head SHA, legacy-identity warning); risk score with revision and CI pills, top reasons, all contributions, uncertainty box and a note that the score is not proof; AI review panel; details (lines, files, branches, GitHub and local timestamps); score history; changed files (with "of N" when incomplete) |
| `/prs/[id]` not found | `app/prs/[id]/not-found.tsx` | not found or outside the workspace |
| `/stats` | `app/stats/page.tsx` | cards (PRs, unscored, average, low/medium/high counts) and the riskiest-folders table |
| `/api/*` | `app/api/[...path]/route.ts` + `lib/proxy.ts` | same-origin proxy to the API (forwards only cookie, origin, content-type, request id, user agent; returns set-cookie, request id, retry-after; `no-store`; 502 if the API is unreachable) |

**Components:** `Nav` (links, user, sign-out; mobile menu via `<details>`, works without JavaScript), `LogoutButton`, `LoginForm`, `ScoreBadge` (level derived from the score), `StatusPill`, `Pagination`, `AiAnalysisPanel` (summary, review focus, suggested tests, rollback risk, model-reported confidence, analyzed revision, time, model warnings, limitations; explanations for pending, disabled, unavailable, failed, superseded, missing and stale; a previous-revision analysis is shown only in a clearly labelled box), `ErrorState` (status and request id, no server details), `EmptyState`, `DemoSeedButton`.

**Data fetching:** `lib/server-api.ts` reads the session cookie with `cookies()` and calls the API with `cache: 'no-store'`. Every page exports `dynamic = 'force-dynamic'`, so nothing is prerendered or shared between users and the production build does not need a running backend. `settle()` + `navigateForApiError()` map 401 → `/login?next=…` and 404 → not found, outside any `try/catch` (Next.js navigation works by throwing); other errors render `ErrorState`. `lib/api-error.ts` keeps the HTTP status, code and request id. Dates are shown in UTC.

## 21. Security model

| Area | Control |
|---|---|
| Webhook authenticity | HMAC-SHA256 over the exact raw bytes, full `sha256=` value, constant-time comparison; rejected before anything is stored |
| Dashboard authentication | one admin; scrypt password hash (N=2¹⁷, r=8, p=1) from `auth:hash-password`; the published example hash is rejected in production |
| Sessions | random 256-bit token; only its SHA-256 is stored; `HttpOnly`, `SameSite=Lax`, `Secure` in production; fixed expiry; rotation on login; revocation on logout; old sessions pruned by the worker |
| Brute force | Redis throttle: 5 failures per IP and 20 per username per 15 minutes (`429` + `Retry-After`); refuses logins (`503`) if Redis is unavailable |
| CSRF | login and authenticated mutations require `Origin == FRONTEND_URL` and a JSON body; SameSite cookies; the API grants no CORS |
| Data scope | only configured installations/repositories (plus demo data) are processed or served; revoked repositories are hidden and not processed |
| Browser secrets | none; the old `NEXT_PUBLIC_DEMO_SECRET` was removed; demo seeding needs an admin session, `DEMO_ENABLED` and a non-production environment |
| Logs | request logs contain method, path without query string, request id and an allowlist of headers; redaction paths cover authorization, cookies, signatures, passwords, keys, tokens, patches and payloads; stored error messages are redacted and truncated to 500 characters |
| Errors | 5xx responses never contain internal messages or stacks |
| AI data egress | at most three diffs within the budget, redacted; PR content fenced as untrusted |
| Infrastructure | development and test services bound to `127.0.0.1`; production requires HTTPS for the dashboard origin |
| Supply chain | frozen lockfile; only allow-listed dependency build scripts run; pnpm's minimum release age respected; `pnpm audit` clean |

---

# Part III — Quality and history

## 22. Verification results

Fresh clone of the repaired code (now on `main` at `f9eec49`), Node 24.21.0, pnpm 12.3.4, September 2026:

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | exit 0 |
| `pnpm --filter backend db:generate` | exit 0 |
| `pnpm lint` | exit 0, 0 warnings |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | backend **224/224** (15 files), frontend **31/31** (4 files) |
| `pnpm --filter backend db:check` | "No difference detected." — exit 0 |
| `pnpm test:integration` | **74/74** (5 files), ~64 s |
| `pnpm test:e2e` | **8/8** |
| `pnpm build` | exit 0; every frontend route dynamic (ƒ), built with the backend offline |
| `pnpm audit` | No known vulnerabilities found |
| `pnpm start` with the `.env.example` files | `/ready` 200 (database up, redis up); `/login` 200; unauthenticated `/prs` → 307 to `/login`; `SIGTERM` → "Worker stopped", exit 0 |

**Coverage (backend):** during the integration run — statements **79.72 %**, branches 71.70 %, functions 84.28 %, lines 81.99 %. Unit tests alone cover 36.6 % of statements, because HTTP and database code is exercised by the integration tier.

**Baseline before the repair (same machine):** `pnpm install --frozen-lockfile` failed (no lockfile); `pnpm install` failed with `ERR_PNPM_FETCH_404 @fastify/raw-body`. With that package swapped in a scratch copy: backend typecheck failed with TS6059 (rootDir), hiding 20 more type errors; `eslint: not found`; `next lint` stopped at an interactive prompt; backend tests **49/54**; the frontend build prerendered `/stats` statically.

## 23. Testing: strategy and full inventory

**Isolation.** Integration and e2e tests use `docker-compose.test.yml` (PostgreSQL on tmpfs at `127.0.0.1:55432`, Redis at `127.0.0.1:56379`) or the CI service containers. The global setup refuses any database whose name does not end in `_test` and any non-loopback host outside CI, then recreates the test database and applies all migrations. A network guard (`test/setup/network-guard.mjs`) makes every non-loopback TCP connection fail — in the test process and in every process the e2e test starts — so real GitHub or OpenAI can never be reached. Next.js telemetry is disabled. No paid AI calls, no GitHub writes.

**Mocks.** `test/helpers/mock-github.ts` is an HTTP server that verifies the App JWT (RS256, issuer = App id) before issuing installation tokens, scopes each token to one installation (other repositories answer 404), paginates with `Link` headers, supports injected failures, token expiry and "created but response lost" comments. `test/helpers/mock-openai.ts` serves `/v1/chat/completions` with configurable responses. `test/helpers/tcp-proxy.ts` simulates a Redis outage for the e2e test.

### Inventory (337 tests)

| File | Tests | Covers |
|---|---|---|
| `backend/src/scoring/rules.test.ts` | 37 | all 13 original cases (corrected), boundaries 20/21/50/51 files and 500/501/1000/1001 lines, level boundaries, CI states, category dedupe, look-alike names, incomplete coverage, cap, determinism |
| `backend/src/scoring/paths.test.ts` | 51 | test-file and critical-area conventions, look-alikes, tokenizer, stats folder extraction |
| `backend/src/ai/redaction.test.ts` | 35 | original cases, start/middle/end, repeats, PEM in diffs, unterminated keys, vendor keys, headers, JSON, URLs, preservation of ordinary code, stateless detection |
| `backend/src/ai/prompt-builder.test.ts` | 13 | budget with markers, ranking order, omitted/missing files, fencing, redaction of all fields, worst-case bound |
| `backend/src/ai/validator.test.ts` | 13 | schema bounds, secrets rejected consistently, non-object input |
| `backend/src/ai/client.test.ts` | 10 | success, missing key, malformed JSON, schema, secrets, empty, 429 + Retry-After, 5xx, 401, real timeout abort |
| `backend/src/ai/file-selector.test.ts` | 9 | +200 bonus, churn, top 3, ties, look-alikes |
| `backend/src/github/ci-status.test.ts` | 15 | every CI normalisation state incl. permissions and own-app runs |
| `backend/src/github/retry.test.ts` | 8 | permission vs rate limit, reset and Retry-After, transient retries |
| `backend/src/github/comments.test.ts` | 2 | marker, revision, confidence, mention/HTML neutralisation |
| `backend/src/webhooks/signature.test.ts` | 11 | valid, missing, malformed, wrong secret, tampered, raw bytes vs re-serialised JSON, non-UTF-8 |
| `backend/src/config/env.test.ts` | 11 | modes, missing settings, PEM unescaping, production rules, blank values, the shipped `.env.example` |
| `backend/src/auth/password.test.ts` | 4 | verify, unique salts, short/malformed input, example hash |
| `backend/src/analysis/fingerprint.test.ts` | 3 | order independence, CI change, head/files/version change |
| `backend/src/lib/network-guard.test.ts` | 2 | external blocked, loopback allowed |
| `frontend/src/__tests__/components.test.tsx` | 15 | badge, pagination, AI panel states, stale labelling, inert model text, error states |
| `frontend/src/__tests__/levels.test.ts` | 7 | shared level boundaries |
| `frontend/src/__tests__/login.test.tsx` | 5 | login request, navigation, 401/429/503 messages, open-redirect guard |
| `frontend/src/__tests__/api.test.ts` | 4 | status-preserving errors, proxy headers/cookies, 502 |
| `backend/test/integration/api.test.ts` | 35 | health/readiness (incl. dependencies down), request ids, error envelope, auth, throttling, rotation, expiry, CSRF, workspace policy, every webhook intake path, Redis down, database down, GitHub disabled |
| `backend/test/integration/pipeline.test.ts` | 16 | files beyond page 1, 3,000-file cap, same PR number in two repos, replays, CI change on same SHA, new and out-of-order heads, moving head, AI failure with preserved score, close/merge, full comment lifecycle, stale-head comment, missing Checks permission, rate-limit scheduling, installation isolation, token reuse/refresh, access removal, cross-process lease |
| `backend/test/integration/recovery.test.ts` | 7 | crash boundaries (stored-not-queued, lost job, crashed worker, crash after write), retry budget, dead recovery, worker restart |
| `backend/test/integration/migration.test.ts` | 9 | upgrade from the original schema with legacy data (collision, object reasons, invalid number, AI rows), no drift, preserved UUIDs/relations, new identity rules, legacy API labels, legacy report, clean install |
| `backend/test/integration/stats-demo.test.ts` | 7 | empty stats, folder counting, current-head preference, idempotent demo, documented demo metrics, demo endpoint, pagination stability, alias field |
| `backend/test/e2e/smoke.test.ts` | 8 | compiled API + worker + `next start`: invalid signature, unauthenticated reads, signed webhook through queue and DB, AI + one comment, replay, CI change, second repo with AI failure, Redis outage and recovery, worker restart, authenticated dashboard pages showing score/history/stats/AI, logout, graceful shutdown, no secrets in logs |

## 24. Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`. Global environment: `AI_ENABLED=false`, `GITHUB_POST_COMMENTS=false`, `NEXT_TELEMETRY_DISABLED=1`, test database/Redis URLs.

| Job | Steps |
|---|---|
| **static** — Lint, typecheck, unit tests, builds | checkout → `pnpm/action-setup@v4` (version from `packageManager`) **before** `actions/setup-node@v4` (Node from `.nvmrc`, pnpm cache) → `pnpm install --frozen-lockfile` → `db:generate` → `pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm build` → `pnpm audit --audit-level=moderate` → upload `backend/coverage/` (7 days) |
| **integration** — Integration, migrations and end-to-end | services `postgres:16-alpine` (55432) and `redis:7-alpine` (56379) with health checks → same setup → `db:generate` → create a shadow database and run `db:check` → `pnpm test:integration` → `pnpm test:e2e` |

## 25. Demo data

Created by `pnpm --filter backend db:seed` or `POST /api/demo/seed` (admin session, `DEMO_ENABLED`, never in production). Repositories `demo-acme/webapp`, `demo-acme/api`, `demo-acme/infrastructure` use reserved negative GitHub ids and `is_demo=true`, so they can never collide with real repositories. The 11 PRs have fixed SHAs, timestamps and CI states. Their scores come from the real scoring engine and are keyed by the same run fingerprint the worker uses, so running the seed again adds nothing. Two AI analyses are labelled fixtures (`model = "demo-fixture"`), not model output.

| PR | CI | Score | Level |
|---|---|---|---|
| Add unit tests for user service | success | 0 | low |
| Fix typo in README | success | 20 | low |
| Update dependencies | pending | 20 | low |
| Add loading spinner component | success | 0 | low |
| Refactor authentication middleware | success | 40 | medium |
| Add payment processing endpoint | failure | 40 | medium |
| Update CI/CD configuration | success | 60 | medium |
| Migrate database schema | unknown | 60 | medium |
| Add feature flags system | success | 20 | low |
| Major refactor: Rewrite authentication system | success | 100 | high |
| Implement payment gateway integration | pending | 100 | high |

Statistics: 11 PRs, average **41.82**, low 5 / medium 4 / high 2. Riskiest folders: `src/auth` 100 (1 PR), `src/payments` 100 (1), `src/config` 65 (4), `.github/workflows` 60 (1), `prisma` 60 (1), `prisma/migrations` 60 (1), `src/lib` 60 (1), `src/models` 60 (1), `src/services` 52 (5), `src/types` 40 (2). All values are asserted in `stats-demo.test.ts`.

## 26. Tunables

| Setting | Value | Where |
|---|---|---|
| Size thresholds / penalties / levels | §15 | `scoring/rules.ts` |
| AI files / critical bonus | 3 / +200 | `ai/file-selector.ts` |
| Diff / file-list / prompt budget | 6,000 / 3,000 / 20,000 characters | `ai/prompt-builder.ts` |
| AI timeout / attempts | 20 s (`AI_TIMEOUT_MS`) / 2 per call, 3 per run | `ai/client.ts`, `analysis/analyze.ts` |
| AI temperature / max output tokens | 0.2 / 1,000 | `ai/client.ts` |
| GitHub inline wait / attempts | ≤ 10 s / 3 | `github/retry.ts` |
| Head revalidations per snapshot | 3 | `github/pr-snapshot.ts` |
| Delivery attempts / backoff | 6 (`DELIVERY_MAX_ATTEMPTS`) / 30 s · 2ⁿ⁻¹, ≤ 30 min | `jobs/process-delivery.ts` |
| Dispatcher interval / stale queued / stale processing | 15 s / 5 min / 10 min | `jobs/dispatch.ts` |
| Enqueue timeout | 3 s | `jobs/dispatch.ts` |
| Completed / failed job retention in Redis | 1 h or 1,000 jobs / 24 h | `lib/queue.ts` |
| Worker concurrency | 5 (`WORKER_CONCURRENCY`) | `worker.ts` |
| PR lease TTL | 5 min | `analysis/analyze.ts` |
| Session TTL / throttle | 12 h / 5 per IP, 20 per username per 15 min | `config/env.ts`, `auth/throttle.ts` |
| Readiness check timeout | 2 s | `routes/health.ts` |
| Webhook body limit / other bodies | 25 MB / 1 MB | `routes/webhooks.ts`, `app.ts` |
| Page size | API default 50, dashboard 25, max 100 | `routes/prs.ts`, `app/prs/page.tsx` |
| Stored error length | 500 characters | `lib/sanitize.ts` |

## 27. File-by-file index

### Repository root

| File | Purpose |
|---|---|
| `package.json` | workspace scripts, pinned pnpm, Node engines |
| `pnpm-workspace.yaml` | packages, allow-listed build scripts, `postcss` override |
| `pnpm-lock.yaml` | exact dependency versions (installs use `--frozen-lockfile`) |
| `.nvmrc` | Node 24 |
| `.gitignore` | ignores env files, builds, coverage, keys, other package managers' lockfiles |
| `docker-compose.yml` | development PostgreSQL 16 + Redis 7 (loopback only) |
| `docker-compose.test.yml` | disposable test services (tmpfs) |
| `.github/workflows/ci.yml` | CI ([§24](#24-continuous-integration)) |
| `README.md` | setup and operations summary |
| `project.md` | this document |

### Backend (`backend/`)

| File | Purpose |
|---|---|
| `package.json`, `tsconfig.json`, `tsconfig.build.json`, `eslint.config.js`, `vitest.config.ts` | scripts; type-check everything / emit `src` → `dist`; lint; unit/integration/e2e test projects |
| `.env.example` | documented configuration for local demo mode |
| `prisma/schema.prisma`, `prisma/migrations/*` | data model and append-only migrations |
| `src/server.ts` | API entry point: config, connections, `listen`, graceful shutdown |
| `src/worker.ts` | worker entry point: BullMQ worker, dispatcher, graceful shutdown |
| `src/app.ts` | Fastify app factory: plugins and routes, no side effects |
| `src/config/env.ts` | typed configuration, mode validation, workspace membership |
| `src/config/constants.ts` | version (read from `package.json`), scoring/prompt versions, comment marker, cookie and queue names |
| `src/http/errors.ts` | error envelope and 404 handler |
| `src/http/request-id.ts` | request-id generation and `X-Request-ID` header |
| `src/http/auth.ts` | session resolution, `requireAdmin`, `requireTrustedOrigin`, cookie options |
| `src/routes/health.ts` | `/health`, `/ready`, `/api/version` |
| `src/routes/webhooks.ts` | webhook endpoint |
| `src/routes/auth.ts` | login, logout, session |
| `src/routes/prs.ts` | PR list, PR detail, statistics |
| `src/routes/admin.ts` | delivery list and recovery |
| `src/routes/demo.ts` | demo seed and status |
| `src/webhooks/signature.ts` | HMAC verification and signing |
| `src/webhooks/classify.ts` | event classification and payload validation |
| `src/webhooks/inbox.ts` | durable acceptance, dedupe, conflict detection |
| `src/jobs/process-delivery.ts` | claims and processes one delivery, records outcomes |
| `src/jobs/dispatch.ts` | enqueue, due-delivery dispatcher, manual recovery |
| `src/jobs/runtime.ts` | wires real dependencies for the worker; dispatcher timer |
| `src/analysis/analyze.ts` | per-PR orchestration: lease, snapshot, run, AI, comment |
| `src/analysis/lease.ts` | cross-process leases |
| `src/analysis/fingerprint.ts` | stable JSON, SHA-256, run fingerprint |
| `src/github/client.ts` | per-installation Octokit factory |
| `src/github/retry.ts` | GitHub error classification and retry policy |
| `src/github/pr-snapshot.ts` | PR metadata, paginated files, coverage, head revalidation |
| `src/github/ci-status.ts` | CI fetch and normalisation |
| `src/github/comments.ts` | comment formatting, discovery, create/update |
| `src/scoring/rules.ts` | scoring contract v2 |
| `src/scoring/paths.ts` | critical-area, test-file and stats-folder conventions |
| `src/ai/types.ts` | AI input/output/limitations types |
| `src/ai/file-selector.ts` | risky-file ranking |
| `src/ai/redaction.ts` | secret detection and redaction |
| `src/ai/prompt-builder.ts` | system prompt, budgets, fencing, limitations |
| `src/ai/client.ts` | OpenAI call with deadline and retry policy |
| `src/ai/validator.ts` | output schema and secret check |
| `src/api/pr-views.ts` | API view models, list/detail queries, SQL statistics |
| `src/auth/password.ts` | scrypt hashing and verification |
| `src/auth/sessions.ts` | session create/find/revoke/prune |
| `src/auth/throttle.ts` | Redis login throttle |
| `src/lib/logger.ts` | Pino options, serializers, redaction paths |
| `src/lib/prisma.ts`, `src/lib/redis.ts`, `src/lib/queue.ts` | client factories, timeouts, queue options and job ids |
| `src/lib/visibility.ts` | workspace data policy (Prisma and SQL) |
| `src/lib/errors.ts`, `src/lib/sanitize.ts` | retryable/permanent errors; safe error strings |
| `src/demo/seed.ts` | deterministic demo data (single seed path) |
| `src/cli/hash-password.ts`, `recover-deliveries.ts`, `seed-demo.ts`, `report-legacy-identity.ts` | operational CLIs |
| `src/**/*.test.ts` | unit tests ([§23](#23-testing-strategy-and-full-inventory)) |
| `test/setup/integration-global.ts`, `test/setup/network-guard.mjs` | guarded test database/Redis setup; network guard |
| `test/helpers/*` | mock GitHub, mock OpenAI, app/config/db/env helpers, process management, TCP toggle proxy |
| `test/integration/*`, `test/e2e/smoke.test.ts` | integration and end-to-end suites |

### Frontend (`frontend/`)

| File | Purpose |
|---|---|
| `package.json`, `tsconfig.json`, `next.config.mjs`, `eslint.config.mjs`, `vitest.config.mts`, `tailwind.config.js`, `postcss.config.js`, `next-env.d.ts` | scripts and tooling |
| `.env.example` | `API_INTERNAL_URL` |
| `src/app/layout.tsx` | root layout, navigation, current user |
| `src/app/page.tsx`, `login/page.tsx`, `prs/page.tsx`, `prs/[id]/page.tsx`, `prs/[id]/not-found.tsx`, `stats/page.tsx` | pages ([§20](#20-dashboard-frontend)) |
| `src/app/api/[...path]/route.ts` | same-origin API proxy |
| `src/components/*` | UI components ([§20](#20-dashboard-frontend)) |
| `src/lib/types.ts` | API contract types |
| `src/lib/server-api.ts` | server-side API calls with session cookie; error-to-navigation mapping |
| `src/lib/proxy.ts`, `client-api.ts`, `api-error.ts` | proxy, browser JSON POST, status-preserving errors |
| `src/lib/levels.ts`, `format.ts`, `safe-next.ts` | level boundaries and styles; UTC dates and short SHAs; open-redirect guard |
| `src/__tests__/*` | frontend tests |

## 28. Repair log: issues → fixes → verification

The original code (commit `6a7680b`) could not be installed, had a webhook-signature bypass, lost deliveries, mixed up PRs across repositories and failed its own tests. Everything below is fixed and verified.

| # | Issue (source) | Fix | Verified by |
|---|---|---|---|
| 1 | `@fastify/raw-body` does not exist (audit) | `fastify-raw-body` 5 with Fastify 5 | frozen install, e2e |
| 2 | No lockfile; stray untracked npm `package-lock.json` (audit) | committed `pnpm-lock.yaml`; removed the npm lockfile; other lockfiles ignored | CI `--frozen-lockfile`, clean clone |
| 3 | Unpinned Node/pnpm; pnpm ≥ 10 blocks build scripts (found) | Node 24 LTS + pnpm 12.3.4 pinned everywhere; `allowBuilds` | clean clone |
| 4 | Vulnerable Fastify 4, Next 14, Vitest ≤ 3, postcss (found by audit) | Fastify 5.12, Next 15.5.26, Vitest 4.1.11, postcss override | `pnpm audit` clean |
| 5 | No ESLint dependency/config; `next lint` interactive (audit) | ESLint 9 flat configs, `--max-warnings 0` | `pnpm lint` |
| 6 | Backend `rootDir` conflicted with prisma/scripts; a route imported a script outside `src` (found) | `tsconfig.json` (check everything) + `tsconfig.build.json` (emit `src`); seed moved into `src/demo` | build, `dist/server.js`/`worker.js`, version lookup |
| 7 | 20 hidden type errors (request-context misuse, nullable patch, null destructuring, JSON types, validation typings) (found) | modules rewritten; request-context replaced by `request.id` | `pnpm typecheck` |
| 8 | Next route param types (audit) | Next 15 async `params`/`searchParams` | typecheck, e2e |
| 9 | Importing modules started connections/listeners (found) | factories + entry points only | unit tests import freely |
| 10 | Fastify encapsulation: error handler and request id did not reach sibling routes (found) | root plugins via `fastify-plugin` | API tests |
| 11 | No typed config; environment read at import (found) | `config/env.ts` modes with complete error lists; blank = unset | `env.test.ts`, dev run |
| 12 | `pnpm dev` omitted the worker (audit) | root `dev` runs API + worker + dashboard | dev run |
| 13 | No graceful shutdown or readiness (found) | `SIGTERM` handling; `/ready` | e2e |
| 14 | Webhook signature check never awaited → any signature accepted (audit) | constant-time HMAC over raw bytes with the full header | unit, API tests, e2e |
| 15 | Raw body would be undefined with `global:false` (audit) | route `config.rawBody:true` | API tests |
| 16 | Weak payload validation (found) | Zod per event; 400 with details | API tests |
| 17 | Deliveries lost when enqueueing failed; always 200 (audit) | durable inbox; 202 after commit; 503 if not stored; dispatcher | API and recovery tests, e2e Redis outage |
| 18 | No dedupe or conflict detection; failed work lost after queue cleanup (found) | payload hash; requeue of failed/dead replays; attempt-scoped job ids | API and recovery tests |
| 19 | Only opened/synchronize handled; merges/closes never recorded (audit) | all lifecycle actions; metadata-only for close/draft | pipeline tests |
| 20 | No handling of installation/access removal (found) | revoke/restore + visibility policy | pipeline and API tests |
| 21 | Incorrect Octokit App authentication (found) | `authStrategy: createAppAuth` + `auth` | mock verifies JWT; token tests |
| 22 | New auth flow for every call (audit) | per-installation client cache | token reuse test |
| 23 | Files not paginated (30 max) and fetched three times (audit) | paginate once and reuse; 3,000-file cap detected | page-2 and 3,000-file tests |
| 24 | CI hard-coded "unknown" (+20 for every PR) (audit) | Checks + statuses for the exact SHA, normalised | CI unit tests, pipeline, e2e |
| 25 | Every 403 treated as a rate limit (audit) | classifier; reset/Retry-After; bounded retries | retry tests, reset scheduling test |
| 26 | PR number stored as a globally unique id (audit) | `(repo_id, number)`, `github_id`, additive migration | migration and two-repo tests |
| 27 | `private` always false (audit) | real visibility from GitHub | pipeline test |
| 28 | Scores/AI not tied to a revision; duplicates on every event (found) | runs, fingerprints, head SHA; legacy rows labelled | replay, CI-change, new-head tests |
| 29 | Concurrent or out-of-order jobs could overwrite newer state (found) | DB lease, conditional writes, head revalidation, supersede | concurrency, moving-head, out-of-order tests |
| 30 | New comment on every push; could post stale or historical analysis (audit) | one comment, marker + authorship, current run only, head recheck, crash reconciliation | comment tests |
| 31 | 5 failing tests (audit): 2 wrong huge-PR expectations, redaction offset bug (2), unrealistic secret fixture | tests corrected to the arithmetic; redaction fixed; realistic fixtures built at runtime | unit tests |
| 32 | Stateful `/g` regex `.test()` in the validator (audit) | non-global copies | repeated-call tests |
| 33 | Substring path/test matching (audit) | segment/token conventions | `paths.test.ts` |
| 34 | Uncancelled `Promise.race` timeout; stacked retries (found) | `AbortController` deadline; SDK retries off; one policy | client timeout test |
| 35 | Diff budget ignored markers; no overall prompt bound; PR text not fenced (found) | enforced budgets, limitations report, fencing | prompt tests |
| 36 | Read API unauthenticated (audit) | admin login, sessions, throttling, CSRF protection | API tests, e2e |
| 37 | `NEXT_PUBLIC_DEMO_SECRET` shipped to browsers; secret compared with `!==` (audit) | removed; session-authorised demo endpoint | API tests |
| 38 | All headers (including secrets) logged in production (audit) | allowlisted serializers + redaction; sanitised stored errors | e2e log scan |
| 39 | Dashboard never showed the AI analysis (audit) | full AI state contract and panel | frontend tests, e2e |
| 40 | Stale/static rendering; `/stats` prerendered at build (audit, reproduced) | per-request rendering, `no-store` | build output, e2e |
| 41 | Errors interpreted from message substrings (found) | `ApiError` with status; 401/403/404/5xx handling | frontend tests |
| 42 | No pagination controls; "Updated" showed creation time; no mobile nav (audit) | previous/next, GitHub updated time, mobile menu | frontend tests |
| 43 | Folder stats treated `schema.prisma` as a folder; all PRs loaded into memory (audit) | directory components; SQL aggregation; current-head preference | stats tests |
| 44 | Two seed paths with different shapes; duplicate history on re-seed; "10" PRs vs 11 (audit) | one deterministic, idempotent seed with 11 documented PRs; legacy reason objects normalised | demo and migration tests |
| 45 | CI set up node's pnpm cache before installing pnpm; no services (audit) | single `ci.yml` with correct order, services and all tiers | workflow definition |
| 46 | Documentation drift: wrong env names, missing `.env.example`, placeholder badges (audit) | README, backend README, `.env.example` files, this document | `.env.example` test |
| 47 | Dead code and duplicated retry helpers (audit) | removed; one GitHub retry module | lint, typecheck |
| 48 | `.gitignore` ignored `.dockerignore`; duplicate `*.pem` (audit) | fixed | — |
| 49 | Dev database/Redis exposed on all interfaces (found) | bound to 127.0.0.1 | Compose files |
| 50 | `enableOfflineQueue:false` + DB index in `REDIS_URL` → unhandled rejection (found in testing) | bounded offline queue + call-site timeouts | API tests (no unhandled errors) |
| 51 | Client-only function called from a server page (found by e2e) | moved to a shared module | e2e |
| 52 | Fastify `requestIdLogLabel` deprecation (found) | option removed (default `reqId` log label) | clean dev log |
| 53 | pnpm does not forward `SIGTERM` to its child (found) | production instructions run `node dist/*.js` directly | manual check |

## 29. Known limitations and unverified live checks

Verified only against mocks (confirming these needs real credentials or infrastructure):
- a real GitHub App installation: the JWT/installation-token exchange with api.github.com, real webhook deliveries and signatures, real permission errors and rate-limit headers, the 3,000-file limit, Checks/Statuses data from real CI providers, and comment authorship fields on github.com or GitHub Enterprise;
- real OpenAI responses and model behaviour for the configured `AI_MODEL`;
- the GitHub Actions workflow running on GitHub itself (its commands were run locally, in the same order, against equivalent containers).

Design limits:
- pattern-based redaction cannot catch every secret ([§16](#16-ai-review));
- CI status reflects what GitHub reports when the snapshot is taken; later CI changes arrive through `check_suite`/`status` events;
- only the first 100 commit-status contexts are read;
- the 5-minute PR lease bounds processing; if a job took longer, a second job could take over (results remain idempotent);
- a single admin account by design, with no roles and no audit trail of dashboard views;
- rows from before the migration may contain another repository's history; it is labelled and reported, not repaired ([§18](#18-data-model-and-migrations)).

## 30. Glossary

| Term | Meaning |
|---|---|
| **Installation** | a GitHub App installed on a user or organisation; its id scopes API tokens and defines the workspace |
| **Delivery** | one webhook sent by GitHub, identified by `X-GitHub-Delivery` |
| **Inbox** | the `webhook_deliveries` table where every accepted delivery is stored before it is acknowledged |
| **Dispatcher** | the worker loop that enqueues due, lost or abandoned deliveries |
| **Head SHA / revision** | the commit at the tip of the PR branch; results are tied to it |
| **Run** | one deterministic analysis of one revision with one set of inputs (`analysis_runs`) |
| **Input fingerprint** | hash of every scoring input; the idempotency key of a run |
| **Lease** | a time-limited database lock that serialises work on one PR |
| **Current / previous_head / legacy_unknown** | whether a result belongs to the PR's current head, an older head, or an unknown pre-migration revision |
| **Uncertainty** | an input that was not scored but limits confidence (pending CI, incomplete file list) |
| **Contribution** | the points one scoring rule added, with its reason |
| **Critical area** | a file in one of the six sensitive categories |
| **Churn** | additions + deletions |
| **Redaction** | replacing detected secrets with `[REDACTED]` before text leaves the system |
| **Marker** | the hidden `<!-- pr-risk-scorer:analysis -->` string that identifies this App's comment |
| **Workspace** | the set of installations (and optional repositories) this deployment serves |
| **Demo data** | repositories with negative ids and `is_demo=true`, created by the seed |
