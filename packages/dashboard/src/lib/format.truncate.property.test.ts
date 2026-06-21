// Feature: uberwal, Property 9: Session truncation is a length-bounded prefix with no data loss
//
// Validates: Requirements 10.1, 10.2
//
// For any input `text` and any session-truncation budget `max >= 0`,
// `truncateSession(text, max)` must satisfy four invariants:
//
//   (a) `display` is always a prefix of the original `text` —
//       i.e. `text.startsWith(display)` (the visible preview never invents
//       or reorders characters).
//   (b) `display.length <= max` — the rendered preview never exceeds the
//       configured budget (Req 10.1: 300-character cap by default).
//   (c) When `text.length <= max`, `display === text` and `isTruncated`
//       is `false` — short summaries are shown verbatim, untouched.
//   (d) `full === text` and the original is fully recoverable from
//       `display + text.slice(display.length)` — the full summary is
//       preserved so the expand control reveals the complete text without
//       a re-fetch (Req 10.2).
//
// Together these invariants say truncation is a length-bounded prefix
// with no data loss.

import { describe, test } from "vitest";
import * as fc from "fast-check";

import {
  DEFAULT_SESSION_TRUNCATION,
  truncateSession,
} from "./format.js";

const NUM_RUNS = 100;

describe("Property 9: Session truncation is a length-bounded prefix with no data loss", () => {
  test("default max=300: display is a length-bounded prefix and full preserves the original", () => {
    fc.assert(
      // Generate strings spanning short, near-boundary, and well-past-boundary
      // lengths so we exercise both the "no truncation needed" and the
      // "must truncate" branches of `truncateSession`.
      fc.property(
        fc.string({ minLength: 0, maxLength: 1000 }),
        (text) => {
          const { display, isTruncated, full } = truncateSession(text);
          const max = DEFAULT_SESSION_TRUNCATION;

          // (a) display is a prefix of the original text.
          if (!text.startsWith(display)) return false;

          // (b) display length is at most the configured budget.
          if (display.length > max) return false;

          // (c) when the original fits, show it verbatim and don't flag truncation.
          if (text.length <= max) {
            if (display !== text) return false;
            if (isTruncated !== false) return false;
          } else {
            // Otherwise the preview must be exactly `max` characters and
            // truncation must be reported so the UI can show the expand control.
            if (display.length !== max) return false;
            if (isTruncated !== true) return false;
          }

          // (d) full preserves the original text byte-for-byte, and the
          //     remainder beyond `display` is fully recoverable from `full`,
          //     so the expand control reveals the complete summary without
          //     any data loss (Req 10.2).
          if (full !== text) return false;
          const reconstructed = display + full.slice(display.length);
          if (reconstructed !== text) return false;

          return true;
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  test("custom max: invariants hold for any non-negative budget", () => {
    fc.assert(
      // Vary both the text and the truncation budget to verify the
      // invariants are not specific to the 300-character default.
      fc.property(
        fc.string({ minLength: 0, maxLength: 500 }),
        fc.integer({ min: 0, max: 500 }),
        (text, max) => {
          const { display, isTruncated, full } = truncateSession(text, max);

          if (!text.startsWith(display)) return false;
          if (display.length > max) return false;

          if (text.length <= max) {
            if (display !== text) return false;
            if (isTruncated !== false) return false;
          } else {
            if (display.length !== max) return false;
            if (isTruncated !== true) return false;
          }

          if (full !== text) return false;

          return true;
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
