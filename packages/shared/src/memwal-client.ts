/**
 * Thin wrapper around the MemWal SDK shared by the MCP server and the
 * dashboard.
 *
 * Centralizes:
 *   - SDK construction from {@link MemWalCredentials}
 *   - the mandatory pre-operation health check (with a timeout) used both at
 *     server startup and as a per-tool gate
 *   - recall input validation (namespace + query), clamping of `limit` and
 *     `maxDistance`, and result normalization via `normalizeRecall`
 *   - append-only writes via `rememberAndWait`
 *
 * The wrapper deliberately keeps a tiny surface so the two consumers behave
 * identically. All recall/remember errors propagate to callers; only
 * `isHealthy` swallows errors and timeouts so it can return a clean boolean.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 14.1, 14.3
 */

import { MemWal } from "@mysten-incubation/memwal";
import type { HealthResult, RememberResult } from "@mysten-incubation/memwal";

import {
  clampLimit,
  clampMaxDistance,
  isValidNamespace,
  isValidQuery,
  type Namespace,
} from "./validation.js";
import { normalizeRecall, type RecallResult, type StoredRef } from "./result.js";

/**
 * Credentials required to construct a MemWal SDK client.
 *
 * Mirrors the subset of `MemWalConfig` Uberwal always supplies. All four
 * fields are required so the wrapper has enough information to (a) sign
 * relayer requests, (b) target the correct account, (c) talk to the right
 * relayer, and (d) honour Uberwal's namespace conventions.
 */
export interface MemWalCredentials {
  /** 64-character hex Ed25519 delegate private key. */
  key: string;
  /** `0x`-prefixed 64-character hex Sui account object id. */
  accountId: string;
  /** Base URL of the MemWal relayer (e.g. the staging or production server). */
  serverUrl: string;
  /**
   * Default namespace for the underlying SDK. Uberwal operations always
   * pass an explicit namespace, but the SDK requires a default at
   * construction time, so callers supply one (typically `"default"`).
   */
  namespace: string;
}

/**
 * Parameters for {@link MemWalClient.recall}.
 *
 * `limit` and `maxDistance` are optional and clamped to their valid ranges
 * with documented defaults (see `clampLimit` / `clampMaxDistance`). The
 * `namespace` field is the strict {@link Namespace} union — callers that
 * accept arbitrary strings must validate them with `isValidNamespace` first.
 */
export interface RecallParams {
  /** Free-text query; rejected if empty or whitespace-only. */
  query: string;
  /** One of the four Uberwal namespaces. */
  namespace: Namespace;
  /** Maximum number of results, clamped to [1, 100]; defaults to 10. */
  limit?: number;
  /** Distance threshold, clamped to [0, 1]; defaults to 1. */
  maxDistance?: number;
}

/** Default health-check timeout (Requirement 14.1, 14.3). */
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

/**
 * Race a promise against a timeout that resolves to a sentinel.
 *
 * Resolves to the original promise's value when it settles first, or to
 * `timeoutValue` when the timer fires first. The timer is always cleared so
 * we never leak open handles into the calling process.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutValue: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(timeoutValue), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Uberwal's wrapper around the MemWal SDK.
 *
 * Construction goes through {@link MemWalClient.fromCredentials} so the SDK
 * instance is built consistently and we can stub it in tests.
 */
export class MemWalClient {
  /**
   * Underlying SDK instance. Held privately so tests can replace it through
   * the `__createForTesting` static constructor without exposing the SDK
   * type to callers of the wrapper.
   */
  private readonly sdk: MemWal;

  /**
   * Internal constructor — kept private so callers go through
   * {@link MemWalClient.fromCredentials}, which is the only place the SDK
   * is configured.
   */
  private constructor(sdk: MemWal) {
    this.sdk = sdk;
  }

  /**
   * Build a `MemWalClient` from {@link MemWalCredentials}.
   *
   * Delegates to `MemWal.create(...)`. The SDK does not perform any I/O at
   * construction time, so this method is synchronous and cheap; the first
   * network request happens when the caller calls `isHealthy`, `recall`, or
   * `remember`.
   */
  static fromCredentials(creds: MemWalCredentials): MemWalClient {
    const sdk = MemWal.create({
      key: creds.key,
      accountId: creds.accountId,
      serverUrl: creds.serverUrl,
      namespace: creds.namespace,
    });
    return new MemWalClient(sdk);
  }

  /**
   * Internal escape hatch for unit tests: build a wrapper around an existing
   * SDK-shaped object without going through `MemWal.create`. The double
   * underscore prefix makes the intended audience obvious — production code
   * should always use {@link MemWalClient.fromCredentials}.
   */
  static __createForTesting(sdk: MemWal): MemWalClient {
    return new MemWalClient(sdk);
  }

  /**
   * Verify relayer connectivity.
   *
   * Resolves to `true` only when the SDK's `health()` call returns within
   * `timeoutMs` and reports `status === "ok"`. Resolves to `false` when:
   *   - the timeout elapses first,
   *   - `health()` rejects (network error, 5xx, etc.), or
   *   - `health()` resolves with any non-`"ok"` status.
   *
   * Defaults `timeoutMs` to 5_000 to satisfy the startup and per-tool
   * health-gate budgets described in Requirements 14.1 and 14.3.
   *
   * Validates: Requirement 14.1, 14.3
   */
  async isHealthy(timeoutMs: number = DEFAULT_HEALTH_TIMEOUT_MS): Promise<boolean> {
    // Wrap the SDK call so a synchronous throw (which the SDK should never
    // do, but we are defensive) collapses to `false` like an async rejection.
    const healthPromise: Promise<HealthResult | null> = (async () => {
      try {
        return await this.sdk.health();
      } catch {
        return null;
      }
    })();

    const result = await withTimeout<HealthResult | null>(healthPromise, timeoutMs, null);
    if (result === null) return false;
    return result.status === "ok";
  }

  /**
   * Recall memories from a Uberwal namespace.
   *
   * Validates `namespace` and `query`, clamps `limit` and `maxDistance`, then
   * forwards the request to the SDK and normalizes the response.
   *
   * Throws an `Error` on invalid input (so calling MCP tools / server actions
   * can translate it into a tool-level validation error). Network and SDK
   * errors propagate unchanged.
   *
   * Validates: Requirements 2.1, 2.2, 2.3, 2.4
   */
  async recall(params: RecallParams): Promise<RecallResult> {
    if (!isValidNamespace(params.namespace)) {
      throw new Error(
        `Invalid namespace: "${String(params.namespace)}". ` +
          `Expected one of sessions, skills, productivity, reports.`,
      );
    }
    if (!isValidQuery(params.query)) {
      throw new Error("Query is required and must contain at least one non-whitespace character.");
    }

    const limit = clampLimit(params.limit);
    const maxDistance = clampMaxDistance(params.maxDistance);

    const raw = await this.sdk.recall({
      query: params.query,
      namespace: params.namespace,
      limit,
      maxDistance,
    });

    return normalizeRecall(raw);
  }

  /**
   * Append a memory to the given namespace via `rememberAndWait`.
   *
   * Returns once the relayer reports a terminal state for the job. Errors
   * (including timeouts inside the SDK's polling loop) propagate to the
   * caller so the MCP tool layer can record per-fact storage failures
   * (Requirement 15.5 / 1.5 storage partitioning behaviour).
   *
   * The `timeoutMs` parameter is forwarded to the SDK's polling timeout. The
   * MCP `commit_session` tool uses 30000ms for `session`-type writes per
   * Requirement 15.2; other call sites default to whatever the SDK chooses
   * (currently 120s) when `timeoutMs` is omitted.
   */
  async remember(
    text: string,
    namespace: Namespace,
    timeoutMs?: number,
  ): Promise<StoredRef> {
    // Build SDK options conditionally so we never pass an explicit
    // `timeoutMs: undefined`, which `exactOptionalPropertyTypes` rejects and
    // the SDK could conceivably treat differently than "absent".
    const result: RememberResult =
      timeoutMs === undefined
        ? await this.sdk.rememberAndWait(text, namespace)
        : await this.sdk.rememberAndWait(text, namespace, { timeoutMs });

    return {
      id: result.id,
      blob_id: result.blob_id,
      namespace: result.namespace,
    };
  }

  /**
   * Return the delegate public key as a hex string.
   *
   * Asynchronous because the SDK derives the public key lazily from the
   * delegate private key on first use. Used by `generate_share_info` to
   * provide recipients with the public key without ever exposing the
   * private key.
   */
  getPublicKeyHex(): Promise<string> {
    return this.sdk.getPublicKeyHex();
  }
}
