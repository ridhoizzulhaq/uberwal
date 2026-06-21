import "server-only";

/**
 * Persistent store for server-mediated shares.
 *
 * Each share couples three things the recipient never sees directly:
 *   1. the owner's delegate *private* key (encrypted at rest), used server-side
 *      to recall on the recipient's behalf;
 *   2. a {@link ShareManifest} describing exactly what is allowed; and
 *   3. status (created / revoked) plus the (legacy) `publicKeyHex` handle.
 *
 * A share link carries only the random opaque `token`. The server resolves the
 * token here, decrypts the key in memory for a single request, and enforces the
 * manifest — so access is truly server-side and a leaked link cannot be used to
 * extract the key.
 *
 * The store is exposed behind the {@link ShareStore} interface so call sites
 * depend on the contract, not the engine. Two backends ship:
 *
 *   - **{@link SupabaseShareStore}** (Postgres via `@supabase/supabase-js`) —
 *     used when `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are configured.
 *     This is the production backend: a hosted database persists across
 *     serverless invocations (e.g. on Vercel, where a local SQLite file would
 *     not survive between requests).
 *   - **{@link SqliteShareStore}** (Node's built-in `node:sqlite`) — the
 *     zero-config fallback for local development and the test suite when no
 *     Supabase credentials are present.
 *
 * The interface is **asynchronous** (every method returns a `Promise`) because
 * Supabase access is network I/O. The SQLite backend satisfies the same async
 * contract over synchronous calls.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

import type { DatabaseSync } from "node:sqlite";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { decryptSecret, encryptSecret } from "./crypto.js";
import type { ShareManifest } from "./share-manifest.js";

/**
 * Generate a random opaque share token.
 *
 * 16 random bytes encoded as base64url give a 22-character, URL-safe token
 * with 128 bits of entropy — long enough that tokens are unguessable, short
 * enough to sit comfortably in a `/v/<token>` path. The token carries no
 * secret material itself; it is only a lookup handle into the store.
 */
export function newShareToken(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * A fully-resolved share record.
 *
 * `delegateKey` is the DECRYPTED private key and exists only in memory after a
 * successful {@link ShareStore.getByToken}; it is never part of the public
 * summary and never leaves the server boundary.
 */
export interface ShareRecord {
  /** Random opaque token that appears in the share link. */
  token: string;
  /** `0x`-prefixed account object id the share reads from. */
  ownerAccountId: string;
  /** Delegate public key (hex) — legacy on-chain revoke handle; `""` for DB-only shares. */
  publicKeyHex: string;
  /** Decrypted delegate private key (hex). Server-only, in-memory only. */
  delegateKey: string;
  /** What the recipient is allowed to see. */
  manifest: ShareManifest;
  /** Human-readable label for the share, or `null`. */
  label: string | null;
  /** Display name of the person who created the share ("shared by"), or `null`. */
  sharedBy: string | null;
  /**
   * Account id this share is addressed to, or `null` for a link-only share.
   * When set, the share appears in that account's "Shared with me" inbox.
   */
  recipientAccountId: string | null;
  /** Creation time (epoch ms). */
  createdAt: number;
  /** Revocation time (epoch ms), or `null` while active. */
  revokedAt: number | null;
}

/**
 * Input accepted by {@link ShareStore.create}.
 *
 * `delegateKey` is the PLAINTEXT private key; the store encrypts it with
 * {@link encryptSecret} before writing. `createdAt` defaults to now when
 * omitted; `revokedAt` is always `null` for a freshly created share.
 */
export interface NewShareRecord {
  token: string;
  ownerAccountId: string;
  publicKeyHex: string;
  delegateKey: string;
  manifest: ShareManifest;
  label: string | null;
  /** Display name of the person who created the share, or `null`. */
  sharedBy?: string | null;
  /** Account id this share is addressed to, or `null`/omitted for link-only. */
  recipientAccountId?: string | null;
  /** Optional explicit creation time (epoch ms); defaults to `Date.now()`. */
  createdAt?: number;
}

/**
 * Public, key-free view of a share for owner listings.
 *
 * Deliberately omits `publicKeyHex` and `delegateKey` so a listing can never
 * leak credentials or the revoke handle to a client surface.
 */
export interface ShareSummary {
  token: string;
  /**
   * `0x`-prefixed account object id that sent the share. Included so the
   * recipient inbox can attribute a share to its sender; it is a public object
   * id, not a credential. The delegate key and on-chain handle are still omitted.
   */
  ownerAccountId: string;
  manifest: ShareManifest;
  label: string | null;
  sharedBy: string | null;
  recipientAccountId: string | null;
  createdAt: number;
  revokedAt: number | null;
}

/**
 * The storage contract the rest of the app depends on.
 *
 * Every method is asynchronous so a network-backed engine (Supabase) and a
 * synchronous engine (SQLite) can both satisfy it. Read methods degrade
 * gracefully on infrastructure errors (returning `null` / `[]` after logging
 * server-side) so a transient outage surfaces as "not found" rather than an
 * unhandled rejection; write methods throw so their (already try/catch-wrapped)
 * callers can report the failure.
 */
export interface ShareStore {
  /** Persist a new share, encrypting the delegate key at rest. */
  create(rec: NewShareRecord): Promise<void>;
  /**
   * Resolve a token to its full record (with the DECRYPTED key) or `null` when
   * the token is unknown or the stored key cannot be decrypted.
   */
  getByToken(token: string): Promise<ShareRecord | null>;
  /** List an owner's shares as key-free summaries, newest first. */
  listByOwner(ownerAccountId: string): Promise<ShareSummary[]>;
  /** List shares ADDRESSED to a recipient account, newest first (their inbox). */
  listForRecipient(recipientAccountId: string): Promise<ShareSummary[]>;
  /** Mark a share revoked (idempotent; no-op for unknown tokens). */
  revoke(token: string): Promise<void>;
  /**
   * Link an email to an account id (insert or replace). Self-asserted by the
   * logged-in owner — there is no email verification, so callers must treat the
   * mapping as a convenience directory, not proof of email ownership.
   */
  setEmailMapping(email: string, accountId: string): Promise<void>;
  /** Resolve an email to its account id, or `null` if unmapped. */
  getAccountByEmail(email: string): Promise<string | null>;
  /** Reverse lookup: the most recent email mapped to an account id, or `null`. */
  getEmailByAccount(accountId: string): Promise<string | null>;
}

/**
 * Shape of a `shares` table row. Both backends use these snake_case column
 * names, so the row-mapping helpers below are shared.
 */
interface ShareRow {
  token: string;
  owner_account_id: string;
  public_key_hex: string;
  delegate_key_enc: string;
  manifest_json: string;
  label: string | null;
  shared_by: string | null;
  recipient_account_id: string | null;
  created_at: number | string;
  revoked_at: number | string | null;
}

/** Coerce a possibly-stringified epoch (Postgres bigint via PostgREST) to a number. */
function toEpoch(value: number | string): number {
  return typeof value === "number" ? value : Number(value);
}

/**
 * Map a raw row to a fully-resolved {@link ShareRecord}, DECRYPTING the key.
 *
 * Returns `null` when the key cannot be decrypted (tampered row, wrong/rotated
 * `SESSION_SECRET`) or the manifest is corrupt, so an unusable row degrades to
 * "not found" rather than handing back a record without a live key.
 */
function rowToRecord(row: ShareRow): ShareRecord | null {
  const delegateKey = decryptSecret(row.delegate_key_enc);
  if (delegateKey === null) return null;
  const manifest = parseManifest(row.manifest_json);
  if (manifest === null) return null;
  return {
    token: row.token,
    ownerAccountId: row.owner_account_id,
    publicKeyHex: row.public_key_hex,
    delegateKey,
    manifest,
    label: row.label,
    sharedBy: row.shared_by ?? null,
    recipientAccountId: row.recipient_account_id ?? null,
    createdAt: toEpoch(row.created_at),
    revokedAt: row.revoked_at === null ? null : toEpoch(row.revoked_at),
  };
}

/** Map a raw row to a key-free {@link ShareSummary}, dropping a corrupt manifest. */
function rowToSummary(row: ShareRow): ShareSummary | null {
  const manifest = parseManifest(row.manifest_json);
  if (manifest === null) return null;
  return {
    token: row.token,
    ownerAccountId: row.owner_account_id,
    manifest,
    label: row.label,
    sharedBy: row.shared_by ?? null,
    recipientAccountId: row.recipient_account_id ?? null,
    createdAt: toEpoch(row.created_at),
    revokedAt: row.revoked_at === null ? null : toEpoch(row.revoked_at),
  };
}

/** Map many rows to summaries, dropping any with a corrupt manifest. */
function rowsToSummaries(rows: ShareRow[]): ShareSummary[] {
  const summaries: ShareSummary[] = [];
  for (const row of rows) {
    const summary = rowToSummary(row);
    if (summary !== null) summaries.push(summary);
  }
  return summaries;
}

/**
 * Resolve the SQLite file path.
 *
 * `SHARE_DB_PATH` overrides the location (tests point it at a tmp file). The
 * default is `.data/shares.db` resolved against `process.cwd()`, which is
 * `packages/dashboard/.data/shares.db` when the dashboard runs from its own
 * package directory. The parent `.data` directory is created if missing.
 */
function resolveDbPath(): string {
  const override = process.env["SHARE_DB_PATH"];
  const target =
    typeof override === "string" && override.length > 0
      ? path.resolve(process.cwd(), override)
      : path.resolve(process.cwd(), ".data", "shares.db");
  mkdirSync(path.dirname(target), { recursive: true });
  return target;
}

/**
 * Concrete `@supabase/supabase-js`-backed implementation of {@link ShareStore}.
 *
 * Uses the **service role** key (server-only) so the dashboard's own app-layer
 * checks (manifest enforcement, recipient gating in `shared-access.ts`) are the
 * authority — not Postgres RLS. The key must never reach the browser; this
 * module is `server-only`.
 */
class SupabaseShareStore implements ShareStore {
  private readonly db: SupabaseClient;

  constructor(url: string, key: string) {
    this.db = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async create(rec: NewShareRecord): Promise<void> {
    const { error } = await this.db.from("shares").insert({
      token: rec.token,
      owner_account_id: rec.ownerAccountId,
      public_key_hex: rec.publicKeyHex,
      delegate_key_enc: encryptSecret(rec.delegateKey),
      manifest_json: JSON.stringify(rec.manifest),
      label: rec.label,
      shared_by: rec.sharedBy ?? null,
      recipient_account_id: rec.recipientAccountId ?? null,
      created_at: rec.createdAt ?? Date.now(),
      revoked_at: null,
    });
    if (error !== null) {
      throw new Error(`Failed to store share: ${error.message}`);
    }
  }

  async getByToken(token: string): Promise<ShareRecord | null> {
    try {
      const { data, error } = await this.db
        .from("shares")
        .select("*")
        .eq("token", token)
        .maybeSingle();
      if (error !== null) throw new Error(error.message);
      if (data === null) return null;
      return rowToRecord(data as ShareRow);
    } catch (err) {
      console.error("[share-store] Supabase getByToken failed:", err);
      return null;
    }
  }

  async listByOwner(ownerAccountId: string): Promise<ShareSummary[]> {
    try {
      const { data, error } = await this.db
        .from("shares")
        .select("*")
        .eq("owner_account_id", ownerAccountId)
        .order("created_at", { ascending: false });
      if (error !== null) throw new Error(error.message);
      return rowsToSummaries((data ?? []) as ShareRow[]);
    } catch (err) {
      console.error("[share-store] Supabase listByOwner failed:", err);
      return [];
    }
  }

  async listForRecipient(recipientAccountId: string): Promise<ShareSummary[]> {
    try {
      const { data, error } = await this.db
        .from("shares")
        .select("*")
        .eq("recipient_account_id", recipientAccountId)
        .order("created_at", { ascending: false });
      if (error !== null) throw new Error(error.message);
      return rowsToSummaries((data ?? []) as ShareRow[]);
    } catch (err) {
      console.error("[share-store] Supabase listForRecipient failed:", err);
      return [];
    }
  }

  async revoke(token: string): Promise<void> {
    const { error } = await this.db
      .from("shares")
      .update({ revoked_at: Date.now() })
      .eq("token", token)
      .is("revoked_at", null);
    if (error !== null) {
      throw new Error(`Failed to revoke share: ${error.message}`);
    }
  }

  async setEmailMapping(email: string, accountId: string): Promise<void> {
    const { error } = await this.db
      .from("account_directory")
      .upsert(
        { email, account_id: accountId, created_at: Date.now() },
        { onConflict: "email" },
      );
    if (error !== null) {
      throw new Error(`Failed to save email mapping: ${error.message}`);
    }
  }

  async getAccountByEmail(email: string): Promise<string | null> {
    try {
      const { data, error } = await this.db
        .from("account_directory")
        .select("account_id")
        .eq("email", email)
        .maybeSingle();
      if (error !== null) throw new Error(error.message);
      return (data as { account_id: string } | null)?.account_id ?? null;
    } catch (err) {
      console.error("[share-store] Supabase getAccountByEmail failed:", err);
      return null;
    }
  }

  async getEmailByAccount(accountId: string): Promise<string | null> {
    try {
      const { data, error } = await this.db
        .from("account_directory")
        .select("email")
        .eq("account_id", accountId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error !== null) throw new Error(error.message);
      return (data as { email: string } | null)?.email ?? null;
    } catch (err) {
      console.error("[share-store] Supabase getEmailByAccount failed:", err);
      return null;
    }
  }
}

/** Concrete `node:sqlite`-backed implementation of {@link ShareStore}. */
class SqliteShareStore implements ShareStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    // Load the SQLite builtin via `process.getBuiltinModule` rather than a
    // static `import`, so bundlers (Vite/Vitest, Next/webpack) never try to
    // resolve the newer `node:sqlite` specifier — it is read straight from the
    // running Node binary at construction time.
    const sqlite = process.getBuiltinModule(
      "node:sqlite",
    ) as typeof import("node:sqlite");
    this.db = new sqlite.DatabaseSync(dbPath);
    // WAL improves read/write concurrency and is the recommended journal mode
    // for an embedded app database that may see concurrent server actions.
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS shares (
        token TEXT PRIMARY KEY,
        owner_account_id TEXT NOT NULL,
        public_key_hex TEXT NOT NULL,
        delegate_key_enc TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        label TEXT,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      )`,
    );
    // Migration: add the `shared_by` column to databases created before the
    // "shared by" feature. ADD COLUMN is a no-op-safe migration (default NULL
    // for existing rows); guarded so re-running on an up-to-date schema is fine.
    const columns = this.db
      .prepare(`PRAGMA table_info(shares)`)
      .all() as unknown as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "shared_by")) {
      this.db.exec(`ALTER TABLE shares ADD COLUMN shared_by TEXT`);
    }
    // Migration: add `recipient_account_id` for addressed ("Shared with me")
    // shares. Same no-op-safe ADD COLUMN guard.
    if (!columns.some((c) => c.name === "recipient_account_id")) {
      this.db.exec(`ALTER TABLE shares ADD COLUMN recipient_account_id TEXT`);
    }
    // Email ↔ account directory: lets a share be addressed by email (resolved
    // to an account id at create time). `email` is the primary key so a
    // re-registration updates the mapping in place.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS account_directory (
        email TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
  }

  async create(rec: NewShareRecord): Promise<void> {
    const createdAt = rec.createdAt ?? Date.now();
    const delegateKeyEnc = encryptSecret(rec.delegateKey);
    const manifestJson = JSON.stringify(rec.manifest);
    this.db
      .prepare(
        `INSERT INTO shares (
          token, owner_account_id, public_key_hex, delegate_key_enc,
          manifest_json, label, shared_by, recipient_account_id, created_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.token,
        rec.ownerAccountId,
        rec.publicKeyHex,
        delegateKeyEnc,
        manifestJson,
        rec.label,
        rec.sharedBy ?? null,
        rec.recipientAccountId ?? null,
        createdAt,
        null,
      );
  }

  async getByToken(token: string): Promise<ShareRecord | null> {
    const row = this.db
      .prepare(`SELECT * FROM shares WHERE token = ?`)
      .get(token) as unknown as ShareRow | undefined;
    if (row === undefined) return null;
    return rowToRecord(row);
  }

  async listByOwner(ownerAccountId: string): Promise<ShareSummary[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM shares WHERE owner_account_id = ? ORDER BY created_at DESC`,
      )
      .all(ownerAccountId) as unknown as ShareRow[];
    return rowsToSummaries(rows);
  }

  async listForRecipient(recipientAccountId: string): Promise<ShareSummary[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM shares WHERE recipient_account_id = ? ORDER BY created_at DESC`,
      )
      .all(recipientAccountId) as unknown as ShareRow[];
    return rowsToSummaries(rows);
  }

  async revoke(token: string): Promise<void> {
    this.db
      .prepare(`UPDATE shares SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL`)
      .run(Date.now(), token);
  }

  async setEmailMapping(email: string, accountId: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO account_directory (email, account_id, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET account_id = excluded.account_id,
                                          created_at = excluded.created_at`,
      )
      .run(email, accountId, Date.now());
  }

  async getAccountByEmail(email: string): Promise<string | null> {
    const row = this.db
      .prepare(`SELECT account_id FROM account_directory WHERE email = ?`)
      .get(email) as unknown as { account_id: string } | undefined;
    return row?.account_id ?? null;
  }

  async getEmailByAccount(accountId: string): Promise<string | null> {
    const row = this.db
      .prepare(
        `SELECT email FROM account_directory WHERE account_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(accountId) as unknown as { email: string } | undefined;
    return row?.email ?? null;
  }
}

/**
 * Parse a stored manifest JSON string back into a {@link ShareManifest}.
 *
 * Returns `null` on malformed JSON or a structurally invalid manifest so a
 * corrupt row degrades to "unavailable" rather than throwing.
 */
function parseManifest(json: string): ShareManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const mode = obj["mode"];
  const namespaces = obj["namespaces"];
  if (mode !== "full" && mode !== "summary") return null;
  if (!Array.isArray(namespaces)) return null;
  const manifest: ShareManifest = {
    mode,
    namespaces: namespaces.filter((n): n is ShareManifest["namespaces"][number] => typeof n === "string") as ShareManifest["namespaces"],
  };
  const blobIds = obj["blobIds"];
  if (Array.isArray(blobIds)) {
    manifest.blobIds = blobIds.filter((b): b is string => typeof b === "string");
  }
  const sessionIds = obj["sessionIds"];
  if (Array.isArray(sessionIds)) {
    manifest.sessionIds = sessionIds.filter(
      (s): s is string => typeof s === "string",
    );
  }
  const repo = obj["repo"];
  if (typeof repo === "string" && repo.length > 0) {
    manifest.repo = repo;
  }
  return manifest;
}

/** Lazily-initialized singleton, rebuilt when the active backend changes (tests). */
let singleton: { kind: string; store: ShareStore } | null = null;

/**
 * Return the process-wide {@link ShareStore} singleton.
 *
 * Backend selection (read fresh each call so tests and deploys can switch):
 *   - **Supabase** when both `SUPABASE_URL` and a key
 *     (`SUPABASE_SERVICE_ROLE_KEY`, or `SUPABASE_KEY`) are set. This is the
 *     production path — a hosted DB that survives serverless invocations.
 *   - **SQLite** otherwise — the zero-config local/dev/test fallback. If
 *     `SHARE_DB_PATH` changes between calls (as in tests pointing at a fresh
 *     tmp file), a new store is created for the new path so tests stay isolated.
 */
export function getShareStore(): ShareStore {
  const supabaseUrl = process.env["SUPABASE_URL"];
  const supabaseKey =
    process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? process.env["SUPABASE_KEY"];
  if (
    typeof supabaseUrl === "string" &&
    supabaseUrl.length > 0 &&
    typeof supabaseKey === "string" &&
    supabaseKey.length > 0
  ) {
    const kind = `supabase:${supabaseUrl}`;
    if (singleton !== null && singleton.kind === kind) {
      return singleton.store;
    }
    const store = new SupabaseShareStore(supabaseUrl, supabaseKey);
    singleton = { kind, store };
    return store;
  }

  const dbPath = resolveDbPath();
  const kind = `sqlite:${dbPath}`;
  if (singleton !== null && singleton.kind === kind) {
    return singleton.store;
  }
  const store = new SqliteShareStore(dbPath);
  singleton = { kind, store };
  return store;
}
