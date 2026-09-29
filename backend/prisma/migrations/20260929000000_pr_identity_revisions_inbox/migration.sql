-- Additive repair migration.
--  * PR identity: repository-local `number` unique per repo; GitHub global id kept separately.
--    The legacy `github_pr_id` column (which really held the PR number) is preserved,
--    no longer unique, and every pre-existing PR row is marked `legacy_unverified`.
--  * Revision tracking for scores/AI analyses, analysis runs, durable webhook inbox,
--    processing leases, admin sessions, and supporting indexes.
-- No existing row, UUID, foreign key, score or AI analysis is deleted or rewritten.

-- ---------------------------------------------------------------- repos
ALTER TABLE "repos"
  ADD COLUMN "visibility" TEXT,
  ADD COLUMN "access_status" TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN "access_revoked_at" TIMESTAMP(3),
  ADD COLUMN "is_demo" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "repos_installation_id_idx" ON "repos"("installation_id");

-- ---------------------------------------------------------------- pull_requests
ALTER TABLE "pull_requests"
  ADD COLUMN "number" INTEGER,
  ADD COLUMN "github_id" BIGINT,
  -- Existing rows get 'legacy_unverified'; the default is switched to 'verified' below.
  ADD COLUMN "identity_status" TEXT NOT NULL DEFAULT 'legacy_unverified',
  ADD COLUMN "draft" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "github_created_at" TIMESTAMP(3),
  ADD COLUMN "github_updated_at" TIMESTAMP(3),
  ADD COLUMN "closed_at" TIMESTAMP(3),
  ADD COLUMN "bot_comment_id" BIGINT,
  ADD COLUMN "bot_comment_sha" TEXT;

ALTER TABLE "pull_requests" ALTER COLUMN "identity_status" SET DEFAULT 'verified';

-- Backfill the PR number from the legacy column when it is a valid PR number.
UPDATE "pull_requests"
   SET "number" = "github_pr_id"::INTEGER
 WHERE "github_pr_id" BETWEEN 1 AND 2147483647;

-- Values that cannot be PR numbers are preserved in github_pr_id and reported, never guessed.
UPDATE "pull_requests"
   SET "identity_status" = 'legacy_invalid_number'
 WHERE "number" IS NULL;

-- The legacy column is no longer an identity.
DROP INDEX "pull_requests_github_pr_id_key";
ALTER TABLE "pull_requests" ALTER COLUMN "github_pr_id" DROP NOT NULL;

CREATE UNIQUE INDEX "pull_requests_repo_id_number_key" ON "pull_requests"("repo_id", "number");
CREATE UNIQUE INDEX "pull_requests_github_id_key" ON "pull_requests"("github_id");
CREATE INDEX "pull_requests_repo_id_head_sha_idx" ON "pull_requests"("repo_id", "head_sha");
CREATE INDEX "pull_requests_updated_at_id_idx" ON "pull_requests"("updated_at", "id");

-- ---------------------------------------------------------------- analysis_runs
CREATE TABLE "analysis_runs" (
    "id" TEXT NOT NULL,
    "pull_request_id" TEXT NOT NULL,
    "head_sha" TEXT NOT NULL,
    "input_fingerprint" TEXT NOT NULL,
    "scoring_version" TEXT NOT NULL,
    "ci_status" TEXT NOT NULL,
    "trigger_delivery_id" TEXT,
    "ai_status" TEXT NOT NULL,
    "ai_error" TEXT,
    "ai_attempts" INTEGER NOT NULL DEFAULT 0,
    "comment_status" TEXT NOT NULL,
    "comment_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "analysis_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "analysis_runs_pull_request_id_input_fingerprint_key" ON "analysis_runs"("pull_request_id", "input_fingerprint");
CREATE INDEX "analysis_runs_pull_request_id_created_at_id_idx" ON "analysis_runs"("pull_request_id", "created_at", "id");

ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_pull_request_id_fkey" FOREIGN KEY ("pull_request_id") REFERENCES "pull_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------- pr_scores
-- Existing scores keep scoring_version = 'legacy' and NULL head_sha (revision unknown).
ALTER TABLE "pr_scores"
  ADD COLUMN "head_sha" TEXT,
  ADD COLUMN "scoring_version" TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN "ci_status" TEXT,
  ADD COLUMN "contributions" JSONB,
  ADD COLUMN "coverage" JSONB,
  ADD COLUMN "input_fingerprint" TEXT,
  ADD COLUMN "run_id" TEXT;

CREATE UNIQUE INDEX "pr_scores_run_id_key" ON "pr_scores"("run_id");
CREATE UNIQUE INDEX "pr_scores_pull_request_id_input_fingerprint_key" ON "pr_scores"("pull_request_id", "input_fingerprint");
CREATE INDEX "pr_scores_pull_request_id_created_at_id_idx" ON "pr_scores"("pull_request_id", "created_at", "id");

ALTER TABLE "pr_scores" ADD CONSTRAINT "pr_scores_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "analysis_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------- pr_ai_analyses
ALTER TABLE "pr_ai_analyses"
  ADD COLUMN "head_sha" TEXT,
  ADD COLUMN "input_fingerprint" TEXT,
  ADD COLUMN "limitations" JSONB,
  ADD COLUMN "run_id" TEXT;

CREATE UNIQUE INDEX "pr_ai_analyses_run_id_key" ON "pr_ai_analyses"("run_id");
CREATE INDEX "pr_ai_analyses_pull_request_id_created_at_id_idx" ON "pr_ai_analyses"("pull_request_id", "created_at", "id");

ALTER TABLE "pr_ai_analyses" ADD CONSTRAINT "pr_ai_analyses_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "analysis_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------- webhook_deliveries
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "action" TEXT,
    "payload_sha256" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "installation_id" BIGINT,
    "repo_github_id" BIGINT,
    "repo_full_name" TEXT,
    "pr_number" INTEGER,
    "head_sha" TEXT,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "ignored_reason" TEXT,
    "next_attempt_at" TIMESTAMP(3),
    "enqueued_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "webhook_deliveries_status_next_attempt_at_idx" ON "webhook_deliveries"("status", "next_attempt_at");
CREATE INDEX "webhook_deliveries_received_at_idx" ON "webhook_deliveries"("received_at");

-- ---------------------------------------------------------------- processing_leases
CREATE TABLE "processing_leases" (
    "key" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "processing_leases_pkey" PRIMARY KEY ("key")
);

-- ---------------------------------------------------------------- admin_sessions
CREATE TABLE "admin_sessions" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "admin_sessions_expires_at_idx" ON "admin_sessions"("expires_at");
