/**
 * Environment configuration for the Uberwal MCP server.
 *
 * Loads the required environment variables, validates their format, and
 * exposes them through a strongly-typed {@link Config} object. The MCP
 * server's `index.ts` calls {@link loadConfig} once at startup; tools then
 * receive the typed config (or values derived from it) through dependency
 * injection rather than reading `process.env` directly.
 *
 * Required variables:
 *   - DELEGATE_KEY        — 64-character hex Ed25519 delegate private key
 *   - ACCOUNT_ID          — `0x`-prefixed 64-character hex Sui account id
 *   - RELAYER_URL         — base URL of the MemWal relayer
 *   - OPENAI_API_KEY      — API key for the OpenAI-compatible chat model used
 *                           by the extraction / summarization service
 *
 * Optional variables:
 *   - OPENAI_BASE_URL     — base URL of the OpenAI-compatible endpoint (e.g.
 *                           a gateway in front of Bedrock). When unset the
 *                           OpenAI SDK default is used.
 *   - OPENAI_MODEL        — chat model id used by the extraction service
 *                           (defaults to `openai.gpt-oss-120b`)
 *   - DASHBOARD_URL       — base URL of the Uberwal dashboard recipients
 *                           log into (defaults to http://localhost:3000)
 *
 * `loadConfig` aggregates every problem it finds (missing variable, wrong
 * format, invalid URL) and throws a single error listing all of them so the
 * operator can fix the environment in one pass instead of triaging errors
 * one at a time.
 *
 * Validates: Requirements 14.1, 14.2 (env-driven bootstrap of the MemWal
 * client used by the startup health check).
 */

import { isValidAccountId, isValidDelegateKey } from "@uberwal/shared";

/**
 * Strongly-typed bundle of validated environment variables consumed by the
 * MCP server.
 *
 * The fields use camelCase names to match the rest of the TypeScript
 * codebase; the underlying environment variable names are documented on
 * each field for traceability.
 */
export interface Config {
  /** `DELEGATE_KEY` — 64-char hex Ed25519 delegate private key. */
  readonly delegateKey: string;
  /** `ACCOUNT_ID` — `0x`-prefixed 64-char hex Sui account object id. */
  readonly accountId: string;
  /** `RELAYER_URL` — base URL of the MemWal relayer. */
  readonly relayerUrl: string;
  /**
   * `OPENAI_API_KEY` — API key for the OpenAI-compatible chat model used for
   * fact extraction / report summarization. Falls back to
   * `AWS_BEARER_TOKEN_BEDROCK` (the long-term AWS Bedrock bearer token) when
   * `OPENAI_API_KEY` is unset.
   */
  readonly openaiApiKey: string;
  /**
   * `OPENAI_BASE_URL` — base URL of the OpenAI-compatible endpoint. `undefined`
   * when unset, in which case the OpenAI SDK falls back to its own default.
   */
  readonly openaiBaseUrl: string | undefined;
  /**
   * `OPENAI_MODEL` — chat model id used by the extraction service. Defaults to
   * `openai.gpt-oss-120b` when unset.
   */
  readonly openaiModel: string;
  /**
   * `DASHBOARD_URL` — base URL of the Uberwal dashboard recipients log
   * into. Distinct from `RELAYER_URL` (the MemWal relayer) and from the
   * MemWal dashboard (where recipients generate their own delegate key).
   * Defaults to `http://localhost:3000` when unset.
   */
  readonly dashboardUrl: string;
}

/**
 * Source object that {@link loadConfig} reads from. Defaults to
 * `process.env`; tests pass a plain object instead so they can exercise the
 * validation logic without touching the ambient environment.
 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/** Names of the variables `loadConfig` requires. Exported for diagnostics. */
export const REQUIRED_ENV_VARS = [
  "DELEGATE_KEY",
  "ACCOUNT_ID",
  "RELAYER_URL",
  "OPENAI_API_KEY",
] as const;

/** Error thrown by {@link loadConfig} when the environment is misconfigured. */
export class ConfigError extends Error {
  /** Each individual problem detected during loading, in the order found. */
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    // Render every issue as a bullet so the operator can read all of them at once.
    const summary = issues.length === 1 ? issues[0] : `${issues.length} configuration problems`;
    const body = issues.map((issue) => `  - ${issue}`).join("\n");
    super(`Invalid MCP server configuration: ${summary}\n${body}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/**
 * Returns the trimmed string value of `name` from `env`, or `undefined` if
 * the variable is missing, empty, or whitespace-only. Trimming protects
 * against accidental leading/trailing whitespace introduced by shells, env
 * files, or copy-paste.
 */
function readVar(env: EnvSource, name: string): string | undefined {
  const raw = env[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Returns `true` iff `value` parses as an absolute URL. Used so the operator
 * gets a clear "RELAYER_URL is not a valid URL" message instead of a cryptic
 * SDK failure on the first relayer call.
 */
function isValidUrl(value: string): boolean {
  try {
    // `new URL` throws on malformed input; absolute URLs satisfy the SDK.
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** Default Uberwal dashboard URL used when `DASHBOARD_URL` is unset. */
const DEFAULT_DASHBOARD_URL = "http://localhost:3000";

/**
 * Default chat model id used when `OPENAI_MODEL` is unset.
 *
 * This is the OpenAI-compatible model id used in the project's reference
 * setup; deployments behind a different gateway can override it.
 */
const DEFAULT_OPENAI_MODEL = "openai.gpt-oss-120b";

/**
 * Load and validate the MCP server's environment configuration.
 *
 * Reads `DELEGATE_KEY`, `ACCOUNT_ID`, `RELAYER_URL`, and `OPENAI_API_KEY` from
 * `env` (defaulting to `process.env`) and validates each one. The
 * OpenAI-backed extraction service additionally reads the optional
 * `OPENAI_BASE_URL` (must be a valid URL when set) and `OPENAI_MODEL` (default
 * `openai.gpt-oss-120b`). The optional `DASHBOARD_URL` defaults to
 * `http://localhost:3000` and, when set, must be a valid URL. Throws
 * {@link ConfigError} listing every problem it finds when any required
 * variable is missing or malformed.
 *
 * The function is pure — it never mutates `env` or `process.env` — so tests
 * can call it repeatedly with different inputs.
 */
export function loadConfig(env: EnvSource = process.env): Config {
  const issues: string[] = [];

  const delegateKey = readVar(env, "DELEGATE_KEY");
  if (delegateKey === undefined) {
    issues.push("DELEGATE_KEY is required but was not set.");
  } else if (!isValidDelegateKey(delegateKey)) {
    issues.push(
      "DELEGATE_KEY must be exactly 64 hexadecimal characters with no 0x prefix.",
    );
  }

  const accountId = readVar(env, "ACCOUNT_ID");
  if (accountId === undefined) {
    issues.push("ACCOUNT_ID is required but was not set.");
  } else if (!isValidAccountId(accountId)) {
    issues.push(
      "ACCOUNT_ID must be 0x followed by exactly 64 hexadecimal characters.",
    );
  }

  const relayerUrl = readVar(env, "RELAYER_URL");
  if (relayerUrl === undefined) {
    issues.push("RELAYER_URL is required but was not set.");
  } else if (!isValidUrl(relayerUrl)) {
    issues.push(`RELAYER_URL is not a valid URL: "${relayerUrl}".`);
  }

  // Accept the long-term AWS Bedrock bearer token as a fallback for the API
  // key so deployments behind the Bedrock OpenAI-compatible gateway can use a
  // non-expiring credential instead of a short-lived presigned OPENAI_API_KEY.
  const openaiApiKey =
    readVar(env, "OPENAI_API_KEY") ?? readVar(env, "AWS_BEARER_TOKEN_BEDROCK");
  if (openaiApiKey === undefined) {
    issues.push(
      "OPENAI_API_KEY is required but was not set (AWS_BEARER_TOKEN_BEDROCK is also accepted).",
    );
  }

  // Optional: OPENAI_BASE_URL. When provided it must parse as a URL.
  const openaiBaseUrl = readVar(env, "OPENAI_BASE_URL");
  if (openaiBaseUrl !== undefined && !isValidUrl(openaiBaseUrl)) {
    issues.push(`OPENAI_BASE_URL is not a valid URL: "${openaiBaseUrl}".`);
  }

  // Optional: OPENAI_MODEL with a default.
  const openaiModel = readVar(env, "OPENAI_MODEL") ?? DEFAULT_OPENAI_MODEL;

  // Optional: DASHBOARD_URL. When provided it must parse as a URL; when
  // absent we fall back to the local dev default.
  const dashboardUrlRaw = readVar(env, "DASHBOARD_URL");
  if (dashboardUrlRaw !== undefined && !isValidUrl(dashboardUrlRaw)) {
    issues.push(`DASHBOARD_URL is not a valid URL: "${dashboardUrlRaw}".`);
  }
  const dashboardUrl = dashboardUrlRaw ?? DEFAULT_DASHBOARD_URL;

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  // Every required variable was validated above, so the non-null assertions
  // are sound. The model and dashboard URL always have defaults; the base URL
  // is genuinely optional and passed through as `undefined` when unset.
  return {
    delegateKey: delegateKey!,
    accountId: accountId!,
    relayerUrl: relayerUrl!,
    openaiApiKey: openaiApiKey!,
    openaiBaseUrl,
    openaiModel,
    dashboardUrl,
  };
}
