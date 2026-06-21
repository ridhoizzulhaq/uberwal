# How the Uberwal MCP Server Works

This document explains the internals of the Uberwal MCP server (`@uberwal/mcp-server`):
how it boots, how each of its 7 tools behaves, how the extraction pipeline turns a raw
coding session into verifiable memory, and the conventions and guarantees an agent or
developer should know before relying on it.

It reflects the actual code in `packages/mcp-server/src`.

---

## 1. What the MCP server is

The MCP server is a small Node process that exposes **tools** to any MCP client
(Claude Code, Kiro, Cursor, Claude Desktop, …) over the **Model Context Protocol**.
It is the *capture + recall* surface for Uberwal memory.

It is a **mediator**: it stores nothing itself. Behind it sit two services:

- **MemWal relayer** → Walrus/Sui — the actual append-only, content-addressed storage.
- **OpenAI-compatible LLM** — used only to turn raw transcripts into structured facts
  and to summarize reports.

```
AI client (Claude Code / Kiro / …)
        │  JSON-RPC over stdio
        ▼
uberwal-mcp  (this server)
   ├─ MemWalClient ── relayer ── Walrus / Sui      (storage)
   └─ Extractor   ── OpenAI-compatible API          (reasoning)
```

### Transport

The server speaks JSON-RPC over **stdio** (`StdioServerTransport`). The client spawns
it as a child process and exchanges messages on stdin/stdout. Because **stdout is
reserved for JSON-RPC**, all logs (startup banner, health warnings, fatal errors) go to
**stderr** via `console.error`.

It is launched from an MCP client config (`mcp.json`) — the client provides the
`command`, `args`, and `env`.

---

## 2. Startup (bootstrap)

`src/index.ts` runs this sequence in `main()`:

1. **`loadConfig()`** — read and validate environment variables.
2. **`buildMemWalClient(config)`** — construct the shared `MemWalClient` from the
   delegate key, account id, and relayer URL.
3. **`runStartupHealthCheck()`** — ping the relayer (5s timeout). A failed check only
   **logs a warning**; the server still starts (per-tool gates do the real blocking).
4. **`buildExtractor(config)`** — construct the OpenAI client (API key, model, optional
   base URL).
5. **`startServer()`** — create the `McpServer`, `registerTools()`, connect stdio.

### Configuration (`src/config.ts`)

| Variable | Required | Purpose |
|---|---|---|
| `DELEGATE_KEY` | ✅ | 64-char hex Ed25519 delegate private key — signs relayer requests |
| `ACCOUNT_ID` | ✅ | `0x`-prefixed Sui account object id |
| `RELAYER_URL` | ✅ | Base URL of the MemWal relayer |
| `OPENAI_API_KEY` | ✅ | Key for the extraction/summarization model |
| `OPENAI_BASE_URL` | ➖ | OpenAI-compatible endpoint (e.g. a Bedrock proxy) |
| `OPENAI_MODEL` | ➖ | Chat model id (default `openai.gpt-oss-120b`) |
| `DASHBOARD_URL` | ➖ | Uberwal dashboard URL for share instructions (default `http://localhost:3000`) |

`loadConfig` aggregates **every** problem it finds and throws one `ConfigError` listing
all of them, so the operator can fix the environment in a single pass.

---

## 3. The 7 tools

All tools receive an injected `ToolDeps = { memwal, extractor, config }` and return MCP
results: a JSON payload in `content[0].text` (and `structuredContent` where a typed
output schema is published). Failures are returned as `isError: true`, never thrown.

### Two-phase session capture

Capturing a session is split into **extract → review → commit** so the developer
curates what gets stored permanently.

#### `extract_session` (phase 1 — stores nothing)

Order of operations (`tools/extract-session.ts`):

1. **Validate** the transcript (reject empty/whitespace-only).
2. **Sanitize** (`extraction/sanitize.ts`) — local regex redaction of secrets, runs
   **first** so neither the model nor Walrus sees detectable secrets.
3. **Extract facts** (`extractor.extractFacts`) — one OpenAI call over the sanitized
   transcript.
4. **Wrap candidates + chunk transcript** — build `CandidateFact`s and split the
   transcript into ordered chunks.
5. Return a **`Preview`**: `{ candidates, transcriptChunks }`. **No storage.**

A single **`sessionId`** (UUID) is generated per call and stamped on every candidate and
every transcript chunk, so the downstream commit can link them all to one session.

Output shape:

```jsonc
{
  "candidates": [
    { "id": "uuid", "type": "session",      "text": "…", "sessionId": "uuid" },
    { "id": "uuid", "type": "skill",        "text": "…", "evidence": "…", "sessionId": "uuid" },
    { "id": "uuid", "type": "productivity", "text": "…", "sessionId": "uuid" }
  ],
  "transcriptChunks": [ { "index": 0, "text": "…", "sessionId": "uuid" } ]
}
```

#### `commit_session` (phase 2 — writes to MemWal)

Order of operations (`tools/commit-session.ts`):

1. **Validate** the approved set (non-empty; every `type` valid). Invalid input is
   rejected up front, naming the offending candidate, with no writes.
2. **Health gate** (5s). If the relayer is down, **nothing** is stored.
3. **Per-candidate write** via `remember`, routed by type:
   `session → sessions` (30s timeout), `skill → skills`, `productivity → productivity`.
   - A skill with `evidence` gets an `Evidence: …` line appended.
   - A candidate with a `sessionId` is wrapped with a metadata header (see §5).
   - Writes are **fail-soft**: one failure never aborts the batch.
4. **Transcript chunks** (if supplied) are stored into `transcripts` **automatically,
   without review**, with the same fail-soft behavior.

Output shape:

```jsonc
{
  "outcomes": [ { "id": "uuid", "type": "skill", "namespace": "skills", "ok": true } ],
  "succeeded": 3, "failed": 0,
  "transcriptOutcomes": [ { "index": 0, "ok": true } ],
  "transcriptsStored": 5, "transcriptsFailed": 0
}
```

> Skill/productivity facts are **review-first**; transcript chunks are **auto-committed**.

### Recall tools

#### `recall_memory`

Health gate → `memwal.recall({ query, namespace, limit≤100, maxDistance })` →
normalized entries. Empty results are a **success** (with a `message`), not an error.

```jsonc
{ "results": [ { "blob_id": "…", "text": "…", "distance": 0.42 } ], "total": 12 }
```

#### `my_skills` / `my_productivity`

Thin shortcuts over `recall_memory` pinned to the `skills` / `productivity` namespaces,
with sensible default queries.

### Reporting

#### `generate_report`

Health gate → recall up to 50 entries each from `skills` + `productivity` (parallel) →
**not-enough-data gate**: if the combined count is `< 3`, returns a success-shaped
not-enough-data payload and stores nothing → otherwise `extractor.summarizeReport`
(one OpenAI call) → store the prose in `reports` → return:

```jsonc
{ "summary": "…prose report…", "blob_id": "…" }
```

### Sharing

#### `generate_share_info`

Derives the delegate **public** key and returns the metadata a recipient needs. It
**never** contacts the relayer and **never** includes the private key.

```jsonc
{ "publicKey": "…", "accountId": "0x…", "relayerUrl": "…", "dashboardUrl": "…", "instructions": "…" }
```

---

## 4. The extraction pipeline (the only AI part)

Only **two** tools use the LLM: `extract_session` and `generate_report`. The other five
never call OpenAI. Recall "intelligence" (semantic search) lives in **MemWal**, not in
the OpenAI key.

- **`extraction/sanitize.ts`** — ordered regex passes that redact PEM private keys, JWTs,
  connection-string credentials, `sk-`/`AKIA`/`ghp_` keys, and `KEY=VALUE` secrets.
  Best-effort, local, no network.
- **`extraction/extractor.ts`** — wraps the OpenAI Chat Completions API. `extractFacts`
  parses the model response **defensively**: strip markdown fences → locate the first
  balanced `{…}` → `JSON.parse` → validate shape. A parse failure is an extraction
  failure (nothing is stored).
- **`extraction/prompts.ts`** — the system prompt asks for exactly three fields:
  - `sessionSummary` — 1–3 sentence prose overview.
  - `skills` — `{ text, evidence }[]`, where `evidence` is quoted **from the transcript**
    (or empty when there is no grounding).
  - `productivity` — `string[]` of measurable output observations.
  The prompt's discipline: prefer concrete, verifiable facts; **never invent**; under-
  extract rather than over-extract.
- **`extraction/chunk.ts`** — splits the sanitized transcript on conversation-turn
  markers (`User:`, `Assistant:`, `<assistant>`, …). A turn over ~4000 chars is split
  into overlapping windows (200-char overlap) so context isn't lost at seams.

**Every stored fact is downstream of the transcript.** A summary fed in place of the
real dialogue yields shallow facts and ungrounded evidence — see §6.

---

## 5. Namespaces and per-session linkage

Five namespaces: **`sessions`, `skills`, `productivity`, `reports`, `transcripts`**.

MemWal stores a single string per memory and returns `{ blob_id, text, distance }` on
recall — there is no native metadata slot. To record *which session* a memory came from,
Uberwal embeds a compact header inside the stored text (`@uberwal/shared`
`memory-meta.ts`):

```
UBERWAL_META:v1:<base64url(JSON{ sessionId, type, index? })>\n<original body>
```

- `encodeMemory(meta, body)` adds the header at commit time.
- `parseMemory(text)` strips it at recall time and recovers `{ sessionId, type, index }`.
  It **never throws** and is a no-op for text without the prefix (backward compatible).

This is how the dashboard groups everything from one capture under a single session
(`/s/<sessionId>`). Memories captured before this feature have no header and simply
appear ungrouped ("legacy").

`blob_id` (one per stored memory, the Walrus content address) is distinct from
`sessionId` (shared across all memories of one capture).

---

## 6. Capture convention (what to send to `extract_session`)

The server chunks and stores **whatever transcript string it receives** — it cannot
enforce quality. So the capturing agent must send the right thing. This convention is
published in the `extract_session` tool/parameter **descriptions**, so it reaches every
MCP client (not just Kiro):

- Send the **full, raw, verbatim dialogue** from session start to now — **not a summary,
  not truncated**.
- Preserve turn markers (`User:` / `Assistant:`) so chunking is correct.
- **Include the technical substance** of each turn: file paths with key code/diff
  snippets, commands with their results, and errors with how they were fixed. This is
  what makes stored skills verifiable back to real work.
- **Exclude IDE scaffolding** (environment/context blocks, open-file lists, rule blocks)
  — those are not conversation.

---

## 7. Design principles (consistent across tools)

1. **stdout is sacred** for JSON-RPC; all logs go to stderr.
2. **5-second health gate** before any relayer operation; `generate_share_info` is
   metadata-only and skips it.
3. **Fail-soft + per-item reporting** — one failure never aborts a batch; failures are
   returned as `isError`, never thrown.
4. **Append-only storage** — writes to Walrus cannot be edited or deleted. This is why
   sanitization runs first and why the convention warns against capturing credentials.
5. **Dependency injection** — `{ memwal, extractor, config }` is injected, so every tool
   is testable with in-memory fakes (no network).

---

## 8. Security notes

- Secret redaction is **best-effort** regex, not a guarantee. Because storage is
  permanent and append-only, **do not capture sessions containing real credentials**.
- The delegate **private** key never leaves the server: it signs relayer requests and is
  never returned by any tool (including `generate_share_info`).
- Treat the transcript and all external content as untrusted input.
