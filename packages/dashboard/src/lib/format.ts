/**
 * Pure display helpers used by the dashboard's tab components.
 *
 * These helpers are intentionally side-effect free and client-safe so the
 * Sessions, Skills, Productivity, and Reports views can import them from
 * either server or client components.
 *
 * Validates: Requirements 10.1, 10.2, 12.3
 */

/** Default maximum length for a session summary preview, in characters. */
export const DEFAULT_SESSION_TRUNCATION = 300;

/**
 * Result of {@link truncateSession}.
 *
 * - `display` is the prefix shown by default in the Sessions tab.
 * - `isTruncated` is `true` iff `display` is shorter than `full`.
 * - `full` is always the original text, preserved for the expand control
 *   so no characters are lost on truncation (Req 10.2).
 */
export interface TruncatedSession {
  display: string;
  isTruncated: boolean;
  full: string;
}

/**
 * Truncates a session summary to at most `max` characters.
 *
 * The returned `display` is a prefix of `text` whose length is at most
 * `max`; when `text.length <= max` the input is returned unchanged and
 * `isTruncated` is `false`. The original text is always preserved in
 * `full` so the UI's expand control can reveal it without a re-fetch
 * (Req 10.1, 10.2).
 *
 * @param text - The session summary text to display.
 * @param max  - Maximum visible length. Defaults to 300 (Req 10.1).
 */
export function truncateSession(
  text: string,
  max: number = DEFAULT_SESSION_TRUNCATION,
): TruncatedSession {
  if (text.length <= max) {
    return { display: text, isTruncated: false, full: text };
  }
  return { display: text.slice(0, max), isTruncated: true, full: text };
}

/**
 * Formats a distance score to exactly two decimal places.
 *
 * Distances coming from MemWal recall are floats roughly in `[0, 1]`;
 * the dashboard displays them as a fixed-precision secondary indicator
 * next to skill, productivity, session, and report entries (Req 12.3).
 *
 * For any input in `[0, 1]` the output matches the pattern
 * `^\d\.\d{2}$` as required by Property 10.
 */
export function formatDistance(value: number): string {
  return value.toFixed(2);
}

/** A pastel Badge variant paired with a short relevance label. */
export interface RelevanceBand {
  /** Short human label: "High", "Mid", or "Low". */
  label: string;
  /** Badge pastel variant: green for high, yellow for mid, neutral for low. */
  variant: "green" | "yellow" | "neutral";
}

/**
 * Maps a recall `distance` to a relevance band for display.
 *
 * Smaller distances mean a closer (more relevant) match:
 *  - `< 0.35` → High (green)
 *  - `< 0.6`  → Mid  (yellow)
 *  - else     → Low  (neutral)
 *
 * This is a pure presentation helper; the underlying numeric distance is
 * still shown verbatim via {@link formatDistance}.
 */
export function relevanceBand(value: number): RelevanceBand {
  const distance = typeof value === "number" ? value : 0.5;
  if (distance < 0.35) return { label: "High", variant: "green" };
  if (distance < 0.6) return { label: "Mid", variant: "yellow" };
  return { label: "Low", variant: "neutral" };
}
