# Uberwal

**Proof of your work.** Turn AI coding sessions into portable, verifiable memory
stored on [Walrus Memory (MemWal)](https://memory.walrus.xyz). Capture a session
once and recall it from any agent; browse, scope, reason over, and share it from
a dashboard.

> ## 📺 Demo & Pitch
>
> **▶ [Watch the Demo Video](https://www.youtube.com/watch?v=kZcOjDpTYU8)**
>
> **📑 [View the Pitch Deck](https://drive.google.com/file/d/1yaJMThlCvdTyS7VNokk_NhYQdr3OR81r/view?usp=sharing)**

---

## What we are solving

Vibe coding is now the default. Most developers code with an AI assistant, and a
large share of production code is already AI-written. The work is real, but the
way the industry handles it is broken.

**The industry optimized the wrong metric.** In early 2026, "token maxxing" swept
Silicon Valley: companies ran internal leaderboards ranking engineers by how many
AI tokens they burned, treating raw consumption as a proxy for productivity. At one
company the single heaviest user averaged hundreds of millions of tokens in a month,
a bill worth millions of dollars. Forbes captured the debate in [Is the cult of
'tokenmaxxing' just another fad or the new normal?](https://www.forbes.com/sites/timkeary/2026/04/13/is-the-cult-of-tokenmaxxingjust-another-fad-or-the-new-normal/)
(April 13, 2026): supporters call token volume a productivity signal, while critics
call it a vanity metric that measures activity, not results, the 2026 version of
counting lines of code.

**The pendulum is now swinging back.** As the bills landed, companies pulled back,
shifting toward measuring value instead of usage. Salesforce, for example, now
tracks "agentic work units" meant to reflect work done rather than tokens consumed.
The industry picked a vanity metric, optimized hard for it, and is now unwinding the
incentive.

Uberwal is built for where this is heading. The real question was never "how many
tokens did you burn," but "what did the work actually produce, and can anyone
trust it." That exposes three gaps:

1. **The work disappears.** The substance of an AI coding session vanishes the
   moment the session ends, leaving no lasting, portable record.
2. **Value goes uncaptured.** Tokens and activity are easy to count; the actual
   skills and output behind the work are recorded nowhere.
3. **Nothing is verifiable.** Resumes and claims can be AI-generated, so a
   teammate or recruiter has no trusted way to know what a developer actually did.

## What Uberwal does

Uberwal captures the real substance of an AI coding session (skills with
transcript-grounded evidence, productivity signals, and the full transcript),
stores it as memory the developer owns on Walrus, and lets them share a scoped,
read-only view. A teammate or recruiter can then evaluate proven work instead of
claims.

The thesis is **context-maxxing, not token-maxxing**: capture what the work
actually produced so it can be understood and verified, rather than counting
tokens or activity. As the industry pivots from maximizing token consumption to
measuring real value, Uberwal is the record of that value.

### What was built

Uberwal is a pnpm monorepo with three packages:

| Package | What it is |
|---|---|
| `@uberwal/shared` | Pure types, validation and clamping, the `UBERWAL_META` header codec, recall normalization, and the `MemWalClient` wrapper used by both other packages. |
| `@uberwal/mcp-server` | An MCP (Model Context Protocol) stdio server exposing 7 tools (capture, recall, report, share-info) backed by MemWal. Runs inside an AI coding client. |
| `@uberwal/dashboard` | A Next.js 15 app to browse sessions, reason over them with an assistant, and share a scoped, read-only view. |

> **Scope note (honest framing).** Sharing today is server-mediated and DB-only.
> An on-chain sharing path and zkLogin sign-in are on the roadmap, not yet
> shipped. Verifiability today comes from the memory itself (each fact has a
> Walrus `blob_id` anyone can check), not from the share mechanism.

---

## How it works

```
        you + your AI coding assistant
                  │  (full session transcript)
                  ▼
        uberwal MCP server  ── extract_session (preview) ─▶ you review
           ├─ Extractor  ──── OpenAI-compatible LLM   (transcript → candidate facts)
           └─ MemWalClient ── relayer ── Walrus / Sui  (append-only storage)
                  ▲                         ▲ commit_session writes the approved facts
                  │  delegate key + account id
        uberwal dashboard  (read · reason · scope · share)
                  │
                  ▼
        share token /v/<token>  ──▶  recipient (recruiter / teammate)
```

MemWal stores **one string per memory** and recall returns
`{ blob_id, text, distance }`. There is no native metadata slot, so Uberwal
prepends a compact, versioned header to the stored text and strips it back out
at recall time:

```
UBERWAL_META:v1:<base64url(JSON.stringify(meta))>\n<body>
```

The header carries `sessionId`, `type`, `index`, `repo`, and `capturedAt`. The
parser never throws and is a no-op for any text without the prefix, so memories
captured before the header existed (and raw transcript text) stay fully
compatible. Storage is **append-only**: no delete, no overwrite.

### The five namespaces

| Namespace | Holds | Written by |
|---|---|---|
| `sessions` | One summary per captured session | `commit_session` |
| `skills` | Atomic skill facts (often with an `Evidence:` line) | `commit_session` |
| `productivity` | Atomic productivity / output observations | `commit_session` |
| `transcripts` | The chunked raw transcript (auto-stored, not a dashboard tab) | `commit_session` |
| `reports` | Generated prose reports (aggregated, not per-session) | `generate_report` |

### Key concepts

- **Session.** One capture cycle (`extract_session` then `commit_session`),
  identified by a random `sessionId`. A session fans out into many memories
  (one summary, N skills, N productivity facts, N transcript chunks) that all
  share that id, so the dashboard can regroup them later.
- **Repo.** An optional, host-agnostic **project label** (for example the
  workspace folder name, normalized to a slug) stamped on every memory of a
  session, so many sessions can be grouped, scoped, and shared as one project.
  It is a tag, not a stored object, and **not** a GitHub integration.
- **capturedAt.** An epoch-ms timestamp stamped once per commit, giving every
  memory a sortable "when".
- **Delegate key vs account.** Memory is addressed by a Sui `accountId` plus an
  Ed25519 **delegate** private key. The delegate key is a scoped credential that
  can read and append to that account's memory; it is **not** the Sui wallet key.
  Multiple delegate keys can exist for one account, which is what makes
  server-mediated sharing possible.

---

## The MCP tools

| Tool | Reads | LLM | Writes | Purpose |
|---|:---:|:---:|:---:|---|
| `extract_session` | - | ✓ | - | **Phase 1:** sanitize secrets, then turn a raw transcript into a *preview* of candidate facts and transcript chunks. Optional `repo` tag. Stores nothing; no health gate. |
| `commit_session` | - | - | ✓ | **Phase 2:** store the approved candidates and chunks. Runs a **secret gate** and a 5s relayer **health gate** first. |
| `recall_memory` | ✓ | - | - | Semantic search within one namespace. |
| `my_skills` | ✓ | - | - | Recall shortcut pinned to `skills`. |
| `my_productivity` | ✓ | - | - | Recall shortcut pinned to `productivity`. |
| `generate_report` | ✓ | ✓ | ✓ | Aggregate up to 50 each from `skills` and `productivity` into one prose report stored in `reports` (needs at least 3 combined entries). |
| `generate_share_info` | - | - | - | Output the delegate **public** key, account id, relayer URL, and dashboard URL for sharing. The private key is never emitted. |

### Two-phase capture (human in the loop)

`extract_session` returns a `Preview` and writes nothing:

```jsonc
{
  "candidates": [
    { "id": "…", "type": "session",      "text": "…", "sessionId": "…", "repo": "uberwal" },
    { "id": "…", "type": "skill",        "text": "Implemented JWT auth (TS)", "evidence": "…", "sessionId": "…", "repo": "…" },
    { "id": "…", "type": "productivity", "text": "Closed 3 PRs…", "sessionId": "…", "repo": "…" }
  ],
  "transcriptChunks": [ { "index": 0, "text": "…", "sessionId": "…", "repo": "…" } ]
}
```

You review it and pass the approved subset to `commit_session`, which is the
only place writes happen. Each approved candidate is routed by `type`
(`session` goes to `sessions` with a 30s timeout, `skill` to `skills`,
`productivity` to `productivity`); transcript chunks are auto-stored into
`transcripts`. Writes are **fail-soft**: a per-item failure never aborts the
batch, and the result reports every outcome:

```jsonc
{
  "outcomes": [ { "id": "…", "type": "skill", "namespace": "skills", "ok": true } ],
  "succeeded": 12, "failed": 0,
  "transcriptOutcomes": [ { "index": 0, "ok": true } ],
  "transcriptsStored": 32, "transcriptsFailed": 0
}
```

### The secret gate

Before writing to permanent, append-only storage, `commit_session` scans every
candidate and transcript chunk for likely credentials. A hit **refuses the whole
commit** and reports masked samples (never the raw secret). Pass
`acknowledgeSecrets: true` to override once you have confirmed a finding is a
false positive. Separately, `extract_session` runs a best-effort local redaction
pass **first** in the pipeline (PEM keys, JWTs, connection-string credentials,
`sk-`/`AKIA`/`gh*_` tokens, sensitive `KEY=VALUE`), so neither the LLM nor Walrus
sees detectable secrets. Both are **best-effort, not a guarantee**, so do not
capture sessions containing real credentials.

---

## The dashboard

### Owner workspace
- **Sessions.** A session-centric list (`listSessions`). Each card shows a title,
  preview, project (`repo`) badge, and short session id. Legacy sessions
  (captured before per-session linkage) render read-only.
- **Project chips and "Select all in view".** Filter by project and one-click
  select a whole project's sessions.
- **Session detail** (`/s/<sessionId>`). Gathers a session's linked memories
  across namespaces with a multi-pass, dedup-by-blob recall. This is
  **best-effort** coverage (semantic recall, capped), not an exhaustive listing.

### Assistant (Reader Agent)
The assistant is **recall plus reason**: it recalls grounding from MemWal, then
an OpenAI-compatible model reasons over it under a system prompt. It never
delegates reasoning to MemWal's own `ask()`. Three presets:

| Preset | Recalls | Persona |
|---|---|---|
| `recruiting` | `skills` | Technical recruiter; cite evidence. |
| `productivity` | `productivity` and `reports` | Engineering manager; anti-vanity-metrics. |
| `neutral` | broad (all readable namespaces) | **No persona**, "just the facts". |

When the assistant is **scoped** to selected sessions or a project, it switches
to a neutral prompt and never frames the developer as a job candidate. For
shared views it also receives a **provenance note** (who shared it, the share
title, the project) so it can answer "whose work is this" and "what is this
about", facts that live in the share record, not in Walrus.

### Sharing (server-mediated, DB-only)

A share link is an **opaque token** (`/v/<token>`), never a key. Creating a share
stores the owner's logged-in delegate key **encrypted at rest** (AES-256-GCM) in
the share store: **Supabase (Postgres)** when configured, otherwise a local
**SQLite** file, alongside a **manifest** of what is allowed. There is **no
on-chain mint, no gas, no owner wallet key**. When a recipient opens a token, the
server resolves it, decrypts the key for a single request, enforces the manifest,
and returns only allowed content. The key never reaches the browser. Revocation
is instant and DB-only.

- **Modes.** `summary` (sessions, skills, productivity, reports) or `full`
  (those plus transcripts).
- **Scope.** A share can be narrowed to specific `sessionIds`, `blobIds`, and/or
  a `repo`; every recipient recall is filtered to that scope.
- **Addressing.** A share can be open (anyone with the link) or **addressed** to
  a recipient by account id **or email**. Addressed shares are gated: only that
  account can open the link after signing in, and it appears in their
  **"Shared with me"** inbox (`/shared`).
- **Email to account directory.** An owner can link an email to their account so
  others can address shares by email. This is **self-asserted** (no email
  verification), a convenience directory, not proof of identity.
- **Compare.** From the inbox, select one or more shares and open the
  **Assistant** to reason across them; each source is labeled by sender and share
  title so the model can attribute and compare without mixing evidence.

> An on-chain sharing path (`server/account-share.ts`) remains in the repo but is
> **unused** by the shipped DB-only flow.

---

## Getting started

### Prerequisites
- Node.js 20 or newer (Node 22 recommended)
- pnpm 11+
- A MemWal account: a Sui account id, an Ed25519 delegate private key, and a
  relayer URL
- An OpenAI-compatible API key for the LLM tools (`extract_session`,
  `generate_report`, and the dashboard assistant)

### Install, build, test
```bash
pnpm install
pnpm -r run build          # build all packages
pnpm -r run typecheck      # typecheck all packages
pnpm exec vitest run       # run the full test suite (unit + property)
```

---

## Configuration

> Secrets are never committed. `.env`, `.env.local`, `.kiro/settings/`, and
> `.data/` are all gitignored. Use placeholders below; supply real values locally
> only. Verify with `git check-ignore -v <file>` before pushing.

### MCP server (via your MCP client config, e.g. `.kiro/settings/mcp.json`)

```json
{
  "mcpServers": {
    "uberwal": {
      "command": "node",
      "args": ["/absolute/path/to/uberwal/packages/mcp-server/dist/index.js"],
      "env": {
        "DELEGATE_KEY": "…64-char hex…",
        "ACCOUNT_ID": "0x…64-char hex…",
        "RELAYER_URL": "https://relayer.memory.walrus.xyz",
        "OPENAI_API_KEY": "…",
        "OPENAI_BASE_URL": "https://…(optional, for OpenAI-compatible gateways)…",
        "OPENAI_MODEL": "openai.gpt-oss-120b"
      }
    }
  }
}
```

| Variable | Required | Purpose |
|---|:---:|---|
| `DELEGATE_KEY` | ✓ | 64-char hex Ed25519 delegate private key, signs relayer requests. |
| `ACCOUNT_ID` | ✓ | `0x`-prefixed Sui account object id. |
| `RELAYER_URL` | ✓ | Base URL of the MemWal relayer. |
| `OPENAI_API_KEY` | ✓ | API key for the LLM. **Falls back to `AWS_BEARER_TOKEN_BEDROCK`** when unset (for the AWS Bedrock OpenAI-compatible gateway). |
| `OPENAI_BASE_URL` |  | Override the API base URL for OpenAI-compatible endpoints. |
| `OPENAI_MODEL` |  | Model id (default `openai.gpt-oss-120b`). |
| `DASHBOARD_URL` |  | Dashboard URL used in `generate_share_info` (default `http://localhost:3000`). |

> After editing MCP source, rebuild (`pnpm --filter @uberwal/mcp-server run build`)
> and reconnect the server, since clients run `dist/`.

### Dashboard (`packages/dashboard/.env.local`)

```bash
SESSION_SECRET=…32-byte hex (openssl rand -hex 32) or a passphrase…
RELAYER_URL=https://relayer.memory.walrus.xyz
OPENAI_API_KEY=…            # falls back to AWS_BEARER_TOKEN_BEDROCK
OPENAI_BASE_URL=…           # optional, OpenAI-compatible gateway
OPENAI_MODEL=openai.gpt-oss-120b
# --- Share store backend ---
# Set these two to use Supabase (Postgres). Required for any serverless deploy
# (for example Vercel), where the local SQLite file does NOT persist between requests.
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=…service role key (server-only secret)…
# If the two above are unset, the dashboard falls back to local SQLite:
# SHARE_DB_PATH=.data/shares.db   # optional; default location of the SQLite store
```

| Variable | Required | Purpose |
|---|:---:|---|
| `SESSION_SECRET` | ✓ | Key for the AES-256-GCM session cookie and at-rest share encryption (64-char hex, or a passphrase derived via scrypt). |
| `RELAYER_URL` | ✓ | Base URL of the MemWal relayer (must match the network your account and keys belong to). |
| `OPENAI_API_KEY` | ✓ | API key for the assistant. Falls back to `AWS_BEARER_TOKEN_BEDROCK`. |
| `OPENAI_BASE_URL` |  | Override the API base URL. |
| `OPENAI_MODEL` |  | Model id (default `openai.gpt-oss-120b`). |
| `SUPABASE_URL` | see note | Supabase project URL. Set with the key below to use the Postgres backend. |
| `SUPABASE_SERVICE_ROLE_KEY` | see note | Supabase **service role** key (server-only). `SUPABASE_KEY` is also accepted. |
| `SHARE_DB_PATH` |  | SQLite path used only when Supabase is not configured (default `.data/shares.db`). |

> `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are required **together** to
> select the Supabase backend; with neither set the dashboard uses SQLite.

> Sharing is **DB-only**: no `SUI_PRIVATE_KEY`, `MEMWAL_PACKAGE_ID`, or gas
> required. The owner's logged-in delegate key is reused and stored **encrypted
> at rest** (AES-256-GCM via `SESSION_SECRET`), in Supabase or SQLite.

#### Supabase schema

Run this once in the Supabase SQL editor to create the two tables the share store
uses (timestamps are epoch-ms `bigint`). The service role key bypasses RLS, and
all access is enforced in app code (manifest plus recipient gating), so no RLS
policies are required for the server-mediated flow:

```sql
create table if not exists shares (
  token                text primary key,
  owner_account_id     text not null,
  public_key_hex       text not null,
  delegate_key_enc     text not null,   -- AES-256-GCM ciphertext, never plaintext
  manifest_json        text not null,
  label                text,
  shared_by            text,
  recipient_account_id text,
  created_at           bigint not null,
  revoked_at           bigint
);
create index if not exists shares_owner_idx     on shares (owner_account_id);
create index if not exists shares_recipient_idx on shares (recipient_account_id);

create table if not exists account_directory (
  email      text primary key,
  account_id text not null,
  created_at bigint not null
);
create index if not exists account_directory_account_idx on account_directory (account_id);
```

Run the dashboard:
```bash
pnpm --filter @uberwal/dashboard dev
```

> **Networks.** The examples point at the **mainnet** relayer
> (`https://relayer.memory.walrus.xyz`); staging is
> `https://relayer-staging.memory.walrus.xyz`. Accounts, keys, and stored
> memories are network-specific, so switching networks is a clean slate, not a
> migration.

---

## Security notes

- **Credentials are server-only.** The dashboard keeps the delegate key behind an
  AES-256-GCM **encrypted, httpOnly, Secure, SameSite=Strict** session cookie and
  builds a MemWal client per request on the server. The key never reaches the
  browser and is never logged.
- **Shares are server-mediated.** A share link is an opaque 128-bit token, not a
  key. The server resolves it and enforces the manifest (mode plus session and
  repo scope); addressed shares are gated to the exact recipient account.
  Revocation is instant and DB-only.
- **The secret gate** blocks likely credentials from being written to permanent
  storage; transcript redaction runs first, in-process, before the LLM or Walrus
  sees the text.
- **Best-effort, flagged limitations.** Secret redaction is pattern-based (not a
  guarantee), the email directory is self-asserted (no verification), and recall
  and session-detail are semantic and capped (best-effort coverage, not
  exhaustive listings).
- **Nothing secret is committed.** Verify with `git check-ignore -v <file>`.

---

## Project structure

```
uberwal/
├── package.json                 # pnpm workspace root (scripts: build, test, typecheck)
├── tsconfig.base.json           # strict TS shared config
├── packages/
│   ├── shared/                  # @uberwal/shared
│   │   └── src/                 #   memwal-client, memory-meta (header codec), result, validation, namespaces
│   ├── mcp-server/              # @uberwal/mcp-server
│   │   └── src/
│   │       ├── tools/           #   extract-session, commit-session, recall-memory, my-*, generate-report, generate-share-info
│   │       └── extraction/      #   extractor (LLM), prompts, sanitize, chunk, secret-scan
│   └── dashboard/               # @uberwal/dashboard, Next.js app
│       ├── src/app/             #   workspace, /s/[sessionId], /shared (inbox), /v/[token] (recipient)
│       │   └── actions/         #   auth, recall, reader, share, shared-access, directory
│       ├── src/components/      #   ReaderChat, AssistantDrawer, CompareDrawer, SharePanel, ProjectSummary, …
│       └── src/server/          #   session (encrypted cookie), memwal-factory, reader-agent, share-store (Supabase/SQLite), share-manifest, manifest-scope
```
