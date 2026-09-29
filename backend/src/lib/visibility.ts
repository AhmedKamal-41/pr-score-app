import { Prisma } from '@prisma/client';
import type { AppConfig } from '../config/env.js';

/**
 * Workspace data policy: the dashboard only serves repositories that are
 * active (access not revoked) and either demo data or part of the configured
 * GitHub App installations (and repository allowlist, if set). A dashboard
 * session never implies access to other installations stored in the DB.
 */
export function visibleRepoWhere(config: AppConfig): Prisma.RepoWhereInput {
  const workspace: Prisma.RepoWhereInput = { installation_id: { in: config.github.installationIds }, is_demo: false };
  if (config.github.repositories.length > 0) {
    workspace.full_name = { in: config.github.repositories, mode: 'insensitive' };
  }
  return { access_status: 'active', OR: [{ is_demo: true }, workspace] };
}

/** The same policy as SQL, for raw aggregate queries (`r` = repos alias). */
export function visibleRepoSql(config: AppConfig): Prisma.Sql {
  const ids = config.github.installationIds;
  const installationClause = ids.length ? Prisma.sql`r."installation_id" IN (${Prisma.join(ids)})` : Prisma.sql`FALSE`;
  const repoClause = config.github.repositories.length
    ? Prisma.sql`AND lower(r."full_name") IN (${Prisma.join(config.github.repositories)})`
    : Prisma.empty;
  return Prisma.sql`r."access_status" = 'active' AND (r."is_demo" OR (NOT r."is_demo" AND ${installationClause} ${repoClause}))`;
}
