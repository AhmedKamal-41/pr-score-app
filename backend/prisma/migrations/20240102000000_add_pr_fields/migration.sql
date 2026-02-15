-- AlterTable
ALTER TABLE "pull_requests" ADD COLUMN "additions" INTEGER,
ADD COLUMN "deletions" INTEGER,
ADD COLUMN "changed_files" INTEGER,
ADD COLUMN "changed_files_list" JSONB;

