"use server";

/**
 * Login and logout server actions for the dashboard.
 *
 * `login` is the only place delegate credentials enter the dashboard. It
 * runs the MemWal `health()` check with the supplied credentials, applying
 * a 10-second budget per Requirement 7.1, and writes them into the
 * encrypted session cookie via {@link setSession} only on success. The
 * caller (the login page) receives a discriminated result so it can
 * distinguish *invalid credentials* (Requirement 7.2) from a *connectivity
 * problem* (Requirement 7.5) and render different copy for each.
 *
 * `logout` simply clears the cookie.
 *
 * Distinguishing the two failure modes — design notes
 *
 * The MemWal SDK's `/health` endpoint is documented as public and does not
 * sign requests. That means the SDK cannot, by itself, prove that a given
 * delegate key is *valid* for the supplied account: it can only prove
 * that the relayer is reachable and reports a non-error status. We
 * therefore split the check into two layers:
 *
 *   1. **Format validation** with `isValidDelegateKey` and
 *      `isValidAccountId`. A malformed key or account id is reported as
 *      `invalid-credentials` immediately, without any network call.
 *   2. **Live health check** against the relayer. If the call resolves
 *      with `status === "ok"` we accept the login. If it rejects, we
 *      classify the error: HTTP-style auth signals (401/403) or any
 *      message mentioning auth/credentials are reported as
 *      `invalid-credentials`; everything else (timeout, network error,
 *      non-ok status body) is reported as `connectivity`. This heuristic
 *      lets a relayer that *does* gate `/health` behind auth surface a
 *      bad delegate key clearly, while still allowing the public-health
 *      relayer to fall back to the format check for credential validity.
 *
 * The wrapper class `MemWalClient.isHealthy()` returns a single boolean
 * and does not expose error detail, so this action constructs the SDK
 * directly to inspect the rejection. This is the only place in the
 * dashboard that bypasses the wrapper, and it is justified because
 * distinguishing failure modes is the whole point of the auth flow.
 *
 * Validates: Requirements 7.1, 7.2, 7.5
 */

import { MemWal } from "@mysten-incubation/memwal";

import {
  isValidAccountId,
  isValidDelegateKey,
  type Role,
} from "@uberwal/shared";

import { clearSession, setSession } from "../../server/session.js";

/** 10-second health-check budget per Requirement 7.1 / 7.5. */
const HEALTH_TIMEOUT_MS = 10_000;

/** Sentinel error message used to detect the timeout branch internally. */
const TIMEOUT_SENTINEL = "__dm_login_timeout__";

/**
 * Discriminated result returned to the login page. The `kind` field on the
 * failure variant is what the UI consumes to render either an
 * "invalid credentials" message that preserves the form fields
 * (Requirement 7.2) or a "connectivity problem" message with a retry
 * affordance (Requirement 7.5).
 */
export type LoginResult =
  | { ok: true }
  | {
      ok: false;
      kind: "invalid-credentials" | "connectivity";
      message: string;
    };

/**
 * Input shape for {@link login}. The dashboard's login form passes these
 * three fields through unmodified — server-side validation re-runs the
 * shared format predicates so a manipulated client cannot bypass them.
 */
export interface LoginInput {
  delegateKey: string;
  accountId: string;
  role: Role;
}

/** Stable, user-facing copy for each failure mode. */
const MESSAGES = {
  invalidFormat: "Invalid credentials format",
  invalidAuth: "Invalid credentials",
  connectivity:
    "Could not reach the MemWal relayer. Check your connection and try again.",
} as const;

/**
 * Heuristic classifier for SDK rejection errors.
 *
 * The SDK throws `new Error("Health check failed: ${status}")` for any
 * non-2xx response from `/health`, which is the channel through which a
 * relayer that authenticates `/health` would surface a bad delegate key.
 * We treat HTTP 401/403 and any message containing `auth`, `unauthorized`,
 * `forbidden`, or `invalid credentials` as auth-failure signals. Anything
 * else is connectivity (network errors, DNS failures, 5xx).
 */
function looksLikeAuthFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /(?:\b401\b|\b403\b|\bauth\b|unauthorized|forbidden|invalid\s+credentials?)/i.test(
    message,
  );
}

/**
 * Race a promise against a timeout that rejects with {@link TIMEOUT_SENTINEL}.
 *
 * The timer is always cleared in `finally` so a slow `health()` resolution
 * after the timeout does not keep the Node event loop alive.
 */
async function withHealthTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<T>([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(TIMEOUT_SENTINEL)),
          HEALTH_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Authenticate the supplied credentials and open a session.
 *
 * On success this writes an encrypted session cookie containing
 * `{ accountId, delegateKey, role }` (see `server/session.ts`) and
 * resolves to `{ ok: true }`. The caller is responsible for navigating
 * to the dashboard home page after a successful resolution; this action
 * does not redirect so the page can manage its own pending state.
 *
 * On failure, it returns a `LoginResult` whose `kind` distinguishes:
 *   - `invalid-credentials` — the delegate key or account id is wrong
 *     (either malformed or rejected by the relayer).
 *   - `connectivity` — the relayer did not respond within 10 seconds or
 *     returned a non-auth error.
 *
 * Validates: Requirements 7.1, 7.2, 7.5
 */
export async function login(input: LoginInput): Promise<LoginResult> {
  const { delegateKey, accountId, role } = input;

  // Step 1: shared format predicates. A malformed credential cannot
  // possibly be valid, so we reject without touching the network. This
  // also protects the SDK from `hexToBytes` throwing on bad hex.
  if (!isValidDelegateKey(delegateKey) || !isValidAccountId(accountId)) {
    return {
      ok: false,
      kind: "invalid-credentials",
      message: MESSAGES.invalidFormat,
    };
  }

  // Step 2: build a transient SDK instance for the health probe. We use
  // the SDK directly (rather than `MemWalClient.isHealthy()`) because the
  // wrapper collapses every failure mode to `false`, and we need the
  // underlying error to distinguish auth failure from connectivity.
  const serverUrl = process.env["RELAYER_URL"];
  if (typeof serverUrl !== "string" || serverUrl.length === 0) {
    throw new Error(
      "RELAYER_URL environment variable is required to authenticate.",
    );
  }

  let sdk: MemWal;
  try {
    sdk = MemWal.create({
      key: delegateKey,
      accountId,
      serverUrl,
      namespace: "default",
    });
  } catch {
    // Construction can only fail when the SDK rejects the inputs (e.g.
    // unparseable hex slipping past the format check). Treat as
    // invalid credentials so the user sees the expected error copy.
    return {
      ok: false,
      kind: "invalid-credentials",
      message: MESSAGES.invalidAuth,
    };
  }

  // Step 3: race the health call against a 10s timeout.
  try {
    const result = await withHealthTimeout(sdk.health());
    if (result.status !== "ok") {
      // Relayer reachable but reporting a degraded state — surface as a
      // connectivity problem so the user can retry rather than reset
      // their credentials.
      return {
        ok: false,
        kind: "connectivity",
        message: MESSAGES.connectivity,
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === TIMEOUT_SENTINEL) {
      return {
        ok: false,
        kind: "connectivity",
        message: MESSAGES.connectivity,
      };
    }
    if (looksLikeAuthFailure(err)) {
      return {
        ok: false,
        kind: "invalid-credentials",
        message: MESSAGES.invalidAuth,
      };
    }
    return {
      ok: false,
      kind: "connectivity",
      message: MESSAGES.connectivity,
    };
  }

  // Step 4: persist the encrypted session and report success.
  await setSession({ accountId, delegateKey, role });
  return { ok: true };
}

/**
 * Clear the session cookie. After this resolves, subsequent server actions
 * that depend on a session (e.g. `recallNamespace`) will see no session
 * and surface an unauthenticated state to the client.
 */
export async function logout(): Promise<void> {
  await clearSession();
}
