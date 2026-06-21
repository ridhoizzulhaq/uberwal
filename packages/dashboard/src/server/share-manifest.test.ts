/**
 * Unit tests for the pure share-manifest model.
 *
 * `namespacesForMode` is the single source of truth for what each share mode
 * exposes, so these tests pin the exact sets and the key invariant that `full`
 * is a strict superset of `summary` (it adds `transcripts`).
 */

import { describe, expect, it } from "vitest";

import { namespacesForMode } from "./share-manifest.js";

describe("namespacesForMode", () => {
  it("summary shares the four dashboard namespaces, excluding transcripts", () => {
    const ns = namespacesForMode("summary");
    expect(ns).toEqual(["sessions", "skills", "productivity", "reports"]);
    expect(ns).not.toContain("transcripts");
  });

  it("full shares the summary namespaces plus transcripts", () => {
    const ns = namespacesForMode("full");
    expect(ns).toEqual([
      "sessions",
      "skills",
      "productivity",
      "reports",
      "transcripts",
    ]);
    expect(ns).toContain("transcripts");
  });

  it("full is a strict superset of summary", () => {
    const summary = namespacesForMode("summary");
    const full = namespacesForMode("full");
    for (const ns of summary) {
      expect(full).toContain(ns);
    }
    expect(full.length).toBe(summary.length + 1);
  });

  it("returns a fresh array each call (no shared mutable constant)", () => {
    const a = namespacesForMode("summary");
    const b = namespacesForMode("summary");
    expect(a).not.toBe(b);
    a.push("transcripts");
    expect(namespacesForMode("summary")).not.toContain("transcripts");
  });
});
