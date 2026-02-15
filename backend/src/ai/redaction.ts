/**
 * Redact secrets from text to prevent sending sensitive data to AI
 */

// Common secret patterns
const SECRET_PATTERNS = [
  // API keys (various formats)
  /(?:api[_-]?key|apikey)\s*[:=]\s*['"]?([a-zA-Z0-9_\-]{20,})['"]?/gi,
  /(?:secret[_-]?key|secretkey)\s*[:=]\s*['"]?([a-zA-Z0-9_\-]{20,})['"]?/gi,
  /sk_live_[a-zA-Z0-9]{24,}/gi,
  /sk_test_[a-zA-Z0-9]{24,}/gi,
  /pk_live_[a-zA-Z0-9]{24,}/gi,
  /pk_test_[a-zA-Z0-9]{24,}/gi,
  /AIza[0-9A-Za-z\-_]{35}/gi, // Google API key
  /AKIA[0-9A-Z]{16}/gi, // AWS access key ID
  
  // Tokens
  /(?:token|access[_-]?token|bearer[_-]?token)\s*[:=]\s*['"]?([a-zA-Z0-9_\-\.]{20,})['"]?/gi,
  /eyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.?[A-Za-z0-9\-_.]*/g, // JWT tokens
  
  // Passwords
  /(?:password|passwd|pwd)\s*[:=]\s*['"]?([^\s'"]{8,})['"]?/gi,
  
  // Private keys (PEM format)
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/gi,
  /-----BEGIN\s+EC\s+PRIVATE\s+KEY-----[\s\S]*?-----END\s+EC\s+PRIVATE\s+KEY-----/gi,
  /-----BEGIN\s+DSA\s+PRIVATE\s+KEY-----[\s\S]*?-----END\s+DSA\s+PRIVATE\s+KEY-----/gi,
  
  // OAuth secrets
  /(?:client[_-]?secret|oauth[_-]?secret)\s*[:=]\s*['"]?([a-zA-Z0-9_\-]{20,})['"]?/gi,
  
  // Database connection strings with passwords
  /(?:postgresql|postgres|mysql|mongodb):\/\/[^:]+:([^@]+)@/gi,
  
  // SSH keys
  /-----BEGIN\s+(?:OPENSSH\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:OPENSSH\s+)?PRIVATE\s+KEY-----/gi,
  
  // Generic long hex/base64 strings that might be secrets
  /(?:secret|key|token|password)\s*[:=]\s*['"]?([a-fA-F0-9]{32,}|[A-Za-z0-9+/]{40,}={0,2})['"]?/gi,
];

/**
 * Redact secrets from text
 * Replaces detected secrets with [REDACTED] placeholder
 */
export function redactSecrets(text: string): string {
  if (!text || typeof text !== 'string') {
    return text;
  }

  let redacted = text;

  // Apply each pattern
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match, captured) => {
      // For patterns with capture groups, replace the captured part
      if (captured) {
        return match.replace(captured, '[REDACTED]');
      }
      // For full match patterns (like PEM keys), replace entire match
      return '[REDACTED]';
    });
  }

  return redacted;
}

