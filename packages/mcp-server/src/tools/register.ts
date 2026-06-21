/**
 * Tool registration entry point for the Uberwal MCP server.
 *
 * The bootstrap in `src/index.ts` builds an `McpServer` and a {@link ToolDeps}
 * bundle, then calls {@link registerTools} once. Subsequent tasks in the plan
 * (extract_session, commit_session, recall_memory, my_skills, my_productivity,
 * generate_report, generate_share_info) will each add their tool registration
 * inside this function so the bootstrap stays unchanged.
 *
 * Tools land here as their tasks complete:
 *   - `recall_memory`    (task 9.1)  — wired in via {@link registerRecallMemoryTool}.
 *   - `extract_session`  (task 8.1)  — wired in via {@link registerExtractSessionTool}.
 *   - `commit_session`   (task 8.1)  — wired in via {@link registerCommitSessionTool}.
 *   - `my_skills`        (task 9.2)  — wired in via {@link registerMySkillsTool}.
 *   - `my_productivity`  (task 9.2)  — wired in via {@link registerMyProductivityTool}.
 *   - `generate_report`  (task 10.1) — wired in via {@link registerGenerateReportTool}.
 *   - `generate_share_info` (task 11.1) — wired in via {@link registerGenerateShareInfoTool}.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemWalClient } from "@uberwal/shared";

import type { Config } from "../config.js";
import type { Extractor } from "../extraction/extractor.js";

import { registerCommitSessionTool } from "./commit-session.js";
import { registerExtractSessionTool } from "./extract-session.js";
import { registerGenerateReportTool } from "./generate-report.js";
import { registerGenerateShareInfoTool } from "./generate-share-info.js";
import { registerMyProductivityTool } from "./my-productivity.js";
import { registerMySkillsTool } from "./my-skills.js";
import { registerRecallMemoryTool } from "./recall-memory.js";

/**
 * Dependencies every tool may need. The bootstrap constructs this once and
 * passes it through; individual tool modules pluck what they need.
 *
 * The `Config` is passed in full (rather than just the fields a particular
 * tool uses) so tools introduced later can opt into the values they need
 * without changing the bootstrap surface.
 */
export interface ToolDeps {
  /** Shared MemWal wrapper used for health checks, recall, and remember. */
  readonly memwal: MemWalClient;
  /**
   * Claude-backed extractor used by `extract_session` (and later by
   * `generate_report` for summarization). Injected so tests can swap in a
   * fake extractor without touching the bootstrap.
   */
  readonly extractor: Extractor;
  /** Validated environment configuration (delegate key, account id, etc.). */
  readonly config: Config;
}

/**
 * Register every Uberwal MCP tool against the supplied `server`.
 *
 * This is the single point of extension for tool registration. With
 * task 11.1 (`generate_share_info`) wired below, all seven Uberwal MCP
 * tools are now registered.
 */
export function registerTools(server: McpServer, deps: ToolDeps): void {
  // extract_session — phase 1 of two-phase session capture (task 8.1).
  registerExtractSessionTool(server, deps);
  // commit_session — phase 2 of two-phase session capture (task 8.1).
  registerCommitSessionTool(server, deps);
  // recall_memory — semantic search across a single namespace (task 9.1).
  registerRecallMemoryTool(server, deps);
  // my_skills — recall shortcut pinned to the skills namespace (task 9.2).
  registerMySkillsTool(server, deps);
  // my_productivity — recall shortcut pinned to the productivity namespace (task 9.2).
  registerMyProductivityTool(server, deps);
  // generate_report — aggregate skills + productivity into a stored prose report (task 10.1).
  registerGenerateReportTool(server, deps);
  // generate_share_info — emit metadata-only sharing payload (task 11.1).
  registerGenerateShareInfoTool(server, deps);
}
