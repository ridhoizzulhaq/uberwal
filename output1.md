# How the Uberwal Dashboard Works

Companion to `output.md` (which covers the MCP server). This document explains the
dashboard (`@uberwal/dashboard`): how it is structured, how it authenticates, how each
route and server action works, how sharing and the assistant work, and where to put
configuration.

It reflects the actual code in `packages/dashboard/src`.

---

## 1. What the dashboard is

A **Next.js (App Router) + Tailwind** web app for **reading and sharing** the memories a
developer captured with the MCP server. It never captures memory itself; it recalls
from MemWal, presents it session-centrically, and lets the owner share sessions with
others.

Two audiences:

- **Owner** — signs in with their own MemWal credentials, browses their sessions, asks a
  scoped assistant, and creates/manages shares.
- **Recipient** — opens a share link (`/v/<token>`) with **zero login**; the server
  recalls on their behalf, enforcing the share's manifest.

---

## 2. Architecture & the server boundary

- **Client components** (`"use client"`) render the UI and hold interaction state.
- **Server actions** (`"use server"`) are the *only* path to MemWal. The browser never
  holds the delegate key — every recall/assistant/share call goes through an action that
  runs on the server.

```
Browser (client components)
   │  server actions (RPC)
   ▼
Server (Next.js runtime)
   ├─ getMemWalClientFromSession()  ─ recall/reason for the OWNER (cookie creds)
   ├─ share token resolution        ─ recall/reason for a RECIPIENT (no login)
   ├─ OpenAI-compatible LLM          ─ the Reader Agent
   └─ SQLite share store + Sui       ─ server-mediated sharing
```

The dashboard is **read-only into MemWal** (it never writes memories). The only writes it
performs are: the share store (local SQLite) and on-chain delegate-key mint/revoke when
creating/revoking shares.

---

## 3. Authentication & session

- **`/login`** (`app/login/page.tsx`) takes a delegate key + account id, calls the
  `login()` server action (`actions/auth.ts`), which validates format, health-checks the
  relayer, and writes an **encrypted session cookie**.
- **`server/session.ts`** `getSession()` reads + decrypts the cookie → `{ delegateKey,
  accountId }`. **`server/crypto.ts`** encrypts/decrypts with `SESSION_SECRET`.
- **`server/memwal-factory.ts`** `getMemWalClientFromSession()` builds a per-request
  `MemWalClient` from the session (delegate key + account id + `RELAYER_URL`). Returns
  `null` when unauthenticated, which actions surface as `{ ok: false, message: "Not
  authenticated" }` so pages redirect to `/login`.

The delegate key lives only on the server, only for the request.

---

## 4. Routes

| Route | Who | Purpose |
|---|---|---|
| `/login` | anyone | Sign in with delegate key + account id |
| `/` | owner | **My sessions** — session-centric workspace (list, select, share, ask) |
| `/s/[sessionId]` | owner | One session's full detail (summary, skills, productivity, transcript) |
| `/shared` | owner | **Shared with me** — shares addressed to your account id |
| `/shares` | owner | **Shared links** — manage shares you created (list + revoke) |
| `/v/[token]` | recipient | Zero-login view of a share; lists shared sessions, scoped assistant |
| `/compare` | recipient | Cross-source assistant reasoning over multiple share tokens |

The owner pages (`/`, `/shared`, `/shares`) render inside a sidebar shell; `/v/[token]`
and `/compare` are standalone (no sidebar, no auth gate).

---

## 5. The sidebar shell

**`components/DashboardShell.tsx`** is the authenticated app frame: a left sidebar with
**My sessions** (`/`), **Shared with me** (`/shared`), **Shared links** (`/shares`), and a
**Sign out** footer. Active state is derived from `usePathname()`. Owner pages wrap their
content in `<DashboardShell>`.

---

## 6. Server actions

### Recall (`actions/recall.ts`)
- `recallNamespace` — recall one namespace (auth-gated, errors returned flat).
- `recallWorkspace` — fan out one query across namespaces (resilient per-namespace).
- `listSessions` — enumerate the `sessions` namespace into `SessionSummary` rows.
- `getSessionDetail({ sessionId })` — gather a session's linked memories across
  `sessions/skills/productivity/transcripts` via the multi-pass `server/session-gather.ts`
  helper, filtered by `sessionId`. Best-effort coverage (semantic recall, not exhaustive).
- Default `maxDistance` is **1.0** (no upper-distance filter) so owners always see their data.

### Reader Agent (`actions/reader.ts` → `server/reader-agent.ts`)
- `askReader` forwards to `runReader`. `runReader` recalls context, then reasons with an
  OpenAI-compatible model.
- **Scoped mode** (when `sessionIds` are passed): recalls across the per-session
  namespaces and keeps only memories whose `sessionId` is selected → a **neutral** prompt
  (no persona). This is what the owner's session-selected assistant uses.
- **Unscoped mode**: recalls the preset's namespaces under a persona prompt (used by the
  share recipient's whole-share assistant).

### Sharing — owner (`actions/share.ts`)
- `createShare` — mints an on-chain delegate key, stores it **encrypted** with a manifest,
  returns an opaque token. Accepts optional `sharedBy` (display name) and
  `recipientAccountId` (addressed share).
- `revokeShare` — verifies ownership, removes the delegate key on-chain, marks revoked.
- `listShares` — the owner's outgoing shares (Manage shares page).
- `listSharesForMe` — shares **addressed to** the signed-in account (the "Shared with me"
  inbox); resolves the viewer's account id from the session.

### Sharing — recipient (`actions/shared-access.ts`, no session required)
- `getShareMeta` — what the recipient page may render (mode, namespaces, label, sharedBy,
  revoked, sessionScoped). Never returns the key.
- `recallByToken` / `listSessionsByToken` / `getSessionDetailByToken` — recall on the
  recipient's behalf, enforcing the manifest (`server/manifest-scope.ts` filters by
  `blobIds` / `sessionIds` whitelists).
- `askReaderByToken` — recipient assistant. Whole-share by default; when `sessionIds` are
  passed it scopes to the selected shared sessions, constrained to the manifest's
  namespaces (a Summary share can never surface transcripts).
- `askCompare` — reason across multiple share tokens at once, tagging each memory with its
  source for side-by-side comparison.

---

## 7. Components & rendering

- **`SessionDetailView`** — the four fixed sections (Summary, Skills, Productivity,
  Transcript). Reused by the owner detail page AND the recipient view.
- **Cards** — `SkillCard`, `ProductivityCard`, `SessionBlock`, `ReportBlock`,
  `TranscriptCard`. `TranscriptCard` splits a chunk into speaker segments (role Badge +
  paragraphs) instead of one wall of text.
- **`BlobProof`** — renders an entry's `blob_id` as a "Stored on Walrus" copy-to-clipboard
  affordance; the verifiable proof handle.
- **`Markdown`** — renders assistant replies (react-markdown + GFM) so tables/bold/lists
  show formatted, never as raw markdown. No raw HTML (safe by default).
- **`SharePanel`** — selection-driven share creation (mode, "Shared by", "Share to" account
  id) → `createShare` → copyable `/v/<token>` link.
- **`AssistantDrawer` + `ReaderChat`** — the assistant surface. The drawer shows the
  in-scope session titles; ReaderChat is the chat UI with an injectable `ask` (owner uses
  `askReader`, recipient uses an `askReaderByToken` closure).
- **`DistanceSlider`, `SearchBox`, `TokenNamespaceView`** and the `ui/` primitives
  (`Badge`, `Card`, `Button`, `IconBadge`, `Drawer`).

---

## 8. The assistant, end to end

- **Owner**: in `/`, select one or more sessions → "Ask assistant" → `AssistantDrawer`
  scoped to those sessions. The reader reads **only** the selected sessions' memories
  (filtered by `sessionId`) and answers **neutrally** (no recruiter/manager framing). The
  drawer lists exactly which sessions are in scope.
- **Recipient** (`/v/[token]`): select shared sessions → scoped assistant via
  `askReaderByToken` (manifest-safe). With no sessions (per-namespace fallback) a
  whole-share assistant with a persona is shown instead.
- **Compare** (`/compare`): reason across several share links together.

Honest limits: the grounding is strictly filtered to the in-scope sessions (no other
session leaks in), but coverage is best-effort (top-N then filter) and the model is
instructed — not hard-constrained — to use only the provided context.

---

## 9. Sharing model (server-mediated tokens)

- A share is created by minting a **dedicated on-chain delegate key** (`server/
  account-share.ts`, needs `SUI_PRIVATE_KEY` + `MEMWAL_PACKAGE_ID` + gas), stored
  **encrypted** in a local SQLite store (`server/share-store.ts`) alongside a manifest.
- The link carries only an opaque **token** (`/v/<token>`); the key never reaches the
  browser. The server resolves the token, decrypts the key for one request, and enforces
  the manifest.
- **Manifest** (`server/share-manifest.ts`) = mode (`summary`/`full`) → allowed
  namespaces, plus optional `blobIds` / `sessionIds` whitelists.
- **Shared by**: an owner-typed name (or short account id) shown to the recipient.
- **Shared with me**: a share addressed to a `recipientAccountId` appears in that account's
  inbox after they sign in (app-layer addressing — the token is still the access path).
- **Revoke**: removes the delegate key on-chain and marks the share revoked.

---

## 10. Theme

Minimalist warm-monochrome (`#F7F6F3` canvas, `#FFFFFF` surface, `#EAEAEA` borders,
`#111111` ink, `#787774` muted, muted pastel accents), editorial serif headings (Newsreader),
Geist sans/mono, Phosphor icons, subtle motion. No heavy shadows, gradients, or emojis.

---

## 11. Configuration — where to put `.env`

Next.js loads env from the **package root**:
`packages/dashboard/.env.local` (overrides `.env`; keep secrets here).

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` | The Reader Agent / assistant |
| `RELAYER_URL` | MemWal relayer for recall |
| `SESSION_SECRET` | Encrypts the login cookie + delegate keys in the share store |
| `SUI_PRIVATE_KEY`, `MEMWAL_PACKAGE_ID`, `SUI_NETWORK` | On-chain delegate-key mint/revoke when creating shares |
| `SHARE_DB_PATH` | Optional override for the SQLite share store path |

The owner's delegate key + account id are **not** env — they come from the login form into
an encrypted cookie. Restart `pnpm dev` after changing env.

---

## 12. Going online (limitations)

The MemWal layer is already online/decentralized; recall and sharing work regardless of
where the dashboard runs. The one thing that must change for hosted/multi-instance
deployment is the **share store**: it is local SQLite (`node:sqlite`), which breaks on
serverless (ephemeral FS) or across multiple instances. Because it sits behind the
`ShareStore` interface, swapping it for a networked DB (Postgres / Turso) is a contained
change. Also required online: a managed `SESSION_SECRET`, secret management for the Sui /
relayer / OpenAI credentials, and a gas-funded Sui account for share minting.
