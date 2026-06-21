// @vitest-environment jsdom

/**
 * Component tests for `<SessionBlock />`.
 *
 * Sessions are rendered as full-width text blocks. Summaries that fit
 * within the 300-character budget are shown verbatim with no expand
 * control (Req 10.1). Summaries that exceed the budget are truncated and
 * paired with an expand control that reveals the full text without a
 * re-fetch (Req 10.2).
 *
 * Validates: Requirements 10.1, 10.2
 *
 * Notes on test mechanics:
 *  - `cleanup()` runs after each test to unmount React trees so the next
 *    test starts from a fresh DOM.
 *  - The "long" fixture is built as `"a".repeat(350)` so the source
 *    length crosses the 300-character truncation boundary by a known
 *    margin, making the truncated/expanded comparisons unambiguous.
 *  - Truncation is asserted via `textContent` length on the paragraph
 *    rather than on the whole article, since the article also contains
 *    the distance footer.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import type { RecallEntry } from "@uberwal/shared";

import { SessionBlock } from "./SessionBlock";

describe("<SessionBlock />", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders short text in full and shows no expand control (Req 10.1)", () => {
    const entry: RecallEntry = {
      blob_id: "blob-short",
      text: "Brief session summary that fits inside the truncation budget.",
      distance: 0.42,
    };

    render(<SessionBlock entry={entry} />);

    // Full text appears verbatim because it is under 300 characters.
    expect(screen.getByText(entry.text)).toBeTruthy();

    // No expand control is rendered.
    expect(screen.queryByRole("button", { name: /show more/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /show less/i })).toBeNull();
  });

  it("renders long text truncated with an expand control that reveals the full text (Req 10.2)", () => {
    // 350 characters > 300 budget — truncated preview is exactly 300 chars,
    // and the expand control becomes available.
    const longText = "a".repeat(350);
    const entry: RecallEntry = {
      blob_id: "blob-long",
      text: longText,
      distance: 0.55,
    };

    render(<SessionBlock entry={entry} />);

    // The text paragraph is the first <p> in the article. Reading its
    // textContent isolates the summary from the trailing distance line.
    const article = screen.getByRole("article");
    const paragraph = article.querySelector("p") as HTMLParagraphElement;
    expect(paragraph).not.toBeNull();

    // Before expansion: the visible text is the 300-character prefix
    // (followed by a single ellipsis character, which is decorative and
    // marked aria-hidden, so we read length excluding the ellipsis).
    const collapsed = paragraph.textContent ?? "";
    // 300 chars of the prefix + 1 ellipsis (\u2026) = 301; allow either
    // when the implementation chooses not to add the ellipsis.
    expect(collapsed.startsWith("a".repeat(300))).toBe(true);
    expect(collapsed.length).toBeLessThanOrEqual(301);
    expect(collapsed.length).toBeLessThan(longText.length);

    // The expand control is visible.
    const expandButton = screen.getByRole("button", { name: /show more/i });
    expect(expandButton).toBeTruthy();
    expect(expandButton.getAttribute("aria-expanded")).toBe("false");

    // Click to expand — the full text is revealed in place.
    fireEvent.click(expandButton);

    const expanded = paragraph.textContent ?? "";
    expect(expanded).toBe(longText);

    // The control flips to "Show less" with `aria-expanded="true"` so
    // assistive technologies see the state change too.
    const collapseButton = screen.getByRole("button", { name: /show less/i });
    expect(collapseButton.getAttribute("aria-expanded")).toBe("true");
  });
});
