import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolves to backend/package.json from both src/config (tsx) and dist/config (compiled).
const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), '../../package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version?: string };

export const APP_VERSION: string = packageJson.version ?? '0.0.0';

/** Scoring contract version written to every new score. See scoring/rules.ts. */
export const SCORING_VERSION = 'v2';

/** AI prompt contract version written to every new AI analysis. */
export const PROMPT_VERSION = 'v2';

/** Hidden marker identifying this app's single analysis comment on a PR. */
export const COMMENT_MARKER = '<!-- pr-risk-scorer:analysis -->';

export const SESSION_COOKIE = 'prs_session';
export const EVENTS_QUEUE = 'pr_events';
