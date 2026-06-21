/**
 * Unit tests for the reusable at-rest secret crypto.
 *
 * These pin the round-trip contract (encrypt → decrypt recovers the exact
 * plaintext) and the authenticated-encryption contract (any tampering yields
 * `null`, never partial or forged plaintext).
 */

import { beforeAll, describe, expect, it } from "vitest";

// `crypto.ts` opens with `import "server-only"`, whose guard package throws
// outside a React Server Component bundler. Stub it to an empty module so the
// node test environment can import the module under test.
import { vi } from "vitest";
vi.mock("server-only", () => ({}));

// A deterministic 64-hex test key so the derived AES key is stable.
beforeAll(() => {
  process.env["SESSION_SECRET"] = "a".repeat(64);
});

import { decryptSecret, encryptSecret } from "./crypto.js";

describe("encryptSecret / decryptSecret", () => {
  it("round-trips an arbitrary secret", () => {
    const secret = "f".repeat(64);
    const encrypted = encryptSecret(secret);
    expect(encrypted).not.toBe(secret);
    expect(decryptSecret(encrypted)).toBe(secret);
  });

  it("round-trips unicode secrets", () => {
    expect(decryptSecret(encryptSecret("héllo 🌊 walrus"))).toBe("héllo 🌊 walrus");
  });

  it("produces a different ciphertext each call (random IV)", () => {
    const a = encryptSecret("same-input");
    const b = encryptSecret("same-input");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same-input");
    expect(decryptSecret(b)).toBe("same-input");
  });

  it("returns null for a tampered ciphertext", () => {
    const encrypted = encryptSecret("secret-value");
    const parts = encrypted.split(":");
    // Flip a character in the ciphertext segment.
    const ciphertext = parts[2] ?? "";
    const flipped =
      (ciphertext[0] === "A" ? "B" : "A") + ciphertext.slice(1);
    const tampered = [parts[0], parts[1], flipped].join(":");
    expect(decryptSecret(tampered)).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(decryptSecret("")).toBeNull();
    expect(decryptSecret("not-a-valid-format")).toBeNull();
    expect(decryptSecret("only:two")).toBeNull();
    expect(decryptSecret("a:b:c:d")).toBeNull();
  });
});
