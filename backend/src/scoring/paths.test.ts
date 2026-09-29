import { describe, it, expect } from 'vitest';
import { criticalCategoriesFor, isTestFile, statsFolderFor, tokenize } from './paths.js';

describe('isTestFile', () => {
  it.each([
    'src/user.test.ts',
    'src/components/Button.spec.tsx',
    'tests/utils.ts',
    'test/integration/api.ts',
    'src/__tests__/foo.ts',
    'pkg/server_test.go',
    'spec/models/user_spec.rb',
    'app/test_views.py',
    'src/main/java/FooTest.java',
    'e2e/login.ts',
  ])('recognises %s', (path) => {
    expect(isTestFile(path)).toBe(true);
  });

  it.each(['src/latest.ts', 'src/inspector.ts', 'contest/index.ts', 'docs/specification.md', 'src/attestation.ts', 'src/testing-utils.ts'])(
    'does not treat %s as a test',
    (path) => {
      expect(isTestFile(path)).toBe(false);
    },
  );
});

describe('criticalCategoriesFor', () => {
  it.each([
    ['src/auth/login.ts', ['Authentication']],
    ['src/middleware/authMiddleware.ts', ['Authentication']],
    ['lib/user-session.ts', ['Authentication']],
    ['src/utils/jwt.ts', ['Authentication']],
    ['src/payments/stripe.ts', ['Payments']],
    ['app/billing/invoice.rb', ['Payments']],
    ['src/config/flags.ts', ['Configuration']],
    ['.env.production', ['Configuration']],
    ['infra/main.tf', ['Infrastructure']],
    ['Dockerfile', ['Infrastructure']],
    ['docker-compose.yml', ['Infrastructure']],
    ['prisma/migrations/2024_init/migration.sql', ['Migrations']],
    ['prisma/schema.prisma', ['Migrations']],
    ['db/migrate/20240101_add_users.rb', ['Migrations']],
    ['.github/workflows/ci.yml', ['CI/CD workflows']],
    ['src/config/auth.ts', ['Authentication', 'Configuration']],
  ] as const)('%s → %j', (path, expected) => {
    expect(criticalCategoriesFor(path)).toEqual(expected);
  });

  it.each([
    'src/author.ts',
    'src/authorName.ts',
    'src/latest.ts',
    'src/inspector.ts',
    'contest/index.ts',
    'docs/specification.md',
    'docs/describe-schema.txt',
    'src/components/SessionlessCard.tsx',
    'src/deployer-notes.md',
    '.github/CODEOWNERS',
    'README.md',
  ])('does not flag %s', (path) => {
    expect(criticalCategoriesFor(path)).toEqual([]);
  });

  it('never flags test files, even in sensitive directories', () => {
    expect(criticalCategoriesFor('src/auth/login.test.ts')).toEqual([]);
    expect(criticalCategoriesFor('tests/payments/billing.ts')).toEqual([]);
  });
});

describe('tokenize', () => {
  it('splits separators and camelCase', () => {
    expect(tokenize('authMiddleware')).toEqual(['auth', 'middleware']);
    expect(tokenize('user-session_store')).toEqual(['user', 'session', 'store']);
    expect(tokenize('HTTPServerConfig')).toEqual(['http', 'server', 'config']);
  });
});

describe('statsFolderFor', () => {
  it.each([
    ['src/auth/login.ts', 'src/auth'],
    ['src/auth/deep/nested/file.ts', 'src/auth'],
    ['prisma/schema.prisma', 'prisma'],
    ['.github/workflows/ci.yml', '.github/workflows'],
    ['README.md', null],
    ['Dockerfile', null],
  ])('%s → %s', (path, folder) => {
    expect(statsFolderFor(path)).toBe(folder);
  });
});
