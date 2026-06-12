/**
 * Deterministic secret scrubbing.
 *
 * Hard rule carried from the old vault's AGENTS.md: never store secrets, keys,
 * or tokens. This pass runs twice — over the normalized transcript before it is
 * sent to the extractor, and over every memory body before it is written — so a
 * leak requires both the LLM and these patterns to miss it.
 */

const REDACTED = "«redacted»";

/**
 * Ordered list of patterns. Each replaces the matched secret (or a capture
 * group) with {@link REDACTED}. Patterns are intentionally broad; over-redaction
 * is acceptable, leaking is not.
 */
const PATTERNS: Array<{ re: RegExp; group?: number }> = [
  // Private key blocks (PEM).
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  // Provider-prefixed API keys.
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/g }, // OpenAI-style
  { re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g }, // Anthropic
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g }, // GitHub tokens
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g }, // Slack
  { re: /\bAKIA[0-9A-Z]{16}\b/g }, // AWS access key id
  { re: /\bASIA[0-9A-Z]{16}\b/g }, // AWS temp access key id
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g }, // Google API key
  { re: /\bya29\.[0-9A-Za-z_-]+\b/g }, // Google OAuth token
  // JWTs.
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  // Generic "key = value" / "token: value" / "password=..." assignments.
  {
    re: /\b(?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*["']?([^\s"',}]{6,})/gi,
    group: 1,
  },
  // Bearer headers.
  { re: /\b[Bb]earer\s+([A-Za-z0-9._-]{12,})/g, group: 1 },
  // URLs with inline credentials: scheme://user:pass@host
  { re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)(@)/gi, group: 2 },
];

/** Replace anything that looks like a credential with a redaction marker. */
export function scrub(input: string): string {
  let out = input;
  for (const { re, group } of PATTERNS) {
    out = out.replace(re, (match, ...groups) => {
      if (group === undefined) return REDACTED;
      const captured = groups[group - 1] as string | undefined;
      return captured ? match.replace(captured, REDACTED) : REDACTED;
    });
  }
  return out;
}

/** True if scrubbing would change the input (i.e. a secret was present). */
export function containsSecret(input: string): boolean {
  return scrub(input) !== input;
}
