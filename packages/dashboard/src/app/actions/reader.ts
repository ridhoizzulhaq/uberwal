"use server";

/**
 * Server action proxying Reader Agent turns from the dashboard client to the
 * server-only reasoning module.
 *
 * The Reader chat lives entirely in a client component, so it cannot import
 * the OpenAI SDK or the per-request `MemWalClient` factory directly — both
 * must stay on the server boundary to keep the delegate key and API key off
 * the client. This action is the single seam between the two: it forwards the
 * preset and running conversation to `runReader` and returns its
 * discriminated union unchanged.
 *
 * Per the credential-flow decision in design.md, `"use server"` files export
 * only async functions; all the recall + reasoning logic lives in
 * `server/reader-agent.ts`.
 */

import {
  runReader,
  type RunReaderInput,
  type RunReaderResult,
} from "../../server/reader-agent.js";

/**
 * Run one Reader Agent turn on behalf of a logged-in viewer.
 *
 * Delegates to {@link runReader}, which recalls from the preset's namespaces
 * and reasons over the result with Claude. Returns the same discriminated
 * union so the chat component branches on a single `result.ok` check:
 *   - `{ ok: true, reply, usedMemories }` — the assistant reply plus the
 *     memories it was grounded in.
 *   - `{ ok: false, message }` — not authenticated, missing API key, or any
 *     recall/SDK error, surfaced as a flat string safe for client display.
 */
export async function askReader(
  input: RunReaderInput,
): Promise<RunReaderResult> {
  return runReader(input);
}
