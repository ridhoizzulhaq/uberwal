/**
 * `generate_share_info` MCP tool.
 *
 * Produces the metadata a recipient needs to view the developer's MemWal
 * memories through the Uberwal dashboard, plus instructions for either
 * logging in with the supplied credentials or generating a separate
 * delegate key on the MemWal dashboard.
 *
 * Behaviour, in order:
 *
 *   1. **Delegate-key presence check (Requirement 6.4).** If the
 *      configured delegate key is missing or empty, the tool returns an
 *      error result instructing the operator to configure one before
 *      sharing. In practice {@link loadConfig} already enforces a
 *      well-formed delegate key at startup, but checking again here keeps
 *      this tool safe when invoked through alternative bootstraps (tests,
 *      direct handler calls, future configuration changes).
 *
 *   2. **Public key derivation (Requirement 6.1).** Awaits
 *      {@link MemWalClient.getPublicKeyHex} — the SDK derives the public
 *      key lazily from the delegate private key on first use, so this is
 *      asynchronous.
 *
 *   3. **Structured response (Requirements 6.1, 6.2, 6.3).** Returns the
 *      public key hex, account id, relayer URL, and human-readable
 *      instructions. The delegate **private** key is intentionally never
 *      part of the payload, satisfying Requirement 6.2.
 *
 * No relayer health gate: per the design's Error Handling table this is a
 * metadata-only tool that never touches the relayer, so it does not
 * perform the per-tool 5-second health check that the recall and commit
 * tools rely on.
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 6.4
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ToolDeps } from "./register.js";

/**
 * URL of the MemWal staging dashboard recipients can use to generate their
 * own delegate key. The relayer URL is configured via `RELAYER_URL`, but
 * the user-facing dashboard URL is a separate, fixed surface — exposed as
 * a constant here so the instructions text stays in lockstep with the
 * project's chosen environment (staging) and so tests can assert against
 * it deterministically.
 *
 * Kept exported so unit tests can reference the same constant the
 * production code emits.
 */
export const MEMWAL_STAGING_DASHBOARD_URL = "https://memory.walrus.xyz";

/**
 * Strongly-typed payload shape returned by {@link generateShareInfoHandler}.
 *
 * Mirrored as both a `text` JSON block and a `structuredContent` object on
 * the MCP tool response so clients that prefer structured data can render
 * a card while clients that only support text still see something
 * meaningful.
 *
 * Note: there is no `delegateKey` / `privateKey` field by design
 * (Requirement 6.2). Adding one would be a security regression.
 */
export interface ShareInfo {
  /** 64-char hex Ed25519 delegate public key derived from the configured private key. */
  publicKey: string;
  /** `0x`-prefixed 64-char hex Sui account object id. */
  accountId: string;
  /** Base URL of the MemWal relayer the dashboard should point at. */
  relayerUrl: string;
  /** Base URL of the Uberwal dashboard the recipient logs into. */
  dashboardUrl: string;
  /**
   * Human-readable instructions covering both supported recipient flows:
   * (a) sign into the Uberwal dashboard with the supplied credentials,
   * or (b) generate a separate delegate key via the MemWal staging
   * dashboard for independent access.
   */
  instructions: string;
}

/**
 * Build a successful tool response. Returns the share info as both a
 * pretty-printed JSON `text` block (so MCP clients without structured-output
 * support still see something readable) and as `structuredContent` matching
 * the published output schema.
 */
function successResult(payload: ShareInfo): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload as unknown as { [key: string]: unknown },
  };
}

/**
 * Build an error tool response with `isError: true` so MCP clients surface
 * the failure to the user. Used for the missing-delegate-key short-circuit
 * (Requirement 6.4) and for any unexpected failure deriving the public key.
 */
function errorResult(message: string): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: message,
      },
    ],
    isError: true,
  };
}

/**
 * Compose the instructions text shown to recipients.
 *
 * Two flows are described, in order:
 *
 *   1. **Login with the supplied credentials.** The recipient needs the
 *      account id (already in this payload) and a delegate key — typically
 *      *their own* generated separately. The Uberwal dashboard accepts
 *      both a delegate key and an account id at login (Requirement 7.1).
 *
 *   2. **Generate a separate delegate key.** The recipient visits the
 *      MemWal staging dashboard and creates their own delegate key tied
 *      to the same account id, which they then use to log into the
 *      Uberwal dashboard.
 *
 * The text is exported via {@link generateShareInfoHandler}'s payload so
 * the dashboard can render it directly without re-deriving wording. It is
 * intentionally framed in plain prose rather than markdown to keep all
 * MCP clients (including text-only ones) rendering a useful message.
 */
function buildInstructions(dashboardUrl: string): string {
  return [
    "How to use these credentials:",
    "",
    "1. Log into the Uberwal dashboard.",
    `   - Open the Uberwal dashboard at ${dashboardUrl}`,
    "   - Use the accountId from this share info plus your OWN delegate key.",
    "   - Both the delegate key (64-char hex, no 0x prefix) and the accountId",
    "     (0x-prefixed 64-char hex) are required at the dashboard login page.",
    "",
    "2. If you do not have a delegate key yet, generate one for this account.",
    `   - Visit the MemWal dashboard at ${MEMWAL_STAGING_DASHBOARD_URL}`,
    "     and follow its delegate-key creation flow.",
    "   - The MemWal dashboard issues a separate delegate key tied to the same",
    "     accountId; use that key — never the original developer's private key —",
    "     when signing into the Uberwal dashboard.",
    "",
    "3. Point the dashboard at the relayer URL above when prompted.",
    "",
    "Security note: the delegate private key behind the publicKey above is NOT",
    "part of this payload by design. Each recipient must use their own delegate",
    "key, so the developer's private key never leaves the MCP server.",
  ].join("\n");
}

/**
 * Execute the `generate_share_info` tool.
 *
 * Exported separately from the registration helper so unit and property
 * tests can call the handler directly with a stub {@link ToolDeps} without
 * going through the MCP transport layer.
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 6.4
 */
export async function generateShareInfoHandler(
  deps: ToolDeps,
): Promise<CallToolResult> {
  // 1. Defensive delegate-key presence check (Requirement 6.4).
  //    `loadConfig` already enforces a well-formed delegate key at startup,
  //    but checking the runtime value again here keeps the tool safe when
  //    invoked through alternative bootstraps (tests, direct handler calls,
  //    future configuration paths). We treat both an empty string and
  //    whitespace-only value as "not configured".
  const delegateKey = deps.config.delegateKey;
  if (typeof delegateKey !== "string" || delegateKey.trim().length === 0) {
    return errorResult(
      "A delegate key must be configured before sharing. Set the DELEGATE_KEY " +
        "environment variable to a 64-character hex Ed25519 private key and restart " +
        "the MCP server, then retry generate_share_info.",
    );
  }

  // 2. Derive the delegate public key (Requirement 6.1). The SDK computes
  //    this lazily from the configured private key, which is why
  //    `getPublicKeyHex` is asynchronous despite the design document's
  //    earlier draft suggesting otherwise. Any failure surfaces as an
  //    error result rather than crashing the tool — the most likely
  //    cause is a malformed delegate key, which we already validated, but
  //    other SDK-level issues are still possible.
  let publicKey: string;
  try {
    publicKey = await deps.memwal.getPublicKeyHex();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return errorResult(`Failed to derive the delegate public key: ${reason}`);
  }

  // 3. Build the share-info payload. The delegate private key is
  //    intentionally absent (Requirement 6.2); only the public key,
  //    account id, relayer URL, and instructions are exposed.
  const payload: ShareInfo = {
    publicKey,
    accountId: deps.config.accountId,
    relayerUrl: deps.config.relayerUrl,
    dashboardUrl: deps.config.dashboardUrl,
    instructions: buildInstructions(deps.config.dashboardUrl),
  };

  return successResult(payload);
}

/**
 * Register `generate_share_info` against the supplied MCP server.
 *
 * Called from `registerTools` in `register.ts`. Kept as its own exported
 * helper so the central registration file stays a flat list of tool wires
 * and tests can register the tool against a stub server in isolation.
 *
 * The output schema mirrors {@link ShareInfo} so MCP clients can render
 * the share info without re-parsing the JSON `text` block.
 */
export function registerGenerateShareInfoTool(
  server: McpServer,
  deps: ToolDeps,
): void {
  // The tool takes no arguments; an empty raw shape is the MCP idiom for
  // "no input expected" while still publishing a valid JSON Schema.
  const inputShape = {} as const;

  const outputShape = {
    publicKey: z
      .string()
      .describe(
        "Delegate public key as a 64-character hex string. Safe to share.",
      ),
    accountId: z
      .string()
      .describe("0x-prefixed 64-char hex Sui account object id."),
    relayerUrl: z
      .string()
      .describe(
        "Base URL of the MemWal relayer to point the dashboard at when logging in.",
      ),
    dashboardUrl: z
      .string()
      .describe("Base URL of the Uberwal dashboard the recipient logs into."),
    instructions: z
      .string()
      .describe(
        "Plain-text instructions covering dashboard login and how to generate a " +
          "separate delegate key via the MemWal staging dashboard.",
      ),
  } as const;

  server.registerTool(
    "generate_share_info",
    {
      title: "Generate share info",
      description:
        "Returns the delegate public key hex, the account id, the relayer URL, and " +
        "instructions for sharing access to the developer's MemWal memories. The " +
        "delegate private key is never included. Errors when no delegate key is " +
        "configured. This tool does not contact the relayer, so no health check is " +
        "performed.",
      inputSchema: inputShape,
      outputSchema: outputShape,
    },
    async () => generateShareInfoHandler(deps),
  );
}
