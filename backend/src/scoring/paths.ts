/**
 * Deliberate path conventions for critical areas and test files.
 *
 * Matching is done on whole path segments and on whole filename tokens,
 * never on arbitrary substrings. Filenames are tokenised on non-alphanumeric
 * characters and camelCase boundaries, so `user-session.ts` and
 * `authMiddleware.ts` yield the tokens `session` and `auth`, while
 * `author.ts`, `latest.ts`, `inspector.ts`, `contest/` and
 * `specification.md` match nothing.
 */

export type CriticalCategory =
  | 'Authentication'
  | 'Payments'
  | 'Configuration'
  | 'Infrastructure'
  | 'Migrations'
  | 'CI/CD workflows';

/** Order is the canonical display order of categories. */
export const CRITICAL_CATEGORY_ORDER: readonly CriticalCategory[] = [
  'Authentication',
  'Payments',
  'Configuration',
  'Infrastructure',
  'Migrations',
  'CI/CD workflows',
];

interface CategoryRule {
  category: CriticalCategory;
  /** Whole tokens matched against directory names and the filename. */
  tokens?: ReadonlySet<string>;
  /** Exact directory segment names (case-insensitive). */
  directories?: ReadonlySet<string>;
  /** Exact file basenames (case-insensitive). */
  basenames?: ReadonlySet<string>;
  /** Basename patterns (anchored). */
  basenamePatterns?: readonly RegExp[];
  /** Path prefixes, as leading directory segments. */
  prefixes?: readonly string[][];
}

const RULES: readonly CategoryRule[] = [
  {
    category: 'Authentication',
    tokens: new Set(['auth', 'authentication', 'authn', 'authz', 'login', 'logout', 'session', 'sessions', 'oauth', 'sso', 'jwt', 'passport']),
  },
  {
    category: 'Payments',
    tokens: new Set(['payment', 'payments', 'billing', 'invoice', 'invoices']),
  },
  {
    category: 'Configuration',
    tokens: new Set(['config', 'configs', 'configuration', 'settings']),
    basenamePatterns: [/^\.env(\..+)?$/],
  },
  {
    category: 'Infrastructure',
    tokens: new Set(['infra', 'infrastructure', 'deploy', 'deployment', 'deployments', 'terraform', 'helm', 'k8s', 'kubernetes']),
    basenamePatterns: [/^dockerfile(\..+)?$/, /^docker-compose(\..+)?\.ya?ml$/, /^compose\.ya?ml$/],
  },
  {
    category: 'Migrations',
    directories: new Set(['migrations', 'migration', 'migrate']),
    basenames: new Set(['schema.prisma', 'schema.rb', 'structure.sql', 'schema.sql']),
  },
  {
    category: 'CI/CD workflows',
    prefixes: [['.github', 'workflows'], ['.github', 'actions'], ['.circleci'], ['.gitlab-ci.yml'], ['.buildkite']],
  },
];

const TEST_DIRECTORIES = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'e2e', 'integration-tests']);
const TEST_BASENAME_PATTERNS: readonly RegExp[] = [
  /\.(test|spec)\.[a-z0-9]+$/i, // foo.test.ts, foo.spec.tsx
  /_(test|spec)\.[a-z0-9]+$/i, // foo_test.go, foo_spec.rb
  /^test_.+\.py$/i, // test_foo.py
  /Tests?\.(java|kt|cs|swift)$/, // FooTest.java, FooTests.swift
];

function splitPath(filePath: string): { dirs: string[]; basename: string } {
  const segments = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  const basename = segments.pop() ?? '';
  return { dirs: segments, basename };
}

/** Split a name into lower-case tokens on non-alphanumerics and camelCase boundaries. */
export function tokenize(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

function stripExtensions(basename: string): string {
  // Keep leading-dot names like ".env" intact.
  const idx = basename.indexOf('.', 1);
  return idx === -1 ? basename : basename.slice(0, idx);
}

export function isTestFile(filePath: string): boolean {
  const { dirs, basename } = splitPath(filePath);
  if (dirs.some((d) => TEST_DIRECTORIES.has(d.toLowerCase()))) return true;
  return TEST_BASENAME_PATTERNS.some((p) => p.test(basename));
}

/**
 * All critical categories a file belongs to (deduplicated, canonical order).
 * Test files never count as critical: a change that only touches tests of a
 * sensitive area does not change that area's behaviour.
 */
export function criticalCategoriesFor(filePath: string): CriticalCategory[] {
  if (isTestFile(filePath)) return [];
  const { dirs, basename } = splitPath(filePath);
  const lowerDirs = dirs.map((d) => d.toLowerCase());
  const lowerBase = basename.toLowerCase();
  const tokens = new Set<string>([
    ...lowerDirs.flatMap((d) => tokenize(d)),
    ...tokenize(stripExtensions(basename)),
  ]);
  const allSegments = [...lowerDirs, lowerBase];

  const found = new Set<CriticalCategory>();
  for (const rule of RULES) {
    const matches =
      (rule.tokens && [...tokens].some((t) => rule.tokens!.has(t))) ||
      (rule.directories && lowerDirs.some((d) => rule.directories!.has(d))) ||
      (rule.basenames && rule.basenames.has(lowerBase)) ||
      (rule.basenamePatterns && rule.basenamePatterns.some((p) => p.test(lowerBase))) ||
      (rule.prefixes && rule.prefixes.some((prefix) => prefix.every((seg, i) => allSegments[i] === seg)));
    if (matches) found.add(rule.category);
  }
  return CRITICAL_CATEGORY_ORDER.filter((c) => found.has(c));
}

export function isCriticalFile(filePath: string): boolean {
  return criticalCategoriesFor(filePath).length > 0;
}

/**
 * Folder used for statistics: the first two *directory* components of a path.
 * Files at the repository root have no folder (null). A filename is never a folder.
 */
export function statsFolderFor(filePath: string): string | null {
  const { dirs } = splitPath(filePath);
  if (dirs.length === 0) return null;
  return dirs.slice(0, 2).join('/');
}
