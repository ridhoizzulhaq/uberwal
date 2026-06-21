import "server-only";

/**
 * Persistent store for server-mediated shares.
 *
 * Each share couples three things the recipient never sees directly:
 *   1. the minted delegate *private* key (encrypted at rest), used server-side
 *      to recall on the recipient's behalf;
 *   2. a {@link ShareManifest} describing exactly what is allowed; and
 *   3. status (created / revoked) plus the on-chain `publicKeyHex` revoke
 *      handle.
 *
 * A share link carries only the random opaque `token`. The server resolves the
 * token here, decrypts the key in memory for a single request, and enforces the
 * manifest — so access is truly server-side and a leaked link cannot be used to
 * extract the key.
 *
 * The store is exposed behind the {@link ShareStore} interface so call sites
 * depend on the contract, not on the engine. The shipped implementation is
 * backed by Node's built-in `node:sqlite` (`DatabaseSync`) — no native module
 * to compile, so it works under any Node version that ships SQLite.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

import type { DatabaseSync } from "node:sqlite";

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
  /** Delegate public key (hex) — the on-chain revoke handle. */
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
 * Deliberately omits `ownerAccountId`, `publicKeyHex`, and `delegateKey` so a
 * listing can never leak credentials or the revoke handle to a client surface.
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

/** The storage contract the rest of the app depends on. */
export interface ShareStore {
  /** Persist a new share, encrypting the delegate key at rest. */
  create(rec: NewShareRecord): void;
  /**
   * Resolve a token to its full record (with the DECRYPTED key) or `null` when
   * the token is unknown or the stored key cannot be decrypted.
   */
  getByToken(token: string): ShareRecord | null;
  /** List an owner's shares as key-free summaries, newest first. */
  listByOwner(ownerAccountId: string): ShareSummary[];
  /** List shares ADDRESSED to a recipient account, newest first (their inbox). */
  listForRecipient(recipientAccountId: string): ShareSummary[];
  /** Mark a share revoked (idempotent; no-op for unknown tokens). */
  revoke(token: string): void;
  /**
   * Link an email to an account id (insert or replace). Self-asserted by the
   * logged-in owner — there is no email verification, so callers must treat the
   * mapping as a convenience directory, not proof of email ownership.
   */
  setEmailMapping(email: string, accountId: string): void;
  /** Resolve an email to its account id, or `null` if unmapped. */
  getAccountByEmail(email: string): string | null;
  /** Reverse lookup: the most recent email mapped to an account id, or `null`. */
  getEmailByAccount(accountId: string): string | null;
}

/** Shape of a `shares` table row as returned by better-sqlite3. */
interface ShareRow {
  token: string;
  owner_account_id: string;
  public_key_hex: string;
  delegate_key_enc: string;
  manifest_json: string;
  label: string | null;
  shared_by: string | null;
  recipient_account_id: string | null;
  created_at: number;
  revoked_at: number | null;
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

  create(rec: NewShareRecord): void {
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

  getByToken(token: string): ShareRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM shares WHERE token = ?`)
      .get(token) as unknown as ShareRow | undefined;
    if (row === undefined) return null;

    // Decrypt the delegate key in memory only. A decryption failure (tampered
    // row, wrong/rotated SESSION_SECRET) makes the share unusable, so we report
    // it as "not found" rather than handing back a record without a live key.
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
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    };
  }

  listByOwner(ownerAccountId: string): ShareSummary[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM shares WHERE owner_account_id = ? ORDER BY created_at DESC`,
      )
      .all(ownerAccountId) as unknown as ShareRow[];
    return this.rowsToSummaries(rows);
  }

  listForRecipient(recipientAccountId: string): ShareSummary[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM shares WHERE recipient_account_id = ? ORDER BY created_at DESC`,
      )
      .all(recipientAccountId) as unknown as ShareRow[];
    return this.rowsToSummaries(rows);
  }

  /** Map raw rows to key-free summaries, dropping any with a corrupt manifest. */
  private rowsToSummaries(rows: ShareRow[]): ShareSummary[] {
    const summaries: ShareSummary[] = [];
    for (const row of rows) {
      const manifest = parseManifest(row.manifest_json);
      if (manifest === null) continue;
      summaries.push({
        token: row.token,
        ownerAccountId: row.owner_account_id,
        manifest,
        label: row.label,
        sharedBy: row.shared_by ?? null,
        recipientAccountId: row.recipient_account_id ?? null,
        createdAt: row.created_at,
        revokedAt: row.revoked_at,
      });
    }
    return summaries;
  }

  revoke(token: string): void {
    this.db
      .prepare(`UPDATE shares SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL`)
      .run(Date.now(), token);
  }

  setEmailMapping(email: string, accountId: string): void {
    this.db
      .prepare(
        `INSERT INTO account_directory (email, account_id, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET account_id = excluded.account_id,
                                          created_at = excluded.created_at`,
      )
      .run(email, accountId, Date.now());
  }

  getAccountByEmail(email: string): string | null {
    const row = this.db
      .prepare(`SELECT account_id FROM account_directory WHERE email = ?`)
      .get(email) as unknown as { account_id: string } | undefined;
    return row?.account_id ?? null;
  }

  getEmailByAccount(accountId: string): string | null {
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

/** Lazily-initialized singleton, rebuilt if `SHARE_DB_PATH` changes (tests). */
let singleton: { dbPath: string; store: ShareStore } | null = null;

/**
 * Return the process-wide {@link ShareStore} singleton.
 *
 * The connection is opened on first use. If `SHARE_DB_PATH` changes between
 * calls (as in tests that point at a fresh tmp file), a new store is created
 * for the new path so tests stay isolated.
 */
export function getShareStore(): ShareStore {
  const dbPath = resolveDbPath();
  if (singleton !== null && singleton.dbPath === dbPath) {
    return singleton.store;
  }
  const store = new SqliteShareStore(dbPath);
  singleton = { dbPath, store };
  return store;
}
