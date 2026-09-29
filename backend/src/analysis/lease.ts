import type { PrismaClient } from '@prisma/client';

/**
 * Database-backed mutual exclusion across worker processes. A lease is taken
 * atomically with INSERT … ON CONFLICT … WHERE expired, so exactly one owner
 * holds a key at a time; an expired lease (crashed worker) can be taken over.
 */
export async function acquireLease(prisma: PrismaClient, key: string, owner: string, ttlMs: number): Promise<boolean> {
  const expiresAt = new Date(Date.now() + ttlMs);
  const rows = await prisma.$queryRaw<{ owner: string }[]>`
    INSERT INTO "processing_leases" ("key", "owner", "expires_at")
    VALUES (${key}, ${owner}, ${expiresAt})
    ON CONFLICT ("key") DO UPDATE
      SET "owner" = EXCLUDED."owner", "expires_at" = EXCLUDED."expires_at"
      WHERE "processing_leases"."expires_at" < NOW() OR "processing_leases"."owner" = EXCLUDED."owner"
    RETURNING "owner"`;
  return rows.length === 1 && rows[0].owner === owner;
}

export async function releaseLease(prisma: PrismaClient, key: string, owner: string): Promise<void> {
  await prisma.processingLease.deleteMany({ where: { key, owner } });
}
