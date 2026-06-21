// Unit tests for `generate_share_info` instructions content and the
// missing-delegate-key short-circuit.
//
// Validates: Requirements 6.3, 6.4
//
// Scope (task 11.3):
//   - Requirement 6.3: the instructions text describes both supported
//     recipient flows — (a) signing into the Uberwal dashboard with the
//     supplied credentials and (b) generating a separate delegate key via
//     the MemWal staging dashboard — and references the staging dashboard
//     URL exposed by the module.
//   - Requirement 6.4: when no delegate key is configured (empty or
//     whitespace-only), the tool returns an `isError` result whose message
//     explains a delegate key must be set up before sharing.
//
// The success-path sanity check (publicKey / accountId / relayerUrl
// present in `structuredContent`) is intentionally lightweight: Property
// 8 (task 11.2, in a parallel test file) carries the heavier guarantee
// that the private key never leaks. Here we just confirm the success
// payload is wired correctly so the missing-key error path is being
// compared against a known-good baseline.

import { describe, it, expect } from "vitest";

import type { MemWalClient } from "@uberwal/shared";

import type { Config } from "../config.js";
import type { Extractor } from "../extraction/extractor.js";

import {
  MEMWAL_STAGING_DASHBOARD_URL,
  generateShareInfoHandler,
} from "./generate-share-info.js";
import type { ToolDeps } from "./register.js";

/**
 * Stub MemWal client that only implements `getPublicKeyHex`. The handler
 * does not touch any other client method (no health gate, no recall, no
 * remember — `generate_share_info` is metadata-only), so leaving the rest
 * of the surface absent and casting through `unknown` keeps the stub
 * minimal while still satisfying TypeScript.
 */
function createMemWalStub(publicKeyHex: string): MemWalClient {
  const stub = {
    async getPublicKeyHex(): Promise<string> {
      return publicKeyHex;
    },
  };
  return stub as unknown as MemWalClient;
}

/** A 64-char hex stub public key used across the success-path assertions. */
const STUB_PUBLIC_KEY =
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

/** Account id format mirrors `isValidAccountId` (0x + 64 hex). */
const STUB_ACCOUNT_ID =
  "0x1111111111111111111111111111111111111111111111111111111111111111";

/** Any absolute URL is fine — the handler treats it as opaque. */
const STUB_RELAYER_URL = "https://relayer-staging.memory.walrus.xyz";

/** Uberwal dashboard URL the recipient logs into (distinct from MemWal). */
const STUB_DASHBOARD_URL = "https://devmemory.example/app";

/**
 * Build a `Config`-shaped object. `delegateKey` is the only field this
 * tool branches on, so the other fields can hold any well-formed value
 * for the assertions in this file.
 */
function makeConfig(delegateKey: string): Config {
  return {
    delegateKey,
    accountId: STUB_ACCOUNT_ID,
    relayerUrl: STUB_RELAYER_URL,
    openaiApiKey: "test-openai-key",
    openaiBaseUrl: undefined,
    openaiModel: "openai.gpt-oss-120b",
    dashboardUrl: STUB_DASHBOARD_URL,
  };
}

/**
 * Build a `ToolDeps` value for the handler. Only `memwal` and `config` are
 * read by `generate_share_info`; `extractor` is unused, so a placeholder
 * cast keeps the test from coupling to unrelated module shapes.
 */
function makeDeps(delegateKey: string, publicKey = STUB_PUBLIC_KEY): ToolDeps {
  return {
    memwal: createMemWalStub(publicKey),
    extractor: undefined as unknown as Extractor,
    config: makeConfig(delegateKey),
  };
}

/**
 * Pull the first text-content payload from a `CallToolResult`. The handler
 * always emits a single text block (either the JSON-stringified success
 * payload or the human-readable error message), so reading the first
 * block is sufficient for both branches.
 */
function firstTextContent(result: {
  content?: ReadonlyArray<{ type: string; text?: string }>;
}): string | undefined {
  const head = result.content?.[0];
  if (head && head.type === "text") return head.text;
  return undefined;
}

describe("generate_share_info — instructions content (Requirement 6.3)", () => {
  it("describes both recipient flows and references the MemWal staging dashboard URL", async () => {
    const result = await generateShareInfoHandler(makeDeps(STUB_PUBLIC_KEY));

    // Sanity: success path, not an error.
    expect(result.isError).not.toBe(true);

    const structured = result.structuredContent as
      | Record<string, unknown>
      | undefined;
    expect(structured).toBeDefined();

    const instructions = structured?.["instructions"];
    expect(typeof instructions).toBe("string");
    const text = String(instructions);

    // Flow (a): logging into the Uberwal dashboard with the supplied
    // credentials. The instructions must mention both halves of the
    // dashboard credential pair so a recipient knows what they need.
    expect(text).toMatch(/dashboard/i);
    expect(text).toMatch(/log/i);
    expect(text).toMatch(/delegate key/i);
    expect(text).toMatch(/accountId/);

    // Flow (b): generating a separate delegate key via the MemWal staging
    // dashboard. Reference the exported constant directly so the test
    // breaks loudly if the URL is ever moved or rebranded.
    expect(text).toContain(MEMWAL_STAGING_DASHBOARD_URL);
    expect(text).toMatch(/MemWal/);
    expect(text).toMatch(/generate/i);
  });
});

describe("generate_share_info — missing delegate key (Requirement 6.4)", () => {
  it("returns isError with a configuration message when delegateKey is empty", async () => {
    const result = await generateShareInfoHandler(makeDeps(""));

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();

    const message = firstTextContent(result);
    expect(typeof message).toBe("string");
    expect(message).toMatch(/delegate key/i);
    expect(message).toMatch(/configured|configure|set up/i);
  });

  it("returns isError when delegateKey is whitespace-only (defensive check)", async () => {
    // The implementation rejects any value whose `trim()` is empty so a
    // misconfigured environment (e.g. `DELEGATE_KEY="   "`) cannot slip
    // past `loadConfig` and reach the SDK.
    const result = await generateShareInfoHandler(makeDeps("   \t\n  "));

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();

    const message = firstTextContent(result);
    expect(typeof message).toBe("string");
    expect(message).toMatch(/delegate key/i);
  });
});

describe("generate_share_info — success payload sanity check", () => {
  it("returns publicKey, accountId, and relayerUrl in structuredContent", async () => {
    const result = await generateShareInfoHandler(
      // A 64-char hex delegate key — its exact value is irrelevant here,
      // because the public key is supplied by the stub. We just need the
      // presence check on `delegateKey` to pass.
      makeDeps(
        "1111111111111111111111111111111111111111111111111111111111111111",
      ),
    );

    expect(result.isError).not.toBe(true);

    const structured = result.structuredContent as
      | Record<string, unknown>
      | undefined;
    expect(structured).toBeDefined();
    expect(structured?.["publicKey"]).toBe(STUB_PUBLIC_KEY);
    expect(structured?.["accountId"]).toBe(STUB_ACCOUNT_ID);
    expect(structured?.["relayerUrl"]).toBe(STUB_RELAYER_URL);
    expect(typeof structured?.["instructions"]).toBe("string");
  });
});
