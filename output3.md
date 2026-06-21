# Uberwal — End-to-End System Reference (hulu → hilir)

> Purpose: give another LLM/engineer **complete** context on what Uberwal produces at every
> stage, from capturing a coding session in the MCP server (upstream) all the way to what a
> recruiter/teammate sees in the dashboard and shared links (downstream). Every claim here is
> grounded in the current source. Code/identifiers are English; this doc is descriptive, not a
> task list.

---

## 0. What Uberwal is

Uberwal turns a developer's **AI coding sessions** into **portable, verifiable memory** stored on
**Walrus Memory (MemWal)** — an append-only, decentralized memory layer addressed by a Sui account
id + Ed25519 delegate key. Two surfaces consume that memory:

- **MCP server (`@uberwal/mcp-server`)** — the *upstream*. Runs inside an AI coding client (Claude
  Code / Kiro / any MCP host). It extracts facts from a session transcript and writes them to
  MemWal. It also exposes recall/report/share tools.
- **Dashboard (`@uberwal/dashboard`)** — the *downstream*. A Next.js app where the owner browses
  captured sessions, an assistant reasons over them, and the owner shares a read-only, scoped view
  with a recruiter/teammate.

Both depend on **`@uberwal/shared`** — the SDK wrapper + data model + validation.

The product thesis is **"context-maxxing, not token-maxxing"**: capture the real substance of work
(skills with transcript-grounded evidence, productivity, full transcript) so a third party can
understand a developer's actual context, rather than counting tokens/activity.

---

## 1. Monorepo layout & tooling

```
uberwal/                      pnpm workspace (packageManager pnpm@11.1.1, Node >=20/22)
├─ packages/
│  ├─ shared/        @uberwal/shared      — SDK wrapper, data model, validation (pure, tested)
│  ├─ mcp-server/    @uberwal/mcp-server  — MCP stdio server: capture + recall + report + share-info
│  └─ dashboard/     @uberwal/dashboard   — Next.js 15 app: workspace, assistant, sharing
├─ output.md / output1.md / output2.md / output3.md   — context dumps for LLMs
└─ tsconfig.base.json   — strict TS (exactOptionalPropertyTypes, noUncheckedIndexedAccess, etc.)
```

Root scripts: `pnpm build` (recursive), `pnpm test` (vitest), `pnpm typecheck` (recursive).
`pnpm.onlyBuiltDependencies: [esbuild, sharp]`. Tests: vitest (unit + property via fast-check).

---

## 2. The data model (the contract that flows hulu → hilir)

### 2.1 Namespaces (`shared/validation.ts`)
`NAMESPACES = ["sessions", "skills", "productivity", "reports", "transcripts"]`.
- `sessions` — one summary per captured session.
- `skills` — atomic skill facts, each may carry an `Evidence:` line.
- `productivity` — atomic productivity/output observations.
- `reports` — generated prose reports (aggregated, not per-session).
- `transcripts` — chunked raw transcript (auto-stored, not a dashboard tab).

### 2.2 Memory metadata header (`shared/memory-meta.ts`) — the key cross-cutting trick
MemWal only stores **one string per memory**. To attach structure, Uberwal prepends a one-line,
versioned, base64url header to the stored text:

```
UBERWAL_META:v1:<base64url(JSON.stringify(meta))>\n<body>
```

`MemoryMeta = { sessionId, type?, index?, repo?, capturedAt? }`.
- `encodeMemory(meta, body)` writes it at commit time.
- `parseMemory(text)` strips it at recall time; **never throws**, and is a no-op for any text not
  starting with the prefix (full backward compatibility for pre-header memories / raw transcripts).

### 2.3 Normalized recall entry (`shared/result.ts`)
`normalizeRecall(raw)` defensively maps any SDK response into:
```
RecallEntry = { blob_id, text (header stripped), distance,
                sessionId?, index?, factType?, repo?, capturedAt? }
RecallResult = { results: RecallEntry[], total }
```
`distance` lower = more relevant; missing/garbage distance defaults to `1` ("unrelated" band).

### 2.4 Validation/clamping (`shared/validation.ts`)
Pure predicates: `isValidNamespace`, `isValidQuery`/`isValidTranscript` (non-whitespace),
`isValidDelegateKey` (64 hex, no 0x), `isValidAccountId` (0x + 64 hex), `clampLimit` → [1,100] dflt
10, `clampMaxDistance` → [0,1] dflt 1 (**1 = no upper-distance filter**, return all ranked matches).

### 2.5 Storage wrapper (`shared/memwal-client.ts`)
`MemWalClient` wraps `@mysten-incubation/memwal`:
- `fromCredentials({key, accountId, serverUrl, namespace})` — sync construct, no I/O.
- `isHealthy(timeoutMs=5000)` — boolean; swallows errors/timeouts. Used at startup + per-tool gate.
- `recall({query, namespace, limit?, maxDistance?})` — validates, clamps, normalizes.
- `remember(text, namespace, timeoutMs?)` — append-only `rememberAndWait`; returns `StoredRef
  {id, blob_id, namespace}`.
- `getPublicKeyHex()` — derive delegate public key (for share-info).

---

## 3. HULU — MCP capture pipeline (`@uberwal/mcp-server`)

### 3.1 Bootstrap (`index.ts`)
Loads config → builds `MemWalClient` + `Extractor` → runs a 5s **startup** health check (warn-only,
does NOT abort) → registers tools → connects **stdio** transport. stdout is reserved for JSON-RPC;
all logs go to stderr.

### 3.2 Config (`config.ts`) — required/optional env
Required: `DELEGATE_KEY` (64 hex), `ACCOUNT_ID` (0x+64 hex), `RELAYER_URL`, `OPENAI_API_KEY`
(**falls back to `AWS_BEARER_TOKEN_BEDROCK`** — the long-lived Bedrock bearer token).
Optional: `OPENAI_BASE_URL` (OpenAI-compatible gateway, e.g. in front of Bedrock), `OPENAI_MODEL`
(default `openai.gpt-oss-120b`), `DASHBOARD_URL` (default `http://localhost:3000`).
`loadConfig` aggregates ALL problems into one `ConfigError`.

### 3.3 The seven MCP tools (`tools/register.ts`)
`extract_session`, `commit_session`, `recall_memory`, `my_skills`, `my_productivity`,
`generate_report`, `generate_share_info`.

### 3.4 Two-phase capture (the core upstream flow)

**Phase 1 — `extract_session(transcript, repo?)`** (`tools/extract-session.ts`)
1. Validate transcript (non-whitespace) — no relayer health gate (extraction never writes).
2. **Local secret redaction FIRST** (`extraction/sanitize.ts`) — best-effort regex redaction of PEM
   private keys, JWTs, connection-string creds, `sk-`/`AKIA`/`gh*_` tokens, and broad
   `KEY=VALUE` where KEY looks sensitive. Runs in-process, no network. **Best-effort, not a
   guarantee.**
3. **Extract facts** via `Extractor.extractFacts` (`extraction/extractor.ts` + `prompts.ts`): one
   chat-completions call (OpenAI-compatible) → JSON `{ sessionSummary, skills:[{text, evidence?}],
   productivity:[string] }`. Parsing is defensive (strips fences, finds first balanced `{...}`,
   coerces arrays; bad JSON = extraction failure).
4. Generate **one `sessionId` per call** + normalize `repo` (`normalizeRepo`: last path segment of a
   URL/scp/path, strip `.git`, lowercase-slug, ≤100 chars).
5. `buildCandidates` → ordered `CandidateFact[]`: the single `session` candidate, then `skill`
   candidates (with `evidence`), then `productivity`. Each stamped with `sessionId` + `repo`.
6. `chunkTranscript` (`extraction/chunk.ts`): split on turn markers (`User:`/`Assistant:`/`<user>`
   etc.), size-split turns >4000 chars with 200-char overlap; each chunk stamped sessionId+repo.

**Output of `extract_session` (`Preview`)** — stores NOTHING:
```jsonc
{
  "candidates": [
    { "id": "uuid", "type": "session", "text": "...", "sessionId": "uuid", "repo": "uberwal" },
    { "id": "uuid", "type": "skill", "text": "Implemented JWT auth (TS)", "evidence": "...", "sessionId": "...", "repo": "..." },
    { "id": "uuid", "type": "productivity", "text": "Closed 3 PRs...", "sessionId": "...", "repo": "..." }
  ],
  "transcriptChunks": [ { "index": 0, "text": "...", "sessionId": "...", "repo": "..." } ]
}
```

**Phase 2 — `commit_session(approved[], transcriptChunks?, acknowledgeSecrets?)`** (`tools/commit-session.ts`)
1. Validate approved set (non-empty; every `type ∈ {session,skill,productivity}`; reports the
   offending candidate).
2. **Secret gate (P1)**: `scanForSecrets` over every text/evidence/chunk. On a hit, **blocks the
   whole commit** (append-only storage is permanent) with a masked summary — unless
   `acknowledgeSecrets: true`. (Known false positives: env-var names like `AWS_BEARER_TOKEN_BEDROCK`,
   the literal `sk-/AKIA/...` format list, code identifiers.)
3. **5s relayer health gate** — fail = store nothing.
4. Generate **one `capturedAt = Date.now()`** for the whole commit.
5. Per-candidate `remember` into the namespace matching its `type` (`session`→`sessions` with a
   **30000ms** timeout; `skill`→`skills`; `productivity`→`productivity`). Skill candidates with
   evidence get `\n\nEvidence: <snippet>` appended. Each stored text is wrapped via `encodeMemory`
   with `{sessionId, type, repo?, capturedAt}` when a sessionId is present.
6. Auto-store transcript chunks into `transcripts` (no review), header type `"transcript"` + `index`.
7. **Fail-soft**: per-item failures never abort; the result reports each outcome.

**Output of `commit_session` (`CommitSessionResult`)**:
```jsonc
{
  "outcomes": [ { "id": "...", "type": "skill", "namespace": "skills", "ok": true } ],
  "succeeded": 12, "failed": 0,
  "transcriptOutcomes": [ { "index": 0, "ok": true } ],
  "transcriptsStored": 32, "transcriptsFailed": 0
}
```

### 3.5 Recall / shortcut tools
- **`recall_memory(query, namespace, limit?, maxDistance?)`** (`tools/recall-memory.ts`): 5s health
  gate → `recall` → `{ results:[{blob_id,text,distance}], total, message? }`. Empty match returns a
  human message (still a success, no `isError`). Failures return `isError: true`.
- **`my_skills(query?)`** / **`my_productivity(query?)`**: thin recall pinned to their namespace
  (default broad query "skills and technologies" / "productivity and output").

### 3.6 `generate_report` (`tools/generate-report.ts`)
5s gate → recall up to **50** each from `skills` + `productivity` (fixed broad queries) → if combined
< 3 entries, return a **not-enough-data** payload (stores nothing) → else `Extractor.summarizeReport`
(prose, two sections) → store into `reports` → return `{ summary, blob_id }`. Note: capture writes
session/skill/productivity/transcripts; **`reports` is only written by this tool**.

### 3.7 `generate_share_info` (`tools/generate-share-info.ts`)
No relayer gate (metadata only). Derives delegate **public** key, returns `{ publicKey, accountId,
relayerUrl, dashboardUrl, instructions }`. **Never** returns the private key. Instructions tell a
recipient to log into the Uberwal dashboard with the accountId + their OWN delegate key (generated
at the MemWal dashboard `https://memory.walrus.xyz`).

---

## 4. STORAGE — Walrus Memory (MemWal)

- Append-only, decentralized; addressed by `accountId` (Sui object id) + Ed25519 `delegateKey`.
- Reached via a **relayer** (`RELAYER_URL`). Staging: `https://relayer-staging.memory.walrus.xyz`;
  mainnet: `https://relayer.memory.walrus.xyz`. The current demo runs **staging**.
- A `delegateKey` is **not** the Sui account key — it's a scoped key that can read/append to that
  account's memory. Multiple delegate keys can exist for one account (this underpins sharing).
- Because storage is permanent, the pipeline redacts secrets early and gates commits.

---

## 5. HILIR — Dashboard (`@uberwal/dashboard`, Next.js 15 App Router)

### 5.1 Auth & session (`server/session.ts`, `actions/auth.ts`, `server/memwal-factory.ts`)
- Login takes `{ delegateKey, accountId, role }`. Format-validates, then runs a live `health()` probe
  (10s budget) — distinguishes **invalid-credentials** vs **connectivity**.
- Session is an **AES-256-GCM encrypted** payload in an **httpOnly + Secure + SameSite=Strict**
  cookie (`dm_session`), keyed by `SESSION_SECRET`. The delegate key NEVER reaches client JS and is
  NOT stored in any DB.
- Every server action rebuilds a short-lived `MemWalClient` from the cookie via
  `getMemWalClientFromSession()` and discards it. `RELAYER_URL` required.

### 5.2 Owner workspace (`app/page.tsx` + `actions/recall.ts`)
- **Session-centric**: `listSessions()` recalls `sessions` (broad query, limit 50) → cards with
  title (first line) + preview + `repo` badge + short sessionId. Legacy sessions (no sessionId,
  pre-M1) render without a checkbox and can't be shared individually.
- **Repo filter chips** (distinct `repo` values) + **"Select all in view"** → one-click select a
  whole project. Client-side substring filter via `SearchBox`.
- **Selection-driven actions** (sticky bar when ≥1 selected): **Ask assistant** (`AssistantDrawer`)
  and **Share selected** (`SharePanel`). When all selected sessions share one repo, that repo is
  passed to both.
- **ProjectSummary** ("wiki-for-now"): when a repo chip is active, on-demand synthesis of the project
  via the assistant scoped to that repo.
- Session detail at `/s/<sessionId>` uses `getSessionDetail` → multi-pass
  `gatherSessionNamespace` (broad query + summary text, dedupe by blob_id, filter by sessionId;
  transcripts sorted by index). **Best-effort**, not exhaustive (semantic recall, 100/pass cap).
- Other recall actions: `recallNamespace` (single namespace) and `recallWorkspace` (fan-out across
  namespaces, resilient — one namespace failing returns an empty group, not a whole failure).

### 5.3 Assistant / Reader Agent (`server/reader-agent.ts`, `actions/reader.ts`, `components/ReaderChat.tsx`)
The assistant = **recall + reason**. Each turn recalls grounding from MemWal, then an
OpenAI-compatible chat model reasons over it under a system prompt. It never calls MemWal's own
`ask()`; Uberwal owns the full prompt.

**Presets (`ReaderPreset`)**:
- `recruiting` — recalls `skills`; recruiter persona, cite evidence.
- `productivity` — recalls `productivity` + `reports`; manager persona, anti-vanity-metrics.
- `neutral` — **no persona** ("just the facts"); recalls broadly
  `[sessions, skills, productivity, transcripts, reports]` (intersected with a share manifest on the
  share path). Added so compare/share views can answer without role-playing an evaluator.

**Two recall modes in `runReader`**:
- **Unscoped** (no sessionIds/repo): recalls the preset's namespaces across all of the viewer's
  memory; uses the preset persona.
- **Scoped** (sessionIds and/or repo present): recalls the per-session namespaces, filters to the
  selected sessions/repo, and uses a **NEUTRAL** prompt (never frames the developer as a candidate).
  `scopeNamespaces` can constrain which namespaces are read (used by the share path to honor the
  manifest — e.g. a Summary share can't surface transcripts).

**`contextNote` (provenance injection)**: `runReader` accepts an optional `contextNote` placed in the
system prompt **above** the "Context memories" block. Used by the share recipient path to feed
**non-memory** facts (share Subject, who shared it, project/repo) so the assistant can answer "what is
this about / who shared this" — facts that live in the share DB, NOT in Walrus.

`ReaderChat` is a generic chat surface taking an injectable `ask` fn (defaults to `askReader`); the
`AssistantDrawer` (owner, scoped, `showPersona=false`) and recipient/compare views reuse it. Drawer
width is `max-w-2xl`.

### 5.4 Output shape of an assistant turn (`RunReaderResult`)
`{ ok: true, reply, usedMemories: [{text, distance}] }` or `{ ok: false, message }`. The UI shows
"based on N memories".

---

## 6. SHARING subsystem (Option B: DB-only, revokable, recipient-gated)

The shipped model is **server-mediated, DB-only** (no on-chain mint, no gas, no owner wallet key).
`server/account-share.ts` (on-chain mint/revoke) remains in the repo but is **unused** by the current
flow.

### 6.1 Store (`server/share-store.ts`) — Node built-in `node:sqlite`, `.data/shares.db` (WAL)
`ShareRecord = { token, ownerAccountId, publicKeyHex (""), delegateKey (ENCRYPTED at rest),
manifest, label, sharedBy, recipientAccountId, createdAt, revokedAt }`.
- `create` (encrypts delegate key), `getByToken` (decrypts in-memory only; decryption failure =
  "not found"), `listByOwner`, `listForRecipient`, `revoke` (DB-only, instant).
- **Email ↔ account directory** table: `setEmailMapping` / `getAccountByEmail` /
  `getEmailByAccount`. Self-asserted (no email verification) — convenience directory only.

### 6.2 Create/revoke (`actions/share.ts`)
- `createShare({ mode, sessionIds?, blobIds?, label?, recipientAccountId?|recipientEmail?, repo? })`:
  reuses the owner's **logged-in delegate key** (encrypted), `publicKeyHex=""`. Recipient may be an
  account id OR an email (resolved via the directory; unresolvable email = error). `sharedBy` is
  derived from the owner's linked email, else the **full account id** (never an abbreviated `0x…`
  form). Returns only the opaque token.
- `revokeShare`: DB-only mark; server then refuses the token everywhere.
- `listSharesForMe()` → recipient inbox `SharedWithMeItem { token, mode, label, sender, sessionScoped,
  repo, createdAt }`. `sender` = linked email else full account id; a legacy stored abbreviated
  `0x…` value is detected (contains `…`) and replaced with the full account id.

### 6.3 Manifest (`server/share-manifest.ts`) + scope (`server/manifest-scope.ts`)
- `ShareMode = "summary" | "full"`. `namespacesForMode`: summary → `[sessions, skills, productivity,
  reports]`; full → those + `transcripts`.
- `ShareManifest = { mode, namespaces, blobIds?, sessionIds?, repo? }`.
- `filterByManifestScope` enforces the optional whitelists on every recipient recall: an entry must
  pass ALL present whitelists (blobIds / sessionIds / repo). No whitelist = whole allowed namespace.

### 6.4 Recipient access (`actions/shared-access.ts`) — requires NO owner session
The recipient holds only the opaque token. The server resolves it, decrypts the key for a single
request, enforces the manifest, and returns only allowed content. The key is never returned/logged.

- **`recipientGate`**: link-only shares (no `recipientAccountId`) keep bearer access; **addressed**
  shares require the viewer to be signed in as that exact account (`needsLogin` / `forbidden`).
- `getShareMeta` → `{ mode, namespaces, label, sharedBy (null when only an account id is available),
  revoked, sessionScoped, repo }`.
- `recallByToken`, `listSessionsByToken`, `getSessionDetailByToken` — manifest- + scope-enforced
  reads mirroring the owner equivalents but through the token client.
- **`askReaderByToken`** — recipient assistant. Repo-scoped shares always reason in scoped mode
  (repo-filtered). Builds a `contextNote` (Subject + "Shared by" + Project) and passes it +
  `scopeNamespaces = manifest.namespaces` to `runReader`.
- **`askCompare(tokens[], preset, messages)`** — cross-source compare. For each valid/unrevoked
  token: recall the preset∩manifest namespaces, tag each memory with a **source label**
  (`{sender} — {subject}`, sender = linked email else full account id, subject = share label), and
  build a **roster** ("Sources in this comparison (candidate — subject)") in the system prompt so the
  model knows every candidate even those with no recalled memory. Intro adapts for 1 vs many sources.
  Candidate identity/subject come from the **share DB**, not Walrus.

### 6.5 Recipient/compare UI
- `/v/[token]` (`app/v/[token]/page.tsx`): zero-setup shared view. Lists shared sessions; expanding
  one lazy-loads detail; selecting sessions opens `AssistantDrawer` via `askReaderByToken`. Falls
  back to per-namespace view when `sessions` isn't shared. "Shared by" shows the full account id (or
  email); `break-all` for clean wrapping.
- `/shared` (`app/shared/page.tsx`): "Shared with me" inbox (addressed shares). Cards show subject
  (label) + "from {sender}" (sender omitted only when truly absent). Checkboxes + sticky bar →
  **Assistant** button (enabled for **≥1** selection) opens `CompareDrawer`.
- `CompareDrawer` (`components/CompareDrawer.tsx`): titled **"Assistant"** (consistent with the main
  drawer), `max-w-2xl`, lists in-scope sources by subject, hosts `ReaderChat` wired to `askCompare`.
- `SharePanel` (`components/SharePanel.tsx`): mode (summary/full), Subject (sets `label`), "Share to"
  (account id OR email with a **Check** lookup), repo carried from selection. Produces `${origin}/v/<token>`.
- `LinkEmailCard` on `/shares`: owner links their email (self-asserted) so others can address shares
  by email.

---

## 7. End-to-end data flow (one picture)

```
Developer's AI coding session (transcript)
        │  MCP: extract_session(transcript, repo)
        ▼
[sanitize secrets] → [LLM extract facts] → Preview { candidates(+sessionId,repo,evidence), chunks }
        │  developer reviews; MCP: commit_session(approved, chunks, acknowledgeSecrets?)
        ▼
[secret gate] → [5s health gate] → encodeMemory({sessionId,type,repo,capturedAt}) → remember(...)
        ▼
WALRUS / MemWal  (append-only)   namespaces: sessions | skills | productivity | transcripts | reports
        │                                                          ▲ reports written only by generate_report
        │  delegate key + accountId
        ▼
Dashboard (owner login → encrypted cookie → per-request MemWalClient)
   • Sessions workspace (listSessions) → /s/<id> detail (gatherSessionNamespace)
   • Assistant (runReader: recall + reason; presets recruiting/productivity/neutral; scoped→neutral)
   • generate_report-style reports surfaced read-only
        │  Share selected (createShare: DB-only, reuse delegate key, manifest = mode+sessions+repo)
        ▼
Share token  /v/<token>   (SQLite share-store, encrypted key at rest, revokable instantly)
        ▼
Recipient (recruiter/teammate)
   • /v/<token> shared view (server-mediated, manifest-enforced; key never leaves server)
   • /shared inbox → select ≥1 → Assistant (askCompare) compares candidates by source label + roster
   • assistant gets a contextNote with Subject + Shared by + Project (provenance from DB, not Walrus)
```

---

## 8. Configuration & environment (quick reference)

**MCP server** (`config.ts`): `DELEGATE_KEY`, `ACCOUNT_ID`, `RELAYER_URL`, `OPENAI_API_KEY`
(or `AWS_BEARER_TOKEN_BEDROCK`), optional `OPENAI_BASE_URL`, `OPENAI_MODEL` (dflt
`openai.gpt-oss-120b`), `DASHBOARD_URL` (dflt `http://localhost:3000`). Configured per MCP host in
`.kiro/settings/mcp.json` (permission-blocked for the agent to edit; the user edits it).

**Dashboard**: `RELAYER_URL`, `SESSION_SECRET` (64-hex or passphrase), `OPENAI_API_KEY`
(or `AWS_BEARER_TOKEN_BEDROCK`), optional `OPENAI_BASE_URL`, `OPENAI_MODEL`, `SHARE_DB_PATH`
(default `.data/shares.db`). `.env.local` overrides `.env`.

---

## 9. Security model (what is protected, what isn't)

- Delegate key: stays server-side everywhere — MCP env, dashboard encrypted cookie, share-store
  encrypted-at-rest. Never sent to the browser; never logged; never in `generate_share_info` output.
- Append-only safety: local secret redaction (best-effort) + a blocking secret gate at commit.
- Shares: opaque 128-bit token; server-mediated reads; manifest + scope enforcement; addressed shares
  gated to the exact recipient account; instant DB-only revoke.
- Self-asserted limitations (flagged, demo-grade): email↔account directory has **no** email
  verification; redaction is best-effort, not a guarantee. Recall/detail are semantic + capped =
  best-effort coverage, not exhaustive listings.
- UI never displays an **abbreviated** `0x…` account id; it shows the full id (or the linked email).

---

## 10. Recent changes captured in this session (most relevant deltas)

1. **`neutral` preset** added (no-persona) across `ReaderPreset` / `PRESET_SYSTEM_PROMPTS` /
   `PRESET_NAMESPACES` and the `ReaderChat` persona selector.
2. **Compare button + drawer titled "Assistant"** (consistency); compare allows **selecting 1**
   (gate relaxed from ≥2 to ≥1); drawers widened to **`max-w-2xl`**.
3. **Candidate identity into compare prompt**: `askCompare` source label = `{sender} — {subject}`
   plus an upfront candidate **roster**, sourced from the share DB (not Walrus).
4. **Account id shown in full** (never abbreviated, never hidden); legacy abbreviated `sharedBy`
   values auto-replaced with the full account id at read time; `break-all` wrapping.
5. **`contextNote` provenance** injected into the recipient assistant (`askReaderByToken` →
   `runReader`) so Subject + "Shared by" + Project are answerable even though they aren't in Walrus.

All dashboard changes verified green: `pnpm --filter @uberwal/dashboard run typecheck` (exit 0) and
`pnpm exec vitest run packages/dashboard` (88/88). Working-tree changes are uncommitted.
