/**
 * Unit tests for the local, best-effort transcript sanitizer.
 *
 * These confirm each redaction rule fires on representative secret formats,
 * that benign text is left untouched, and that the rule ordering keeps
 * multi-line private-key blocks intact (no interior re-matching).
 */

import { describe, expect, it } from "vitest";

import { sanitizeTranscript } from "./sanitize";

describe("sanitizeTranscript", () => {
  it("redacts OpenAI/Anthropic-style sk- keys", () => {
    const out = sanitizeTranscript(
      "here is the key sk-abcdefghijklmnopqrstuvwxyz012345 ok",
    );
    expect(out).toContain("[REDACTED_API_KEY]");
    expect(out).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
  });

  it("redacts sk-ant- prefixed keys", () => {
    const out = sanitizeTranscript(
      "ANTHROPIC=sk-ant-api03-AAAA1111BBBB2222CCCC3333DDDD",
    );
    expect(out).not.toContain("sk-ant-api03-AAAA1111BBBB2222CCCC3333DDDD");
    expect(out).toMatch(/REDACTED/);
  });

  it("redacts AWS access key IDs", () => {
    const out = sanitizeTranscript("AKIAIOSFODNN7EXAMPLE is the access key");
    expect(out).toContain("[REDACTED_API_KEY]");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("redacts GitHub tokens", () => {
    const token = `ghp_${"a".repeat(36)}`;
    // Use a non-assignment context so only the GitHub-token rule fires (a
    // `token:` prefix would additionally trip the KEY=VALUE rule and rewrite
    // the placeholder to `[REDACTED]` — also safe, but harder to assert on).
    const out = sanitizeTranscript(`run gh auth with ${token} please`);
    expect(out).toContain("[REDACTED_API_KEY]");
    expect(out).not.toContain(token);
  });

  it("redacts JWTs", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const out = sanitizeTranscript(`Authorization: Bearer ${jwt}`);
    expect(out).toContain("[REDACTED_JWT]");
    expect(out).not.toContain(jwt);
  });

  it("redacts connection-string credentials while preserving scheme and host", () => {
    const out = sanitizeTranscript(
      "DB at postgres://admin:s3cr3tpw@db.internal:5432/app",
    );
    expect(out).toContain("postgres://[REDACTED_CREDENTIALS]@db.internal:5432/app");
    expect(out).not.toContain("s3cr3tpw");
    expect(out).not.toContain("admin:s3cr3tpw");
  });

  it("redacts mongodb+srv connection-string credentials", () => {
    const out = sanitizeTranscript(
      "mongodb+srv://user:p%40ss@cluster0.mongodb.net/test",
    );
    expect(out).toContain("mongodb+srv://[REDACTED_CREDENTIALS]@");
    expect(out).not.toContain("user:p%40ss");
  });

  it("redacts sensitive KEY=VALUE assignments", () => {
    const out = sanitizeTranscript(
      [
        "PASSWORD=hunter2",
        'DB_SECRET="top-secret-value"',
        "AUTH_TOKEN: abc123def456",
      ].join("\n"),
    );
    expect(out).toContain("PASSWORD=[REDACTED]");
    expect(out).toContain("DB_SECRET=[REDACTED]");
    expect(out).toContain("AUTH_TOKEN=[REDACTED]");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("top-secret-value");
    expect(out).not.toContain("abc123def456");
  });

  it("redacts an entire PEM private-key block as one unit", () => {
    const block = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAA",
      "AAEAAAAAwEAAAdzc2gtcn2EAAAADAQABAAABAQDZ...redactme...",
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");
    const out = sanitizeTranscript(`my key:\n${block}\ndone`);
    expect(out).toContain("[REDACTED_PRIVATE_KEY]");
    expect(out).not.toContain("redactme");
    expect(out).not.toContain("BEGIN OPENSSH PRIVATE KEY");
  });

  it("leaves benign transcript text unchanged", () => {
    const benign =
      "User: implement a debounce hook\nAssistant: here is a useDebounce example with setTimeout";
    expect(sanitizeTranscript(benign)).toBe(benign);
  });

  it("returns an empty string for empty/non-string input", () => {
    expect(sanitizeTranscript("")).toBe("");
    expect(sanitizeTranscript(undefined as unknown as string)).toBe("");
  });
});
