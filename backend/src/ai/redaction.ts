/**
 * Pattern-based secret detection and redaction.
 *
 * Applied to everything sent to the AI provider (diffs, file names, reasons)
 * and to AI output before it is stored or published.
 *
 * Limits (by design, documented in project.md): pattern matching only finds
 * secrets with a recognisable shape or an obvious `name = value` assignment.
 * It cannot recognise arbitrary high-entropy strings without context, secrets
 * split across lines or encoded, or credentials in unusual formats. It reduces
 * accidental disclosure; it is not a guarantee.
 */

interface Detector {
  name: string;
  /**
   * Global regex. Partial detectors use named groups `prefix` and `secret`
   * (and optionally `suffix`); only `secret` is replaced. Others replace the
   * entire match.
   */
  regex: RegExp;
}

const KEYWORD_SECRET =
  '(?:[A-Za-z0-9_.-]*?(?:api[_ -]?key|apikey|secret(?:[_-]?key)?|client[_-]?secret|oauth[_-]?secret|access[_-]?key|private[_-]?key|' +
  '(?:access|auth|bearer|refresh|session|id)?[_-]?token)[A-Za-z0-9_]*)';
const KEYWORD_PASSWORD = '(?:[A-Za-z0-9_.-]*?(?:password|passwd|pwd|passphrase)[A-Za-z0-9_]*)';
// Values that are references, not literals: env lookups, templates, placeholders.
const NOT_A_REFERENCE = '(?!process\\.env|os\\.environ|env\\(|getenv|ENV\\[|\\$\\{|\\$\\(|<|\\[REDACTED\\])';

export const DETECTORS: readonly Detector[] = [
  {
    name: 'pem_private_key',
    regex: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    // A key block cut off by diff truncation or context: redact to the end.
    name: 'pem_private_key_unterminated',
    regex: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*$/g,
  },
  {
    name: 'credential_url',
    regex: /(?<prefix>\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"]+:)(?!\[REDACTED\])(?<secret>[^\s@/'"]+)(?=@)/gi,
  },
  { name: 'github_token', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g },
  { name: 'stripe_key', regex: /\b[rsp]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: 'aws_access_key_id', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'google_api_key', regex: /\bAIza[0-9A-Za-z_-]{35}/g },
  { name: 'slack_token', regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'openai_anthropic_key', regex: /\bsk-(?:proj-|ant-(?:api\d+-)?)?[A-Za-z0-9_-]{20,}/g },
  { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g },
  {
    name: 'authorization_header',
    regex: /(?<prefix>\bAuthorization["']?\s*[:=]\s*["']?(?:Bearer|Basic|token)\s+)(?<secret>[A-Za-z0-9._~+/=-]{8,})/gi,
  },
  {
    name: 'secret_assignment',
    regex: new RegExp(
      `(?<prefix>\\b${KEYWORD_SECRET}["']?\\s*(?::|=|=>)\\s*["'\`]?)${NOT_A_REFERENCE}(?<secret>[A-Za-z0-9_\\-+/=.~]{16,})`,
      'gi',
    ),
  },
  {
    name: 'password_assignment',
    regex: new RegExp(
      `(?<prefix>\\b${KEYWORD_PASSWORD}["']?\\s*(?::|=|=>)\\s*["'\`]?)${NOT_A_REFERENCE}(?<secret>[^\\s"'\`,;]{8,})`,
      'gi',
    ),
  },
];

const NON_GLOBAL: readonly RegExp[] = DETECTORS.map((d) => new RegExp(d.regex.source, d.regex.flags.replace('g', '')));

export const REDACTED = '[REDACTED]';

export interface RedactionResult {
  text: string;
  count: number;
}

export function redactSecretsDetailed(text: string): RedactionResult {
  if (typeof text !== 'string' || text === '') return { text, count: 0 };
  let out = text;
  let count = 0;
  for (const detector of DETECTORS) {
    out = out.replace(detector.regex, (...args: unknown[]) => {
      const match = args[0] as string;
      // With named groups the final argument is the groups object; without
      // them it is the input string. Never interpret positional arguments.
      const last = args[args.length - 1];
      const groups = typeof last === 'object' && last !== null ? (last as Record<string, string | undefined>) : undefined;
      if (groups?.secret === REDACTED) return match;
      count += 1;
      if (groups && groups.secret !== undefined && groups.prefix !== undefined) {
        return `${groups.prefix}${REDACTED}${groups.suffix ?? ''}`;
      }
      return REDACTED;
    });
  }
  return { text: out, count };
}

/** Redact secrets in `text`. Non-string input is returned unchanged. */
export function redactSecrets(text: string): string {
  return redactSecretsDetailed(text).text;
}

/** Stateless check: does the text contain anything a detector recognises? */
export function containsSecret(text: string): boolean {
  if (typeof text !== 'string' || text === '') return false;
  return NON_GLOBAL.some((re) => re.test(text));
}
