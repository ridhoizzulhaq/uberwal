# Implementation Plan: DevMemory

## Overview

This plan builds DevMemory as an npm/pnpm workspace monorepo with three packages, implemented in TypeScript. Work proceeds bottom-up: the `@dev-memory/shared` library (the pure-logic foundation and the primary property-based testing target) comes first, then the `@dev-memory/mcp-server` tools and extraction service, then the `@dev-memory/dashboard` Next.js app. Each step builds on the previous and ends by wiring components into a runnable whole.

All 13 correctness properties are implemented as `fast-check` property tests (minimum 100 iterations each), tagged `// Feature: dev-memory, Property N: ...`, placed next to the code they validate so errors surface early. Example, integration (mocked MemWal/Claude), and dashboard component tests cover the remaining behaviors.

## Tasks

- [x] 1. Initialize monorepo workspace and shared toolchain
  - Create root `package.json` with `workspaces: ["packages/*"]` and pnpm/npm workspace config
  - Add `tsconfig.base.json` with strict TypeScript settings shared by all packages
  - Install and configure Vitest and `fast-check` at the workspace root for cross-package test runs
  - Create the three package directories (`packages/shared`, `packages/mcp-server`, `packages/dashboard`) each with a `package.json` declaring its `@dev-memory/*` name and dependencies
  - _Requirements: foundational (supports all)_

- [x] 2. Implement the shared validation, namespace, and result layer
  - [x] 2.1 Implement pure validation functions
    - Create `packages/shared/src/validation.ts` with `isValidQuery`, `isValidTranscript`, `isValidNamespace`, `isValidDelegateKey`, `isValidAccountId`, `clampLimit`, `clampMaxDistance`
    - Export the `NAMESPACES` const tuple and `Namespace` type
    - _Requirements: 1.7, 2.2, 2.3, 2.6, 2.7, 7.4_

  - [x] 2.2 Write property test for blank-input rejection
    - **Property 1: Blank input is rejected, non-blank input is accepted**
    - **Validates: Requirements 1.7, 2.7**
    - Use a generator mixing empty, whitespace runs (spaces/tabs/newlines), unicode whitespace, and strings guaranteed to contain a non-whitespace character; 100+ iterations

  - [x] 2.3 Write property test for clamping and defaults
    - **Property 2: Clamping keeps values in range with correct defaults**
    - **Validates: Requirements 2.2, 2.3**
    - Assert `clampLimit` ∈ [1,100] (undefined→10), `clampMaxDistance` ∈ [0,1] (undefined→0.7), in-range values unchanged; 100+ iterations

  - [x] 2.4 Write property test for namespace validity
    - **Property 3: Namespace validity is exactly the four known namespaces**
    - **Validates: Requirements 2.6**
    - Assert `isValidNamespace` is true iff value ∈ {sessions, skills, productivity, reports}; 100+ iterations

  - [x] 2.5 Write property test for credential format validation
    - **Property 4: Credential format validation accepts exactly well-formed hex**
    - **Validates: Requirements 7.4**
    - Use hex generators producing correct-length hex, off-by-one lengths, mixed case, non-hex chars, and `0x`-prefix variants; 100+ iterations

  - [x] 2.6 Implement recall result types and normalization
    - Create `packages/shared/src/result.ts` with `RecallEntry`, `RecallResult`, `StoredRef` types and `normalizeRecall(raw)` mapping arbitrary SDK responses to `{ results: {blob_id, text, distance}[], total }`
    - _Requirements: 2.4_

  - [x] 2.7 Write property test for recall normalization
    - **Property 5: Recall normalization preserves the required shape**
    - **Validates: Requirements 2.4**
    - Generate arbitrary raw recall responses; assert every entry has `blob_id`, `text`, numeric `distance`, and non-negative `total`; 100+ iterations

- [x] 3. Implement shared role/namespace helpers
  - [x] 3.1 Implement role-to-tabs logic
    - Create `packages/shared/src/namespaces.ts` with `Role`, `Tab` types, `tabsForRole(role)`, `defaultTabForRole(role)`, and `resolveActiveTab(role, activeTab)` (returns current tab if still visible, else `defaultTabForRole`)
    - _Requirements: 13.2, 13.3, 13.4, 13.5_

  - [x] 3.2 Write property test for role-to-tabs mapping
    - **Property 11: Role-to-tabs mapping is exact**
    - **Validates: Requirements 13.2, 13.3, 13.4**
    - Assert developer→all four, team-lead→[productivity, reports], recruiter→[skills]; 100+ iterations

  - [x] 3.3 Write property test for active-tab resolution
    - **Property 12: Active-tab resolution after role change stays visible**
    - **Validates: Requirements 13.5**
    - Assert resolved tab ∈ `tabsForRole(role)`, unchanged when still visible, else equals `defaultTabForRole`; 100+ iterations

- [x] 4. Implement the shared MemWalClient wrapper
  - [x] 4.1 Implement MemWalClient construction, health, recall, remember
    - Create `packages/shared/src/memwal-client.ts` with `MemWalCredentials`, `RecallParams` interfaces and the `MemWalClient` class: `fromCredentials`, `isHealthy(timeoutMs)` (true iff `status === "ok"`), `recall` (validates namespace+query, clamps limit/maxDistance, normalizes), `remember`, `getPublicKeyHex`
    - Wire MemWal SDK (`@mysten-incubation/memwal`) construction inside the class
    - Create `packages/shared/src/index.ts` re-exporting validation, namespaces, result, and client
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 14.1, 14.3_

  - [x] 4.2 Write property test for health-status mapping
    - **Property 13: Health status maps to a boolean correctly**
    - **Validates: Requirements 14.1**
    - Mock the SDK `health()`; generate arbitrary `status` values; assert `isHealthy` true iff `status === "ok"`; 100+ iterations

  - [x] 4.3 Write unit tests for recall clamping/validation wiring
    - Verify `recall` rejects invalid namespace/empty query and clamps out-of-range limit/maxDistance before calling the SDK
    - _Requirements: 2.1, 2.2, 2.3, 2.6, 2.7_

- [x] 5. Checkpoint - shared library complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement MCP server config and bootstrap
  - [x] 6.1 Implement env config and server bootstrap
    - Create `packages/mcp-server/src/config.ts` loading `DELEGATE_KEY`, `ACCOUNT_ID`, `RELAYER_URL`, `ANTHROPIC_API_KEY`
    - Create `packages/mcp-server/src/index.ts` that builds a `MemWalClient`, runs the startup `isHealthy()` check (5s) logging a warning and continuing on failure, registers tools, and connects stdio transport via `@modelcontextprotocol/sdk`
    - _Requirements: 14.1, 14.2_

  - [x] 6.2 Write integration test for startup health check
    - Verify startup logs a warning and continues when health fails, and starts normally when healthy (mocked client)
    - _Requirements: 14.1, 14.2_

- [x] 7. Implement the Claude extraction service
  - [x] 7.1 Implement extractor and prompts
    - Create `packages/mcp-server/src/extraction/prompts.ts` and `extraction/extractor.ts` with `extractFacts(transcript)` and `summarizeReport(skills, productivity)` using `@anthropic-ai/sdk` model `claude-sonnet-4-20250514`
    - Parse extraction JSON defensively: strip markdown fences, locate first JSON object, treat parse failure as extraction failure
    - _Requirements: 1.2, 1.3, 5.2_

  - [x] 7.2 Write unit tests for defensive extraction parsing
    - Test fenced/prose-wrapped JSON parsing and malformed-JSON → extraction failure (mocked Anthropic client)
    - _Requirements: 1.2, 1.3, 1.4_

- [x] 8. Implement save_session tool with per-fact storage
  - [x] 8.1 Implement save_session orchestration
    - Create `packages/mcp-server/src/tools/save-session.ts`: per-tool health gate (5s) → validate transcript → `remember(summary, "sessions", 30000)` → extract facts → store each fact independently, collecting `FactStorageOutcome[]` and `succeeded`/`failed` counts
    - On extraction failure, return extraction-failed error while preserving the already-stored session
    - Define `FactStorageOutcome` and `SaveSessionResult` types
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 14.3, 14.4_

  - [x] 8.2 Write property test for multi-fact storage partitioning
    - **Property 6: Multi-fact storage partitions every fact into succeeded or failed**
    - **Validates: Requirements 1.5**
    - Generate a fact list paired with a randomly chosen failing subset by index; assert each fact reported once, `succeeded + failed === total`, failed set equals designated subset, every fact attempted (no early abort); 100+ iterations

  - [x] 8.3 Write integration tests for save_session routing and preservation
    - Verify summary stored in `sessions` (30000ms) then facts routed to `skills`/`productivity`; extraction failure preserves session; health gate blocks when unhealthy (mocked MemWal/Claude)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.6, 14.4_

- [x] 9. Implement recall_memory and shortcut tools
  - [x] 9.1 Implement recall_memory tool
    - Create `packages/mcp-server/src/tools/recall-memory.ts`: health gate → validate namespace+query → `recall` with limit (default 10, range 1–100) and maxDistance (default 0.7) → return `{blob_id, text, distance}[]` + total; empty-result message when none found
    - Define MCP JSON Schema for inputs
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 14.3, 14.4_

  - [x] 9.2 Implement my_skills and my_productivity shortcuts
    - Create `tools/my-skills.ts` and `tools/my-productivity.ts`: recall their fixed namespace, default query `"skills and technologies"` / `"productivity and output"` when query absent, limit 10, unified output format; return recall-failure error on failure
    - _Requirements: 3.1, 3.2, 3.3, 4.1, 4.2, 4.3_

  - [x] 9.3 Write unit/integration tests for recall and shortcuts
    - Test empty-result messaging (2.5), invalid-namespace/empty-query validation (2.6, 2.7), default-query substitution (3.2, 4.2), correct namespace + limit routing (2.1, 3.1, 4.1)
    - _Requirements: 2.1, 2.5, 2.6, 2.7, 3.1, 3.2, 4.1, 4.2_

- [x] 10. Implement generate_report tool
  - [x] 10.1 Implement report generation and gating
    - Create `packages/mcp-server/src/tools/generate-report.ts`: recall ≤50 from `skills` and ≤50 from `productivity`; if combined entries < 3 return not-enough-data; else `summarizeReport` via Claude; on success `remember` in `reports` and return summary; on summarization failure return error and store nothing
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [x] 10.2 Write property test for report gating
    - **Property 7: Report generation gating by entry count**
    - **Validates: Requirements 5.5**
    - Generate arbitrary skills/productivity counts; assert not-enough-data iff combined < 3, else proceeds to summarization (mocked recall/summarize); 100+ iterations

  - [x] 10.3 Write integration test for report flow
    - Verify ≤50 recalled per namespace, summarization called, stored in `reports`, summary returned; summarization failure returns error and stores nothing
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.6_

- [x] 11. Implement generate_share_info tool
  - [x] 11.1 Implement share-info generation
    - Create `packages/mcp-server/src/tools/generate-share-info.ts`: output `getPublicKeyHex()`, account ID, relayer URL, and recipient instructions (dashboard login + how to generate a separate delegate key at the staging URL); never include the private key; error when no delegate key configured
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [x] 11.2 Write property test for private-key non-leakage
    - **Property 8: Share info never leaks the delegate private key**
    - **Validates: Requirements 6.1, 6.2**
    - For any configured delegate private key, assert output never contains it as a substring while containing public key hex, account ID, and relayer URL; 100+ iterations

  - [x] 11.3 Write unit test for instructions and missing-key error
    - Verify instruction content (6.3) and missing-delegate-key error (6.4)
    - _Requirements: 6.3, 6.4_

- [x] 12. Checkpoint - MCP server complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. Implement dashboard server-side credential and recall layer
  - [x] 13.1 Implement session cookie and MemWal factory
    - Create `packages/dashboard/src/server/session.ts` (guarded with `import "server-only"`): read/write an encrypted (AES-GCM via `SESSION_SECRET`) httpOnly, Secure, SameSite=Strict cookie holding `SessionPayload`
    - Create `packages/dashboard/src/server/memwal-factory.ts` building a per-request `MemWalClient` from the decrypted session
    - _Requirements: 7.1_

  - [x] 13.2 Implement auth server action
    - Create `packages/dashboard/src/app/actions/auth.ts` (`"use server"`): `login` runs `health()` (10s), distinguishing invalid-credentials (auth-fail response) from connectivity (network/timeout); on success set the encrypted cookie; `logout` clears it
    - _Requirements: 7.1, 7.2, 7.5_

  - [x] 13.3 Implement recall server action
    - Create `packages/dashboard/src/app/actions/recall.ts` (`"use server"`): `recallNamespace` reads/decrypts the cookie, builds the client, validates namespace+query, recalls, returns `{ ok, results, total } | { ok:false, message }`
    - _Requirements: 8.1, 9.1, 10.1, 11.1, 12.2_

  - [x] 13.4 Write unit tests for auth branching and recall proxy
    - Test login success vs invalid-credentials vs connectivity (mocked client, fake timers for timeout); recall proxy returns normalized results / error union
    - _Requirements: 7.1, 7.2, 7.5_

- [x] 14. Implement dashboard display utilities and their property tests
  - [x] 14.1 Implement truncation and distance-format helpers
    - Create `packages/dashboard/src/lib/format.ts` with `truncateSession(text, max=300)` returning `{ display, isTruncated, full }` and `formatDistance(value)` returning a 2-decimal string
    - Create `packages/dashboard/src/lib/roles.ts` re-exporting shared role logic for client-safe use
    - _Requirements: 10.1, 10.2, 12.3_

  - [x] 14.2 Write property test for session truncation
    - **Property 9: Session truncation is a length-bounded prefix with no data loss**
    - **Validates: Requirements 10.1, 10.2**
    - Assert display is a prefix of original, length ≤ 300, equals original when ≤300, and full text preserved for expansion; 100+ iterations

  - [x] 14.3 Write property test for distance formatting
    - **Property 10: Distance values are formatted to two decimals**
    - **Validates: Requirements 12.3**
    - For any number in [0,1], assert output is rounded to two decimals and matches `^\d\.\d{2}$`; 100+ iterations

- [x] 15. Implement dashboard login page and layout
  - [x] 15.1 Implement login page with role selector
    - Create `packages/dashboard/src/app/login/page.tsx`: delegate key + account ID inputs + role selector (developer/team-lead/recruiter, default developer); client-side format validation (Req 7.4) and empty-field handling (Req 7.3) disabling the button; submit calls `login`; show distinct invalid-credentials vs connectivity errors preserving fields; persist role in session storage
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 13.1, 13.6_

  - [x] 15.2 Implement dashboard layout with TabBar
    - Create `packages/dashboard/src/app/(dashboard)/layout.tsx` and `components/TabBar.tsx`: render only `tabsForRole(role)`; role change re-derives tabs without reload and redirects to `defaultTabForRole`/`resolveActiveTab` when the active tab is hidden
    - _Requirements: 13.2, 13.3, 13.4, 13.5, 13.6_

  - [x] 15.3 Write component tests for login validation and tab visibility
    - Test button disable on empty/invalid fields, error distinction, role-based tab rendering, and redirect on role change (RTL + fake timers)
    - _Requirements: 7.2, 7.3, 7.4, 7.5, 13.1, 13.2, 13.3, 13.4, 13.5_

- [x] 16. Implement shared dashboard interaction components
  - [x] 16.1 Implement SearchBox and DistanceSlider
    - Create `components/SearchBox.tsx` (submit on Enter or button) and `components/DistanceSlider.tsx` (range 0.0–1.0, step 0.01, default 0.7, 300ms debounce, value shown to 2 decimals via `formatDistance`)
    - _Requirements: 8.3, 9.2, 10.3, 11.2, 12.1, 12.2, 12.3_

  - [x] 16.2 Write component tests for slider debounce and search submit
    - Verify 300ms debounce triggers exactly one re-recall with updated maxDistance and search submits on Enter/button (fake timers)
    - _Requirements: 8.3, 9.2, 12.1, 12.2_

- [x] 17. Implement dashboard tab pages and cards
  - [x] 17.1 Implement Skills and Productivity tabs
    - Create `(dashboard)/skills/page.tsx`, `(dashboard)/productivity/page.tsx` with `SkillCard.tsx` and `ProductivityCard.tsx` (fact text prominent, distance as secondary numeric); broad default query on mount (max 20); search replaces results; empty-state message; retain prior results on error
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 9.1, 9.2, 9.3, 9.4_

  - [x] 17.2 Implement Sessions and Reports tabs
    - Create `(dashboard)/sessions/page.tsx` with `SessionBlock.tsx` (≤20 entries, truncate to 300 chars via `truncateSession`, expand control, distance score) and `(dashboard)/reports/page.tsx` with `ReportBlock.tsx` (≤10 entries, full text with paragraph formatting); search updates results; empty-state messages
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 11.1, 11.2, 11.3_

  - [x] 17.3 Write component tests for tabs, cards, and error retention
    - Test card rendering, session expand, empty states, search replacement within budgets, and failed-recall keeps prior results
    - _Requirements: 8.2, 8.4, 8.5, 9.3, 9.4, 10.2, 10.4, 11.1, 11.3, 12.4_

- [x] 18. Final checkpoint - wire everything and ensure all tests pass
  - Verify the MCP server registers all six tools and connects over stdio, and the dashboard routes through server actions to the shared client end to end
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references specific requirements (granular clauses) for traceability.
- The 13 correctness properties are each implemented as a single `fast-check` property test with 100+ iterations, tagged `// Feature: dev-memory, Property N: ...`, and placed next to the code they validate.
- Property targets: P1–P5 in `@dev-memory/shared` validation/result; P11–P13 in shared roles/client; P6–P8 in MCP server tools; P9–P10 in dashboard display utilities.
- Checkpoints provide incremental validation at the end of each package.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2.1", "2.6", "3.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "2.5", "2.7", "3.2", "3.3", "4.1"] },
    { "id": 3, "tasks": ["4.2", "4.3", "6.1", "7.1", "13.1", "14.1"] },
    { "id": 4, "tasks": ["6.2", "7.2", "8.1", "9.1", "9.2", "10.1", "11.1", "13.2", "13.3", "14.2", "14.3", "15.1", "16.1"] },
    { "id": 5, "tasks": ["8.2", "8.3", "9.3", "10.2", "10.3", "11.2", "11.3", "13.4", "15.2", "16.2", "17.1", "17.2"] },
    { "id": 6, "tasks": ["15.3", "17.3"] }
  ]
}
```
