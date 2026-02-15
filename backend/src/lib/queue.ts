import { Queue } from 'bullmq';
import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

// Create Redis connection
const connection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

// Job data interface
export interface ScorePrJobData {
  owner: string;
  name: string;
  pr_number: number;
  installation_id?: number;
  delivery_id: string;
}

// Create queue instance
export const scorePrQueue = new Queue<ScorePrJobData>('score_pr', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: {
      age: 3600, // Keep completed jobs for 1 hour
      count: 1000, // Keep max 1000 completed jobs
    },
    removeOnFail: {
      age: 86400, // Keep failed jobs for 24 hours
    },
  },
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await scorePrQueue.close();
  await connection.quit();
});

process.on('SIGINT', async () => {
  await scorePrQueue.close();
  await connection.quit();
});

