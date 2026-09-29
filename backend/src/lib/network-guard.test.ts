import { describe, it, expect } from 'vitest';

// The Vitest setup file test/setup/network-guard.mjs must be active in every project.
describe('test network guard', () => {
  it('blocks connections to non-loopback hosts', async () => {
    const error = await fetch('https://api.github.com/').catch((e: Error & { cause?: Error }) => e.cause ?? e);
    expect(String((error as Error).message)).toMatch(/blocked during tests/);
  });

  it('allows loopback connections', async () => {
    const error = await fetch('http://127.0.0.1:9/').catch((e: Error & { cause?: Error }) => e.cause ?? e);
    expect(String((error as Error).message)).not.toMatch(/blocked during tests/);
  });
});
