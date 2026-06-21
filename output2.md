# Uberwal — Repo Axis Feature: Implementation Handoff

This document is a complete context handoff for another LLM/engineer. It
describes the **repo axis** (project-grouping) feature added across the MCP
server and the dashboard, plus exactly enough surrounding architecture to
understand it cold. Everything below is grounded in the shipped code.

---

## 1. Project at a glance

Uberwal turns AI coding sessions into portable, verifiable memory stored on
MemWal/Walrus. It is a pnpm monorepo (Node 22, TypeScript strict, vitest):

- `@uberwal/shared` — pure helpers shared by both other packages: the MemWal
  SDK wrapper (`MemWalClient`), recall normalization (`RecallEntry`), the
  metadata header codec (`memory-meta.ts`), and validation.
- `@uberwal/mcp-server` — the MCP server exposing 7 tools. Clients run the
  built `dist/`, so source edits require a rebuild + client reconnect.
- `@uberwal/dashboard` — a Next.js 15 (App Router) app to browse, scope, and
  share captured memory.

### MemWal storage model (the constraint everything is built around)

MemWal persists **one string per memory** via `remember(text, namespace)`;
`recall(...)` returns `{ blob_id, text, distance }`. There is **no native
structured-metadata slot**. Uberwal works around this by prepending a
compact, versioned header line to the stored text and stripping it back out
at recall time.

Wire format (one line, terminated by the first `\n`):

```
UBERWAL_META:v1:<base64url(JSON.stringify(meta))>\n<body>
```

Fixed namespaces (a closed union in `@uberwal/shared` `validation.ts`):
`sessions`, `skills`, `productivity`, `reports`, `transcripts`.

### The 7 MCP tools (unchanged by this feature except the two capture tools)

`extract_session`, `commit_session`, `recall_memory`, `my_skills`,
`my_productivity`, `generate_report`, `generate_share_info`. Only
`extract_session` and `generate_report` call the LLM. Capture is two-phase:
`extract_session` (preview, no writes) → `commit_session` (writes).

---

## 2. What the repo axis adds (the feature)

A new optional **`repo`** tag — a host-agnostic project label — is attached to
every stored memory so that many sessions can be grouped, scoped, and shared as
one project. It is layered on top of the existing per-session machinery
(`sessionId`) without changing the storage namespaces or the share security
boundary.

Key design facts:

- **`repo` is a soft label, not an identity.** The real unique key is
  `sessionId` (a UUID). `repo` is a convenience grouping tag.
- **`repo` is caller-supplied.** The MCP server does NOT auto-detect it (it does
  not read the filesystem, git, or its own cwd). The calling agent must pass it;
  the intended source is the workspace folder name (or a git remote's last path
  segment). When omitted, memories are stored ungrouped.
- **Backward compatible.** Every field is optional. Pre-feature memories (no
  `repo`, or no header at all) parse and render exactly as before.
- **`repo` rides inside the existing `UBERWAL_META` header**, keyed alongside
  `sessionId`. No new namespace, no DB schema column.

---

## 3. Data model changes (`@uberwal/shared`)

### `src/memory-meta.ts`

`MemoryMeta` gained an optional `repo`:

```ts
export interface MemoryMeta {
  sessionId: string;
  type?: string;   // "session" | "skill" | "productivity" | "transcript"
  index?: number;  // transcript chunk ordering
  repo?: string;   // NEW: project grouping label
}
```

**Critical gotcha:** `parseMemory` builds `meta` from known keys only, so an
unread key is silently dropped on the round-trip. `parseMemory` was updated to
explicitly read `repo`:

```ts
const repo = record["repo"];
if (typeof repo === "string" && repo.length > 0) {
  meta.repo = repo;
}
```

`encodeMemory` needed no change (it `JSON.stringify`s whatever is in the
object). The header is only emitted when a `sessionId` is present; `repo` rides
along in that same header. (Since `extract_session` always generates a
`sessionId`, `repo` always travels with it.)

### `src/result.ts`

`RecallEntry` gained `repo`, populated by `normalizeEntry` from the parsed
header:

```ts
export interface RecallEntry {
  blob_id: string;
  text: string;        // header stripped
  distance: number;
  sessionId?: string;
  index?: number;
  factType?: string;
  repo?: string;       // NEW
}
```

This is the single seam through which the dashboard sees `repo` on every
recalled memory.

---

## 4. MCP server changes (`@uberwal/mcp-server`)

### `src/tools/candidate.ts`

`CandidateFact` and `TranscriptChunk` each gained an optional `repo?: string`.

### `src/tools/extract-session.ts`

- New optional input `repo` in `EXTRACT_SESSION_INPUT_SHAPE` (Zod), with a
  description telling the caller to pass the workspace folder name / git remote
  last segment.
- New exported helper `normalizeRepo(raw)`: trims, strips `?query`/`#fragment`
  and trailing slashes, takes the **last path segment** (handles URLs,
  `git@host:org/repo.git`, and filesystem paths), drops a trailing `.git`,
  lowercases, collapses whitespace to hyphens, caps at 100 chars. Returns
  `undefined` for blank input.
- `ExtractSessionInput` gained `repo?`.
- `buildCandidates(facts, nextId, sessionId, repo)` now stamps `repo` on the
  session/skill/productivity candidates.
- The handler computes `const repo = normalizeRepo(input.repo)`, passes it to
  `buildCandidates`, and stamps it on each transcript chunk.
- The published `previewOutputShape` gained `repo?` on both the candidate and
  the transcriptChunk objects; the tool description mentions `repo`.

So the preview returned to the client carries `repo` on every candidate and
chunk, ready to be passed back to `commit_session`.

### `src/tools/commit-session.ts`

- `COMMIT_SESSION_INPUT_SHAPE` gained `repo?` on both the approved-candidate
  object and the transcriptChunk object.
- `CommitSessionInput`'s `approved[]` item type gained `repo?`.
- `commitOne` embeds `repo` into the metadata header when present:
  `encodeMemory({ sessionId, type, ...(repo ? { repo } : {}) }, baseText)`.
- `commitTranscriptChunk` does the same:
  `encodeMemory({ sessionId, type: "transcript", index, ...(repo ? { repo } : {}) }, chunk.text)`.
- The handler loop carries `repo` through when constructing each `CandidateFact`.

Unchanged ordering in `commit_session`: validate approved set → **secret gate**
(`scanForSecrets`, blocks likely credentials unless `acknowledgeSecrets: true`)
→ relayer health gate (5s) → write candidates → auto-write transcript chunks.

---

## 5. Dashboard changes (`@uberwal/dashboard`)

The dashboard already grouped/scoped by `sessionId`. The repo axis is added as a
grouping/scoping dimension on top.

### Select — `src/app/actions/recall.ts` + `src/app/page.tsx`

- `SessionSummary` gained `repo: string | null`; `listSessions` maps
  `repo: entry.repo ?? null`.
- The Sessions page (`page.tsx`):
  - derives the distinct sorted `repos` from loaded sessions;
  - renders a **"Project" filter row** (an "All" chip + one chip per repo) shown
    only when at least one session has a repo;
  - `filtered` now also narrows by the active `repoFilter`;
  - shows a **repo badge** on each session card;
  - adds a **"Select all in view"** button (selects every visible non-legacy
    session — makes "select a whole project" one click);
  - computes `selectedRepo` (the single repo shared by all selected sessions, or
    `null`) and passes it to both `SharePanel` and `AssistantDrawer`.

### Assistant — `src/server/reader-agent.ts` + `ReaderChat.tsx` + `AssistantDrawer.tsx`

- `RunReaderInput` gained `repo?`. `ReaderRecallClient` recall entries now
  include `repo?: string | null`.
- The scoped recall trigger is generalized: `scoped = sessionIds present OR repo
  present`. In scoped mode, an entry is kept when it matches the selected
  session set (if given) **AND** the repo filter (if given). Repo-only scoping
  ("ask about the whole project") is therefore supported.
- The neutral (non-persona) prompt is used whenever `scoped` is true.
- `ReaderChat` forwards `repo` into each turn; `AssistantDrawer` accepts `repo`,
  displays `repo: <x>` in the in-scope header, and passes it to `ReaderChat`.
- `src/app/actions/reader.ts` (`askReader`) is unchanged — it forwards the whole
  `RunReaderInput`, which now includes `repo`.

### Share — manifest, store, actions, recipient view

- `src/server/share-manifest.ts`: `ShareManifest` gained optional `repo?`.
- `src/server/share-store.ts`: `parseManifest` reads `repo` from the stored
  manifest JSON. **No SQLite column change** — `repo` lives inside the existing
  `manifest_json` blob.
- `src/app/actions/share.ts`: `createShare` accepts `repo?` and writes it into
  the manifest; `SharedWithMeItem` gained `repo` (surfaced in the inbox).
- `src/server/manifest-scope.ts`: `filterByManifestScope` now also enforces
  `repo` — an entry must pass ALL present filters (`blobIds`, `sessionIds`,
  `repo`). Generic constraint widened to include `repo?`.
- `src/app/actions/shared-access.ts`:
  - `ShareMetaResult` gained `repo: string | null`; `getShareMeta` returns it.
  - `listSessionsByToken` filters listed sessions by `manifest.repo` when set
    (and maps `repo` into each `SessionSummary`).
  - `askReaderByToken` derives `manifestRepo`; a repo-scoped share **always**
    reasons in scoped mode (repo-filtered) — even when the recipient selects no
    individual sessions — passing `repo` + `scopeNamespaces` to `runReader`.
    This closes a cross-project leak for repo-scoped shares.
- `src/app/v/[token]/page.tsx`: the recipient header shows a `Project: <repo>`
  badge when set.

---

## 6. End-to-end flow

```
CAPTURE (MCP, two-phase)
  extract_session({ transcript, repo? })
    → validate → sanitize (local secret redaction)
    → LLM extracts: sessionSummary, skills[] (+evidence), productivity[]
    → generate ONE sessionId (UUID)
    → repo = normalizeRepo(input.repo)            // "uberwal", or undefined
    → stamp sessionId + repo on every candidate AND every transcript chunk
    → return Preview (no writes, no health check)

  commit_session({ approved, transcriptChunks, acknowledgeSecrets? })
    → validate approved set
    → SECRET GATE (block likely credentials)
    → relayer HEALTH GATE (5s)
    → write each candidate to its namespace; auto-write chunks to transcripts
    → each stored as: UBERWAL_META:v1:<base64url({sessionId,type,index?,repo?})>\n<body>

RECALL (shared)
  client.recall(...) → normalizeRecall → normalizeEntry strips header
    → RecallEntry { blob_id, text, distance, sessionId?, index?, factType?, repo? }

DASHBOARD
  Select   : listSessions → SessionSummary{...,repo}; Project chips + badges + "Select all in view"
  Assistant: scoped to selected sessionIds (+ repo when all share one); neutral prompt; markdown
  Share    : createShare → manifest{ mode, namespaces, sessionIds, repo } → token /v/<token>
             recipient view enforces manifest server-side (namespaces + sessionIds + repo)
```

---

## 7. Where `repo` comes from (important)

- The system does **not** auto-detect it. The MCP server only consumes the
  `repo` argument; it never reads the workspace folder, git, or `process.cwd()`
  (a stdio server's cwd is the launch dir, not reliably the user's project).
- The intended source is the **workspace folder basename** (e.g. `uberwal`), or
  a git remote's last segment. Whatever is passed is slugified by
  `normalizeRepo`.
- "Filling" it can be done by the **agent automatically** (it knows the
  workspace path) or typed manually — the server does not care. There is
  currently **no enforcement**, so by default nothing fills it and memories are
  ungrouped until a caller starts sending `repo`.
- To make it reliably automatic, add a capture convention (steering) instructing
  the agent to always pass `repo = workspace folder basename`, or configure the
  MCP client to inject the workspace root.

---

## 8. Known limitations / caveats

- **Folder-name collisions.** Because `repo` is derived from a folder/last-path
  segment, two genuinely different projects with the same folder name (e.g. two
  `dashboard` folders) collide into one tag. `normalizeRepo` currently keeps
  only the last segment, even discarding the org from a git remote
  (`acme/dashboard` and `other/dashboard` both → `dashboard`), which maximizes
  collisions.
  - **Impact is bounded:** in the dashboard UI flows, shares and the assistant
    always carry the exact `sessionIds` (UUIDs) alongside `repo`, and
    `filterByManifestScope` / the reader require ALL filters to pass — so the
    UUID whitelist is the tighter bound and a name collision does **not** leak
    another project's data. The collision only (a) mixes sessions under one chip
    (cosmetic), and (b) would matter for a **repo-only** scope/share (repo with
    no `sessionIds`), a path not currently exposed by the UI.
  - **Fix options (deferred):** (1) cheap — keep `org/repo` (or host/org/repo)
    from the git remote in `normalizeRepo`; (2) robust — split a stable `repoId`
    (group/enforce) from a display `repo` label, deriving `repoId` from the
    remote URL or a folder + path/first-commit hash.
  - **Guard:** do not open a "share repo-only without sessionIds" path until a
    collision-resistant `repoId` exists.
- **Forward-looking only.** Storage is append-only (no `forget`), so existing
  memories will not retroactively gain a `repo`. The project view fills in as
  new sessions are captured.
- **MCP clients run `dist/`.** After source edits, rebuild and have clients
  reconnect to pick up the new `repo` parameter.

---

## 9. Current state & how to activate

- Old memories have no `repo` tag, and no caller is sending `repo` yet, so the
  dashboard "Project" chips stay hidden until new captures include it.
- Until then, everything behaves exactly as before (sessionId-based); the repo
  features lie dormant.
- To activate: pass `repo` (e.g. `"uberwal"`) to `extract_session` on the next
  capture — via an agent convention or by the agent reading the workspace
  folder name — then reconnect the MCP client.

---

## 10. Files changed this session

```
shared/
  src/memory-meta.ts                 MemoryMeta.repo + parseMemory reads repo
  src/result.ts                      RecallEntry.repo + normalizeEntry

mcp-server/
  src/tools/candidate.ts             CandidateFact.repo, TranscriptChunk.repo
  src/tools/extract-session.ts       repo input, normalizeRepo(), buildCandidates(repo),
                                     chunk stamping, output schema, description
  src/tools/commit-session.ts        input shapes, CommitSessionInput, encodeMemory(repo)

dashboard/
  src/app/actions/recall.ts          SessionSummary.repo + listSessions mapping
  src/app/page.tsx                   repo filter chips, badge, "Select all in view",
                                     selectedRepo → SharePanel + AssistantDrawer
  src/components/AssistantDrawer.tsx repo prop + in-scope header + pass-through
  src/components/ReaderChat.tsx      AskReader.repo, props.repo, forward in turn
  src/server/reader-agent.ts         RunReaderInput.repo, scoped repo filter, generalized scope
  src/server/share-manifest.ts       ShareManifest.repo
  src/server/share-store.ts          parseManifest reads repo (in manifest_json)
  src/app/actions/share.ts           createShare(repo) + SharedWithMeItem.repo
  src/server/manifest-scope.ts       filterByManifestScope enforces repo
  src/app/actions/shared-access.ts   ShareMetaResult.repo, listSessionsByToken repo filter,
                                     askReaderByToken repo scoping, SessionSummary mapping
  src/app/v/[token]/page.tsx         recipient "Project: <repo>" badge
  src/app/actions/recall.test.ts     SessionSummary expectation (repo: null)
  src/app/actions/shared-access.test.ts  SessionSummary expectation (repo: null)
```

---

## 11. Verification status

- `@uberwal/shared`: typecheck clean; 43 tests pass; package rebuilt
  (dashboard consumes its built types).
- `@uberwal/mcp-server`: typecheck clean; 74 tests pass; `dist/` rebuilt.
- `@uberwal/dashboard`: typecheck clean; 88 tests pass; `next build` succeeds
  (all 9 routes).

Verification commands (run from repo root):

```
pnpm --filter @uberwal/<pkg> run typecheck
pnpm exec vitest run packages/<pkg>
pnpm --filter @uberwal/shared run build
pnpm --filter @uberwal/mcp-server run build
# dashboard production build (run from packages/dashboard):
CI=1 NEXT_TELEMETRY_DISABLED=1 npx next build
```
