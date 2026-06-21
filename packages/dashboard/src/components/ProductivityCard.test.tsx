// @vitest-environment jsdom

/**
 * Component tests for `<ProductivityCard />`.
 *
 * Mirrors the contract verified for {@link SkillCard}: the entry text is
 * rendered prominently and the distance score is rendered as a secondary
 * numeric indicator formatted to two decimals via `formatDistance` (Reqs
 * 9.1, 12.3).
 *
 * Validates: Requirements 9.1
 *
 * Notes on test mechanics:
 *  - `cleanup()` runs after each test to unmount React trees so the next
 *    test starts from a fresh DOM.
 *  - A distance with a third decimal (`0.487`) is used to confirm
 *    rendering goes through `formatDistance` rather than `String(value)`.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import type { RecallEntry } from "@uberwal/shared";

import { ProductivityCard } from "./ProductivityCard";

describe("<ProductivityCard />", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the entry text prominently (Req 9.1)", () => {
    const entry: RecallEntry = {
      blob_id: "blob-1",
      text: "Closed 3 PRs and resolved 5 review comments in one session",
      distance: 0.21,
    };

    render(<ProductivityCard entry={entry} />);

    expect(screen.getByText(entry.text)).toBeTruthy();
  });

  it("renders the distance score formatted to two decimals via formatDistance (Req 9.1)", () => {
    // `0.487` rounds to `"0.49"` via `toFixed(2)`, distinguishing the
    // formatted output from the raw float.
    const entry: RecallEntry = {
      blob_id: "blob-2",
      text: "Maintained a 4-day commit streak across two repositories",
      distance: 0.487,
    };

    render(<ProductivityCard entry={entry} />);

    expect(screen.getByText("0.49")).toBeTruthy();
    expect(screen.queryByText("0.487")).toBeNull();
  });

  it("formats an integer-valued distance to two decimals", () => {
    const entry: RecallEntry = {
      blob_id: "blob-3",
      text: "Completed all tickets in the sprint backlog",
      distance: 0,
    };

    render(<ProductivityCard entry={entry} />);

    expect(screen.getByText("0.00")).toBeTruthy();
  });
});
