// Feature: uberwal, Property 8: Share info never leaks the delegate private key
// (tasks.md numbers this as Property 8 in the implementation plan; design.md
//  uses a different numbering scheme. Same property either way: the delegate
//  private key must never appear in the `generate_share_info` output.)
//
// Validates: Requirements 6.1, 6.2
//
// `generateShareInfoHandler`'s contract: for any configured delegate
// private key, the tool's response (taken in full — both the human-readable
// `text` content blocks and the `structuredContent` payload) must
//
//   1. NOT contain the delegate private key as a substring anywhere
//      (Requirement 6.2 — the private key never leaves the server), and
//   2. DO contain the derived public key hex, the configured account id,
//      and the relayer URL (Requirement 6.1 — these are exactly the
//      metadata recipients need to use the share info).
//
// The handler is wired against a stub `MemWalClient` whose
// `getPublicKeyHex()` returns a fake public key. Crucially the generator
// guarantees the fake public key differs from the delegate private key,
// so a successful "delegateKey not in output" assertion can't be
// vacuously satisfied by the public key happening to equal the private
// key (which would defeat the leakage check).

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { MemWalClient } from "@uberwal/shared";

import type { Config } from "../config.js";
import type { Extractor } from "../extraction/extractor.js";

import { generateShareInfoHandler } from "./generate-share-info.js";
import type { ToolDeps } from "./register.js";

/** Lowercase hex alphabet used to generate 64-char hex credentials. */
const HEX_LOWER = "0123456789abcdef";

/** A single lowercase hex character. */
const hexLowerChar: fc.Arbitrary<string> = fc.constantFrom(
  ...HEX_LOWER.split(""),
);

/** Build a hex string of exactly `n` lowercase hex characters. */
const hexStringOfLength = (n: number): fc.Arbitrary<string> =>
  fc
    .array(hexLowerChar, { minLength: n, maxLength: n })
    .map((chars) => chars.join(""));

/** A 64-character lowercase hex string (used for both delegate and public keys). */
const hex64: fc.Arbitrary<string> = hexStringOfLength(64);

/** A `0x`-prefixed 64-character hex string (Sui account object id format). */
const accountIdGen: fc.Arbitrary<string> = hex64.map((s) => `0x${s}`);

/**
 * Plausible relayer URL generator. `fc.webUrl()` would over-fit on URL
 * shapes that have nothing to do with the assertions; we just need a
 * varied non-empty string that looks like a URL so the "output contains
 * relayerUrl" check exercises real URL characters (slashes, dots, ports).
 */
const relayerUrlGen: fc.Arbitrary<string> = fc.webUrl({
  validSchemes: ["https", "http"],
  withQueryParameters: false,
  withFragments: false,
});

/**
 * Joint generator for delegate key + public key that guarantees the two
 * differ. If they happened to coincide, the "output does not contain
 * delegateKey" assertion would be trivially satisfied by the public key
 * appearing in the payload, masking a real leak.
 */
const delegateAndPublicKey: fc.Arbitrary<{
  delegateKey: string;
  publicKey: string;
}> = fc
  .tuple(hex64, hex64)
  .filter(([dk, pk]) => dk !== pk)
  .map(([delegateKey, publicKey]) => ({ delegateKey, publicKey }));

/**
 * Build a `MemWalClient`-shaped stub exposing only `getPublicKeyHex()`.
 *
 * `generateShareInfoHandler` does not contact the relayer (no health
 * gate, no recall, no remember), so the stub deliberately implements
 * nothing else. Any future regression that starts calling extra SDK
 * methods through `deps.memwal` will surface as a clear "not a
 * function" failure rather than silently passing.
 */
function createMemWalStub(publicKey: string): MemWalClient {
  const stub = {
    async getPublicKeyHex(): Promise<string> {
      return publicKey;
    },
  };
  // Cast through `unknown` to satisfy the wrapper's nominal class type
  // without instantiating a real SDK (mirrors the patterns used in
  // `generate-report.gating.property.test.ts` and `startup.test.ts`).
  return stub as unknown as MemWalClient;
}

/**
 * Extractor stub whose methods would throw if called. `generate_share_info`
 * never extracts or summarizes, so any invocation here would indicate a
 * handler regression rather than a legitimate code path.
 */
const unusedExtractor: Extractor = {
  async extractFacts() {
    throw new Error(
      "extractFacts should not be called by generate_share_info — handler regression.",
    );
  },
  async summarizeReport() {
    throw new Error(
      "summarizeReport should not be called by generate_share_info — handler regression.",
    );
  },
};

/**
 * Flatten the handler's full response — both `content[]` text blocks and
 * `structuredContent` — into one searchable string. This is the
 * surface a recipient (or anything downstream) could see, and it is the
 * surface against which the non-leakage and presence assertions must
 * hold.
 *
 * `JSON.stringify` covers the structured object (including the
 * `instructions` text and any future fields), and the text blocks are
 * concatenated as-is so a literal substring match works regardless of
 * how the handler chooses to format its output.
 */
function resultToSearchableString(result: CallToolResult): string {
  const textBlocks = result.content
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .join("\n");
  const structured =
    result.structuredContent === undefined
      ? ""
      : JSON.stringify(result.structuredContent);
  return `${textBlocks}\n${structured}`;
}

describe("Property 8: Share info never leaks the delegate private key", () => {
  it(
    "output omits the delegate private key while exposing public key, accountId, and relayerUrl",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          delegateAndPublicKey,
          accountIdGen,
          relayerUrlGen,
          async ({ delegateKey, publicKey }, accountId, relayerUrl) => {
            // Build a `Config` with the generated values. The Bedrock fields
            // are irrelevant to share info but the type requires them; we use
            // sentinel strings that also double as leak-detection canaries
            // (they must not appear in output either, though that is not the
            // property under test).
            const config: Config = {
              delegateKey,
              accountId,
              relayerUrl,
              openaiApiKey: "test-openai-key",
              openaiBaseUrl: undefined,
              openaiModel: "openai.gpt-oss-120b",
              dashboardUrl: "https://devmemory.example/app",
            };

            const deps: ToolDeps = {
              memwal: createMemWalStub(publicKey),
              extractor: unusedExtractor,
              config,
            };

            const result = await generateShareInfoHandler(deps);

            // The handler should have produced a successful result for
            // any well-configured delegate key. If it ever returns an
            // error here, the inputs above accidentally violated the
            // missing-key precondition (Requirement 6.4) — surface that
            // explicitly so a future generator change does not silently
            // weaken this property.
            expect(result.isError).toBeUndefined();

            const searchable = resultToSearchableString(result);

            // Requirement 6.2: the delegate private key must never appear
            // in the response, in any form, anywhere.
            expect(searchable).not.toContain(delegateKey);

            // Requirement 6.1: the response must carry the public key
            // hex, the account id, and the relayer URL so a recipient
            // can actually use the share info.
            expect(searchable).toContain(publicKey);
            expect(searchable).toContain(accountId);
            expect(searchable).toContain(relayerUrl);
          },
        ),
        // 100+ iterations per the task. 150 covers a wide range of
        // delegate-key / account-id / relayer-URL combinations without
        // ballooning runtime.
        { numRuns: 150 },
      );
    },
  );
});
