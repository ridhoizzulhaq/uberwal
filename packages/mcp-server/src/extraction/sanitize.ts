/**
 * Best-effort, local secret redaction for session transcripts.
 *
 * This runs entirely inside the MCP server **before** a transcript is sent to
 * the Claude API or chunked for storage on Walrus. It makes no network calls.
 *
 * Why it exists: a coding-session transcript can accidentally contain
 * credentials (API keys, passwords, connection strings, private keys, JWTs).
 * Walrus storage is append-only, so anything written there cannot be deleted —
 * and the Claude API would otherwise see the raw secret. Redacting locally,
 * first in the pipeline, shrinks that blast radius.
 *
 * IMPORTANT — this is best-effort, NOT a guarantee. Pattern-based redaction
 * cannot catch every secret format. Unusual or novel formats can slip through,
 * reach the model provider, and be stored on Walrus. Developers should not capture
 * sessions that contain critical credentials. See the README "Security" note.
 *
 * Design notes:
 *  - The function is pure and deterministic so it is straightforward to unit
 *    test and reason about.
 *  - Rules run in a fixed order. Multi-line private-key blocks are redacted
 *    first so later single-line rules never see their interior. Specific
 *    high-confidence value formats (JWT, connection-string credentials,
 *    vendor key prefixes) run before the broad `KEY=VALUE` rule so the broad
 *    rule only mops up whatever is left.
 *  - Over-redaction is acceptable (safe side); under-redaction is the risk we
 *    optimize against.
 */

/** A single redaction rule: a global regex and the placeholder it inserts. */
interface RedactionRule {
  /** Human-readable label, used only for documentation/debugging. */
  readonly label: string;
  /** Global regex matched against the whole transcript. */
  readonly pattern: RegExp;
  /**
   * Replacement. Either a fixed placeholder string or a replacer function
   * (used when a rule preserves part of the match, e.g. the scheme/host of a
   * connection string while redacting only the embedded credentials).
   */
  readonly replacement: string | ((match: string, ...groups: string[]) => string);
}

/**
 * Ordered redaction rules. Order matters — see the module docstring.
 */
const RULES: readonly RedactionRule[] = [
  // 1. PEM private-key blocks (multi-line). Redact the entire block first so
  //    no later rule matches inside the key material.
  {
    label: "private-key-block",
    pattern:
      /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },

  // 2. JWTs: three base64url segments separated by dots, starting with the
  //    canonical `eyJ` header prefix.
  {
    label: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replacement: "[REDACTED_JWT]",
  },

  // 3. Connection-string credentials: redact only the `user:pass@` userinfo,
  //    preserving the scheme and host so the surrounding context stays
  //    readable for extraction.
  {
    label: "connection-string-credentials",
    pattern: /\b([a-z][a-z0-9+.-]*):\/\/([^\s:/@]+):([^\s:/@]+)@/gi,
    replacement: (_match: string, scheme: string): string =>
      `${scheme}://[REDACTED_CREDENTIALS]@`,
  },

  // 4. OpenAI / Anthropic style keys (`sk-...`, `sk-ant-...`).
  {
    label: "sk-key",
    pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g,
    replacement: "[REDACTED_API_KEY]",
  },

  // 5. AWS access key IDs.
  {
    label: "aws-access-key-id",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: "[REDACTED_API_KEY]",
  },

  // 6. GitHub tokens (PAT, OAuth, user-to-server, server-to-server, refresh).
  {
    label: "github-token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/g,
    replacement: "[REDACTED_API_KEY]",
  },

  // 7. Broad `KEY = VALUE` / `KEY: VALUE` assignments where the key name looks
  //    sensitive. Runs last so it only catches secrets the specific rules
  //    above did not already redact (e.g. `PASSWORD=hunter2`). The value may
  //    be quoted (single/double) or a run of non-whitespace.
  {
    label: "sensitive-assignment",
    pattern:
      /\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|APIKEY|API_KEY|ACCESS_KEY|SECRET_KEY|PRIVATE_KEY|AUTH_TOKEN|CREDENTIAL|CREDENTIALS)[A-Za-z0-9_]*)\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s]+)/gi,
    replacement: (_match: string, key: string): string => `${key}=[REDACTED]`,
  },
];

/**
 * Redact best-effort secrets from `transcript`, returning a cleaned copy.
 *
 * Non-string input is coerced to an empty string so the function never throws;
 * callers validate non-emptiness separately (`isValidTranscript`).
 *
 * @param transcript Raw session transcript.
 * @returns The transcript with detected secrets replaced by `[REDACTED_*]`
 *          placeholders. Text with no detected secrets is returned unchanged.
 */
export function sanitizeTranscript(transcript: string): string {
  if (typeof transcript !== "string" || transcript.length === 0) return "";

  let out = transcript;
  for (const rule of RULES) {
    out =
      typeof rule.replacement === "string"
        ? out.replace(rule.pattern, rule.replacement)
        : out.replace(rule.pattern, rule.replacement);
  }
  return out;
}
