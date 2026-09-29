import { PrismaClient } from '@prisma/client';

export function createPrisma(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasourceUrl: databaseUrl, log: ['error'] });
}

export type { PrismaClient };
