import "server-only";

/**
 * Per-request `MemWalClient` factory for the dashboard.
 *
 * Server actions (`login`, `logout`, `recallNamespace`) call this helper at
 * the top of every request to rebuild a `MemWalClient` from the encrypted
 * session cookie. The client is short-lived: it is created, used for a
 * single recall (or health check), and then dropped. This keeps the
 * delegate key on the server boundary and avoids any long-lived client
 * that would have to be invalidated on logout.
 *
 * Returns `null` when there is no session, which the calling server action
 * surfaces to the client as an unauthenticated state. Throws only when
 * `RELAYER_URL` is missing — a configuration error the operator must fix.
 *
 * Validates: Requirement 7.1
 */

import { MemWalClient } from "@uberwal/shared";

import { getSession } from "./session.js";
import { normalizeRelayerUrl } from "../lib/relayer-url.js";

/**
 * Build a `MemWalClient` for the current request, or return `null` when
 * the request is unauthenticated.
 *
 * The default namespace passed to the SDK is `"default"`. Uberwal always
 * supplies an explicit namespace at every recall/remember call site, so the
 * SDK default is only ever used as a placeholder; choosing `"default"`
 * matches the SDK's documented expectation that callers pass a stable
 * default at construction time.
 */
export async function getMemWalClientFromSession(): Promise<MemWalClient | null> {
  const session = await getSession();
  if (session === null) return null;

  const serverUrl = normalizeRelayerUrl(process.env["RELAYER_URL"]);
  if (serverUrl === null) {
    throw new Error(
      "RELAYER_URL environment variable is required to construct a MemWal client.",
    );
  }

  return MemWalClient.fromCredentials({
    key: session.delegateKey,
    accountId: session.accountId,
    serverUrl,
    namespace: "default",
  });
}
