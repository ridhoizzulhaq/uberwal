// @vitest-environment jsdom

/**
 * Component tests for `<SkillCard />`.
 *
 * The Skills tab surfaces each recalled `skills` entry as a card in which
 * the fact text appears prominently and the distance score is rendered as
 * a secondary numeric indicator (Req 8.2). The shared `formatDistance`
 * helper renders the distance to exactly two decimal places (Req 12.3) so
 * the same precision is used across every dashboard tab.
 *
 * Validates: Requirements 8.2
 *
 * Notes on test mechanics:
 *  - `cleanup()` runs after each test to unmount React trees so the next
 *    test starts from a fresh DOM.
 *  - Distance values are chosen so that `toFixed(2)` truncates a third
 *    decimal (`0.317 -> "0.32"`), proving rendering goes through
 *    `formatDistance` rather than `String(value)`.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import type { RecallEntry } from "@uberwal/shared";

import { SkillCard } from "./SkillCard";

describe("<SkillCard />", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the entry text prominently (Req 8.2)", () => {
    const entry: RecallEntry = {
      blob_id: "blob-1",
      text: "Implemented JWT auth middleware in Express (TypeScript)",
      distance: 0.32,
    };

    render(<SkillCard entry={entry} />);

    // The entry text appears verbatim in the rendered card.
    expect(screen.getByText(entry.text)).toBeTruthy();
  });

  it("renders the distance score formatted to two decimals via formatDistance (Req 8.2)", () => {
    // 0.317 has a third decimal — `toFixed(2)` rounds it to "0.32", which
    // proves the component delegates to `formatDistance` rather than
    // stringifying the raw float.
    const entry: RecallEntry = {
      blob_id: "blob-2",
      text: "Wrote integration tests with Vitest and fast-check",
      distance: 0.317,
    };

    render(<SkillCard entry={entry} />);

    expect(screen.getByText("0.32")).toBeTruthy();
    // The raw float must not leak into the DOM.
    expect(screen.queryByText("0.317")).toBeNull();
  });

  it("formats a distance with no fractional part to two decimals", () => {
    const entry: RecallEntry = {
      blob_id: "blob-3",
      text: "Shipped a Next.js App Router migration",
      distance: 0.5,
    };

    render(<SkillCard entry={entry} />);

    expect(screen.getByText("0.50")).toBeTruthy();
  });
});
