/**
 * Normalizer for the `RELAYER_URL` environment value.
 *
 * The MemWal SDK builds every request URL as `${serverUrl}${path}` (e.g.
 * `${serverUrl}/health`, `${serverUrl}/api/recall`). That string concatenation
 * has two sharp edges when the configured value isn't pristine:
 *
 *   - A **trailing slash** (`https://host/`) yields `https://host//health`,
 *     which the relayer answers with HTTP 404 — the SDK then throws
 *     "Health check failed: 404" and the dashboard shows a misleading
 *     "Connection problem".
 *   - **Stray whitespace / newlines** (`https://host\n`) make `fetch` throw
 *     "Failed to parse URL", which also surfaces as a connectivity error.
 *
 * Operators routinely paste values with a trailing slash or newline into
 * hosting dashboards (Vercel, etc.), so we defensively clean the value before
 * handing it to the SDK. This is purely cosmetic normalization — it never
 * invents a scheme or host, so a genuinely malformed value (e.g. missing
 * `https://`) still fails loudly rather than being silently "fixed".
 */

/**
 * Trim surrounding whitespace and strip trailing slashes from a `RELAYER_URL`
 * value.
 *
 * @returns the cleaned base URL, or `null` when the input is missing, not a
 *   string, or empty after trimming — so callers can raise their own
 *   configuration error with a message specific to their call site.
 */
export function normalizeRelayerUrl(
  raw: string | undefined | null,
): string | null {
  if (typeof raw !== "string") return null;
  // Trim first (handles copy-paste newlines/spaces), then drop any number of
  // trailing slashes so `${base}/path` never produces a doubled slash.
  const cleaned = raw.trim().replace(/\/+$/, "");
  return cleaned.length > 0 ? cleaned : null;
}
