import { createHash, randomBytes } from 'node:crypto';
import type { AdminSession, PrismaClient } from '@prisma/client';

/** Only a SHA-256 of the token is stored, so a database leak does not leak live sessions. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(
  prisma: PrismaClient,
  username: string,
  ttlMs: number,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlMs);
  await prisma.adminSession.create({ data: { id: hashSessionToken(token), username, expires_at: expiresAt } });
  return { token, expiresAt };
}

const TOUCH_INTERVAL_MS = 5 * 60_000;

export async function findValidSession(prisma: PrismaClient, token: string, username: string): Promise<AdminSession | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const session = await prisma.adminSession.findUnique({ where: { id: hashSessionToken(token) } });
  if (!session || session.revoked_at || session.expires_at <= new Date() || session.username !== username) return null;
  if (Date.now() - session.last_seen_at.getTime() > TOUCH_INTERVAL_MS) {
    await prisma.adminSession.update({ where: { id: session.id }, data: { last_seen_at: new Date() } });
  }
  return session;
}

export async function revokeSession(prisma: PrismaClient, token: string): Promise<void> {
  await prisma.adminSession.updateMany({
    where: { id: hashSessionToken(token), revoked_at: null },
    data: { revoked_at: new Date() },
  });
}

/** Housekeeping: drop sessions that expired or were revoked more than a day ago. */
export async function pruneSessions(prisma: PrismaClient): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 3600_000);
  const r = await prisma.adminSession.deleteMany({
    where: { OR: [{ expires_at: { lt: cutoff } }, { revoked_at: { lt: cutoff } }] },
  });
  return r.count;
}
