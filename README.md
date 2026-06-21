# Uberwal

Turn AI coding sessions into **portable, verifiable memory** stored on
[Walrus Memory (MemWal)](https://memory.walrus.xyz). Capture a session once and
recall it from any agent; browse, scope, and share it from a dashboard.

Uberwal is a pnpm monorepo with three packages:

| Package | What it is |
|---|---|
| `@uberwal/shared` | Pure types, validation, the `UBERWAL_META` header codec, and the `MemWalClient` wrapper used by both other packages. |
| `@uberwal/mcp-server` | An MCP server exposing 7 tools (capture, recall, report, share) backed by MemWal. |
| `@uberwal/dashboard` | A Next.js app to browse sessions, scope an assistant, and share memory. |

---

## How it works

```
        you + your AI assistant
                  │  (full session transcript)
                  ▼
        uberwal MCP server
           ├─ Extractor  ── OpenAI-compatible LLM   (turns transcript → facts)
           └─ MemWalClient ── relayer ── Walrus / Sui (append-only storage)
                  ▲
        uberwal dashboard (read / scope / share)
```

MemWal stores **one string per memory** and recall returns
`{ blob_id, text, distance }`. There is no native metadata slot, so Uberwal
prepends a compact, versioned header to the stored text and strips it back out
at recall time:

```
UBERWAL_META:v1:<base64url(JSON.stringify(meta))>\n<body>
```

The header carries `sessionId`, `type`, `index`, `repo`, and `capturedAt`.
Storage is **append-only** (no delete/overwrite). Memories live in five fixed
namespaces: `sessions`, `skills`, `productivity`, `reports`, `transcripts`.

### Key concepts

- **Session** — one capture (one `extract_session` → `commit_session` cycle),
  identified by a random `sessionId`. A session fans out into many memories
  (one summary + N skills + N productivity facts + N transcript chunks) that
  share that id.
- **Repo** — an optional, host-agnostic **project label** (e.g. the workspace
  folder name) stamped on every memory of a session, so many sessions can be
  grouped, scoped, and shared as one project. It is a tag, not a stored object,
  and not a GitHub integration.
- **capturedAt** — an epoch-ms timestamp stamped at commit time, giving every
  memory a sortable "when".

---

## The MCP tools

| Tool | Reads MemWal | LLM | Writes MemWal | Purpose |
|---|:---:|:---:|:---:|---|
| `extract_session` | — | ✓ | — | Phase 1: turn a raw transcript into a preview of candidate facts + transcript chunks. Optional `repo` tag. Stores nothing. |
| `commit_session` | — | — | ✓ | Phase 2: store the approved candidates + chunks. Includes a **secret gate** and a relayer health gate. |
| `recall_memory` | ✓ | — | — | Semantic search within one namespace. |
| `my_skills` | ✓ | — | — | Recall shortcut for the `skills` namespace. |
| `my_productivity` | ✓ | — | — | Recall shortcut for the `productivity` namespace. |
| `generate_report` | ✓ | ✓ | ✓ | Aggregate `skills` + `productivity` into one prose report stored in `reports`. |
| `generate_share_info` | — | — | — | Output the delegate public key, account id, and dashboard URL for sharing. |

**Two-phase capture** keeps a human in the loop: `extract_session` returns a
preview and writes nothing; you review it and pass the approved subset to
`commit_session`, which is the only place writes happen.

**Secret gate** (`commit_session`): before writing to permanent, append-only
storage, every candidate and transcript chunk is scanned for likely
credentials. A hit refuses the whole commit and reports masked samples (never
the raw secret). Pass `acknowledgeSecrets: true` to override once you've
confirmed a finding is a false positive.

---

## The dashboard

- **Sessions** — a session-centric list. Filter by project (repo) chips, select
  sessions, or open one to read its detail.
- **Assistant** — a reader agent scoped to the selected sessions (or a project),
  grounded strictly in recalled memories, with markdown rendering.
- **Project summary** — an on-demand synthesis across a selected project's
  sessions ("wiki-for-now").
- **Share** — mint an opaque, server-mediated share link (`/v/<token>`). The
  delegate key never reaches the browser; access is enforced server-side per a
  manifest (mode + session/repo scope). Recipients get a "Shared with me" inbox.

---

## Getting started

### Prerequisites

- Node.js >= 20 (Node 22 recommended)
- pnpm 11+
- A MemWal account (a Sui account id + an Ed25519 delegate private key) and a
  relayer URL
- An OpenAI-compatible API key for the LLM tools (`extract_session`,
  `generate_report`, and the dashboard assistant)

### Install, build, test

```bash
pnpm install
pnpm -r run build          # build all packages
pnpm -r run typecheck      # typecheck all packages
pnpm exec vitest run       # run the full test suite
```

---

## Configuration

> Secrets are never committed. `.env`, `.env.local`, `.kiro/settings/`, and
> `.data/` are all gitignored. Use placeholders below; supply real values
> locally only.

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
| `DELEGATE_KEY` | ✓ | 64-char hex Ed25519 delegate private key — signs relayer requests. |
| `ACCOUNT_ID` | ✓ | `0x`-prefixed Sui account object id. |
| `RELAYER_URL` | ✓ | Base URL of the MemWal relayer. |
| `OPENAI_API_KEY` | ✓ | API key for the LLM. Falls back to `AWS_BEARER_TOKEN_BEDROCK` when unset (for the AWS Bedrock OpenAI-compatible gateway). |
| `OPENAI_BASE_URL` | — | Override the API base URL for OpenAI-compatible endpoints. |
| `OPENAI_MODEL` | — | Model id (default `openai.gpt-oss-120b`). |

> After editing MCP source, rebuild (`pnpm --filter @uberwal/mcp-server run build`)
> and reconnect the server — clients run `dist/`.

### Dashboard (`packages/dashboard/.env.local`)

```bash
SESSION_SECRET=…32-byte hex (openssl rand -hex 32)…
RELAYER_URL=https://relayer.memory.walrus.xyz
OPENAI_API_KEY=…            # falls back to AWS_BEARER_TOKEN_BEDROCK
OPENAI_BASE_URL=…           # optional
OPENAI_MODEL=openai.gpt-oss-120b
# Sharing (on-chain delegate keys) — only needed to enable share links:
# SUI_PRIVATE_KEY=…
# MEMWAL_PACKAGE_ID=0x…
# SUI_NETWORK=mainnet        # "testnet" | "mainnet" (default testnet)
```

Run the dashboard:

```bash
pnpm --filter @uberwal/dashboard dev
```

> The relayer URL above points at **mainnet**. For development you can use the
> staging relayer (`https://relayer-staging.memory.walrus.xyz`). Note that
> accounts/keys and stored memories are network-specific: switching networks is
> a clean slate, not a migration.

---

## Security notes

- **Credentials are server-only.** The dashboard keeps the delegate key behind
  an encrypted session cookie and builds a MemWal client per request on the
  server; it never reaches the browser.
- **Shares are server-mediated.** A share link is an opaque token, not a key.
  The server resolves it and enforces a manifest (mode + session/repo scope).
- **The secret gate** blocks likely credentials from being written to permanent
  storage.
- **Nothing secret is committed.** Verify with `git check-ignore -v <file>`
  before pushing.

---

## Project structure

```
uberwal/
├── package.json                 # pnpm workspace root
├── packages/
│   ├── shared/                  # @uberwal/shared — types, validation, MemWalClient, header codec
│   ├── mcp-server/              # @uberwal/mcp-server — the 7 MCP tools
│   │   └── src/tools/           # extract-session, commit-session, recall, report, share, …
│   └── dashboard/               # @uberwal/dashboard — Next.js app (sessions, assistant, share)
│       ├── src/app/             # routes incl. /v/[token] (recipient), /s/[sessionId]
│       ├── src/components/      # SessionBlock, AssistantDrawer, ProjectSummary, SharePanel, …
│       └── src/server/          # reader-agent, share-store, memwal-factory, …
```
