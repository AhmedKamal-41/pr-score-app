-- CreateTable
CREATE TABLE "pr_ai_analyses" (
    "id" TEXT NOT NULL,
    "pull_request_id" TEXT NOT NULL,
    "analysis_json" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pr_ai_analyses_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "pr_ai_analyses" ADD CONSTRAINT "pr_ai_analyses_pull_request_id_fkey" FOREIGN KEY ("pull_request_id") REFERENCES "pull_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

