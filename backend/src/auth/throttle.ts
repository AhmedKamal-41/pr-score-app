import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

/**
 * Login throttling in Redis (shared by all API processes):
 * at most `maxPerIp` failures per client IP and `maxPerUser` failures per
 * username within `windowSeconds`. A successful login clears the IP counter.
 * If Redis is unavailable, logins are refused (fail closed).
 */
export class LoginThrottle {
  constructor(
    private readonly redis: Redis,
    private readonly options = { maxPerIp: 5, maxPerUser: 20, windowSeconds: 15 * 60 },
  ) {}

  private keys(ip: string, username: string) {
    const user = createHash('sha256').update(username.toLowerCase()).digest('hex').slice(0, 32);
    return { ip: `login-fail:ip:${ip}`, user: `login-fail:user:${user}` };
  }

  async check(ip: string, username: string): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
    const k = this.keys(ip, username);
    const [ipCount, userCount] = await this.redis.mget(k.ip, k.user);
    const blockedKey =
      Number(ipCount ?? 0) >= this.options.maxPerIp ? k.ip : Number(userCount ?? 0) >= this.options.maxPerUser ? k.user : null;
    if (!blockedKey) return { allowed: true };
    const ttl = await this.redis.ttl(blockedKey);
    return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : this.options.windowSeconds };
  }

  async recordFailure(ip: string, username: string): Promise<void> {
    const k = this.keys(ip, username);
    await this.redis
      .multi()
      .incr(k.ip)
      .expire(k.ip, this.options.windowSeconds, 'NX')
      .incr(k.user)
      .expire(k.user, this.options.windowSeconds, 'NX')
      .exec();
  }

  async recordSuccess(ip: string): Promise<void> {
    await this.redis.del(`login-fail:ip:${ip}`);
  }
}
