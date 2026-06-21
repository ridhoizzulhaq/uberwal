#!/usr/bin/env node
/**
 * Uberwal MCP server bootstrap.
 *
 * Responsibilities:
 *   1. Load and validate environment configuration ({@link loadConfig}).
 *   2. Build a shared {@link MemWalClient} from those credentials.
 *   3. Run the startup MemWal health check with a 5-second timeout. Per
 *      Requirement 14.2, a failed startup health check logs a warning and
 *      lets the server start anyway — per-tool health gates (Req 14.3) are
 *      what actually block memory operations later.
 *   4. Build an {@link McpServer}, register tools (added by subsequent
 *      tasks), and connect a stdio transport so Claude Code can speak to
 *      the server over JSON-RPC.
 *
 * Logging note: the MCP stdio transport reserves stdout for JSON-RPC
 * messages. Anything informational therefore goes to stderr via
 * `console.error`, including the startup banner, the health-check warning,
 * and any fatal bootstrap error.
 *
 * Validates: Requirements 14.1, 14.2
 */

import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { MemWalClient } from "@uberwal/shared";

import { ConfigError, loadConfig, type Config } from "./config.js";
import { createExtractor, type Extractor } from "./extraction/extractor.js";
import { registerTools, type ToolDeps } from "./tools/register.js";

/** Server identity reported to MCP clients during initialization. */
const SERVER_INFO = {
  name: "uberwal-mcp",
  version: "0.1.0",
} as const;

/** Timeout for the startup health check (Requirement 14.1). */
const STARTUP_HEALTH_TIMEOUT_MS = 5_000;

/**
 * Build the shared {@link MemWalClient} from validated configuration.
 *
 * The SDK requires a default `namespace` at construction time even though
 * Uberwal always passes an explicit namespace to recall/remember. We
 * supply `"default"` here as a clearly-named placeholder; tools never rely
 * on this value.
 */
function buildMemWalClient(config: Config): MemWalClient {
  return MemWalClient.fromCredentials({
    key: config.delegateKey,
    accountId: config.accountId,
    serverUrl: config.relayerUrl,
    namespace: "default",
  });
}

/**
 * Build the shared {@link Extractor} from validated configuration.
 *
 * `createExtractor` constructs an `OpenAI` client from the API key (and an
 * optional base URL) and returns a `ClaudeExtractor` that the
 * `extract_session` and `generate_report` tools share. Construction is
 * synchronous and cheap; the first network call happens when a tool invokes
 * the extractor.
 */
function buildExtractor(config: Config): Extractor {
  return createExtractor({
    apiKey: config.openaiApiKey,
    model: config.openaiModel,
    ...(config.openaiBaseUrl !== undefined ? { baseURL: config.openaiBaseUrl } : {}),
  });
}

/**
 * Run the startup health check and log a warning on failure.
 *
 * Returns nothing: per Requirement 14.2 a failed startup health check must
 * not abort startup. The boolean result is logged for operator visibility,
 * and per-tool health gates (added by later tasks) are what actually block
 * memory operations when the relayer is unavailable.
 *
 * Exported so the integration test in `startup.test.ts` can exercise it
 * directly with a stubbed `MemWalClient` without spawning the full server.
 *
 * Validates: Requirements 14.1, 14.2
 */
export async function runStartupHealthCheck(memwal: MemWalClient): Promise<void> {
  const healthy = await memwal.isHealthy(STARTUP_HEALTH_TIMEOUT_MS);
  if (!healthy) {
    console.error(
      "[uberwal-mcp] Warning: MemWal relayer health check failed at startup. " +
        "Continuing — per-tool health gates will block memory operations until the relayer is reachable.",
    );
  }
}

/**
 * Construct the MCP server, register tools, and connect stdio.
 *
 * Returns the connected server so callers (currently `main`) can hold a
 * reference for graceful shutdown if needed.
 */
async function startServer(deps: ToolDeps): Promise<McpServer> {
  const server = new McpServer(SERVER_INFO, {
    capabilities: {
      // Tools are the only MCP capability Uberwal uses; resources/prompts
      // are not part of the spec.
      tools: {},
    },
  });

  registerTools(server, deps);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[uberwal-mcp] Connected over stdio. Awaiting MCP requests.");
  return server;
}

/**
 * Entry point. Loads configuration, builds the shared client, runs the
 * startup health check, and starts the MCP server.
 *
 * Bootstrap errors (invalid configuration, transport failure) are reported
 * to stderr and the process exits with a non-zero status so a supervisor
 * (Claude Code, an `npm start` watcher, etc.) can react.
 */
async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
    } else {
      console.error("[uberwal-mcp] Failed to load configuration:", err);
    }
    process.exit(1);
  }

  const memwal = buildMemWalClient(config);
  await runStartupHealthCheck(memwal);

  const extractor = buildExtractor(config);

  await startServer({ memwal, extractor, config });
}

// Run the bootstrap only when this module is invoked directly (e.g. via the
// `uberwal-mcp` bin entry, `node dist/index.js`, or `tsx src/index.ts`).
// When the module is imported by a test, `main()` must not run at import
// time — otherwise loading credentials and opening a stdio transport would
// be unavoidable side effects of `import "./index.js"` from a test file.
const isDirectInvocation = ((): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return fileURLToPath(import.meta.url) === entry;
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  main().catch((err: unknown) => {
    console.error("[uberwal-mcp] Fatal bootstrap error:", err);
    process.exit(1);
  });
}
