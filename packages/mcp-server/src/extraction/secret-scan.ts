/**
 * Context-aware secret DETECTOR for the commit-time secret gate.
 *
 * This is the second net behind {@link sanitizeTranscript}. Sanitization
 * *redacts* known secret formats best-effort and lets the content through;
 * this scanner instead *detects* likely secrets so `commit_session` can
 * **block** the write (append-only storage cannot be undone — for permanent
 * storage, blocking beats silently redacting).
 *
 * The key rule that sanitization can't express is **entropy-in-context**: a
 * long, high-entropy token that appears next to a credential indicator word
 * (`password`, `token`, `api_key`, …). That catches unusual/novel secret
 * formats while NOT flagging high-entropy non-secrets (Walrus blob ids, git
 * hashes) that appear *without* credential context.
 *
 * The detector is pure and deterministic and NEVER returns the secret itself —
 * each finding carries only a masked sample safe to surface in an error.
 */

/** One detected likely-secret, with a masked (never raw) sample for messages. */
export interface SecretFinding {
  /** What tripped the detector (e.g. "key-prefix", "jwt", "high-entropy-credential"). */
  kind: string;
  /** Masked, non-reversible preview of the offending token — safe to log/show. */
  sample: string;
}

/** Words whose presence on a line marks nearby high-entropy tokens as credentials. */
const CREDENTIAL_INDICATOR =
  /(?:pass(?:word|wd)?|secret|token|api[\s_-]?key|apikey|bearer|auth|credential|access[\s_-]?key|secret[\s_-]?key|private[\s_-]?key|client[\s_-]?secret)/i;

/** A run of base64/hex/url-safe characters long enough to be a credential. */
const TOKEN_RE = /[A-Za-z0-9+/=_-]{20,}/g;

/** Minimum Shannon entropy (bits/char) for a token to look random, not English. */
const ENTROPY_THRESHOLD = 3.5;

/** Mask a token to a non-reversible preview: first 3 chars + length. */
function mask(token: string): string {
  if (token.length <= 8) return "****";
  return `${token.slice(0, 3)}…(${token.length} chars)`;
}

/** Shannon entropy (bits per character) of a string. */
function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * High-confidence, format-specific detectors. Each finds whole-match tokens.
 * (Mirrors the sanitize rules so the gate also protects callers that invoke
 * `commit_session` directly, bypassing `extract_session`'s sanitization.)
 */
const FORMAT_RULES: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  {
    kind: "private-key-block",
    pattern:
      /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
  },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { kind: "openai-key", pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g },
  { kind: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/g },
  { kind: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "slack-token", pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}/g },
  { kind: "gitlab-token", pattern: /\bglpat-[0-9A-Za-z_-]{20,}/g },
  {
    kind: "connection-string-credentials",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s:/@]+@/gi,
  },
];

/**
 * Scan `text` for likely secrets. Returns one finding per distinct offending
 * token; an empty array means nothing tripped. Pure and deterministic.
 *
 * Detection order:
 *   1. Format-specific rules (key prefixes, JWT, PEM, connection strings).
 *   2. Entropy-in-context: per line, if a credential indicator word is present,
 *      any long high-entropy token on that line is flagged.
 *
 * Tokens already reported by a format rule are not double-reported.
 */
export function scanForSecrets(text: string): SecretFinding[] {
  if (typeof text !== "string" || text.length === 0) return [];

  const findings: SecretFinding[] = [];
  const seen = new Set<string>();

  // 1. Format-specific high-confidence rules.
  for (const rule of FORMAT_RULES) {
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.pattern.exec(text)) !== null) {
      const token = m[0];
      if (seen.has(token)) continue;
      seen.add(token);
      findings.push({ kind: rule.kind, sample: mask(token) });
    }
  }

  // 2. Entropy-in-context: only tokens on a line that also names a credential.
  for (const line of text.split("\n")) {
    if (!CREDENTIAL_INDICATOR.test(line)) continue;
    TOKEN_RE.lastIndex = 0;
    let t: RegExpExecArray | null;
    while ((t = TOKEN_RE.exec(line)) !== null) {
      const token = t[0];
      if (seen.has(token)) continue;
      // A redaction placeholder (e.g. [REDACTED_API_KEY]) won't match TOKEN_RE
      // (brackets excluded), so sanitized content does not trip this rule.
      if (shannonEntropy(token) >= ENTROPY_THRESHOLD) {
        seen.add(token);
        findings.push({ kind: "high-entropy-credential", sample: mask(token) });
      }
    }
  }

  return findings;
}
