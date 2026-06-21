/**
 * Unit tests for the SQLite-backed share store.
 *
 * These exercise the storage contract end-to-end against a real (temp-file)
 * database:
 *   - create → getByToken round-trips the manifest and the DECRYPTED key;
 *   - the persisted `delegate_key_enc` column is ciphertext, never the
 *     plaintext key (encryption is actually applied at rest);
 *   - listByOwner returns only the queried owner's shares, as key-free
 *     summaries;
 *   - revoke stamps `revokedAt` while getByToken still resolves the record,
 *     flagged revoked.
 *
 * Runs in the default `node` environment (no jsdom). `SHARE_DB_PATH` points at
 * an `os.tmpdir()` file and `SESSION_SECRET` is a fixed 64-hex test value; both
 * are set before the store module is used, and the temp files are cleaned up.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { existsSync, rmSync } from "node:fs";

// `share-store.ts` (and the `crypto.ts` it uses) open with
// `import "server-only"`, whose guard package throws outside a React Server
// Component bundler. Stub it to an empty module for the node test environment.
vi.mock("server-only", () => ({}));

import { getShareStore, newShareToken } from "./share-store.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { namespacesForMode, type ShareManifest } from "./share-manifest.js";

const TMP_DB = path.join(
  os.tmpdir(),
  `uberwal-shares-test-${process.pid}-${Date.now()}.db`,
);

beforeAll(() => {
  process.env["SHARE_DB_PATH"] = TMP_DB;
  process.env["SESSION_SECRET"] = "b".repeat(64);
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${TMP_DB}${suffix}`;
    if (existsSync(file)) rmSync(file, { force: true });
  }
});

const KEY_A = "1".repeat(64);
const KEY_B = "2".repeat(64);

describe("SqliteShareStore", () => {
  it("round-trips a created share: manifest + decrypted key match", () => {
    const store = getShareStore();
    const token = newShareToken();
    const manifest: ShareManifest = {
      mode: "full",
      namespaces: namespacesForMode("full"),
      blobIds: ["blob-1", "blob-2"],
    };

    store.create({
      token,
      ownerAccountId: "0xowner-a",
      publicKeyHex: "pubkey-a",
      delegateKey: KEY_A,
      manifest,
      label: "uberwal-full-2025-01-01",
    });

    const record = store.getByToken(token);
    expect(record).not.toBeNull();
    expect(record?.token).toBe(token);
    expect(record?.ownerAccountId).toBe("0xowner-a");
    expect(record?.publicKeyHex).toBe("pubkey-a");
    expect(record?.delegateKey).toBe(KEY_A);
    expect(record?.manifest).toEqual(manifest);
    expect(record?.label).toBe("uberwal-full-2025-01-01");
    expect(typeof record?.createdAt).toBe("number");
    expect(record?.revokedAt).toBeNull();
  });

  it("persists the delegate key as ciphertext, not plaintext", () => {
    const store = getShareStore();
    const token = newShareToken();
    store.create({
      token,
      ownerAccountId: "0xowner-a",
      publicKeyHex: "pubkey-enc",
      delegateKey: KEY_A,
      manifest: { mode: "summary", namespaces: namespacesForMode("summary") },
      label: null,
    });

    // Read the raw column with an independent connection.
    const sqlite = process.getBuiltinModule(
      "node:sqlite",
    ) as typeof import("node:sqlite");
    const raw = new sqlite.DatabaseSync(TMP_DB, { readOnly: true });
    const row = raw
      .prepare("SELECT delegate_key_enc FROM shares WHERE token = ?")
      .get(token) as unknown as { delegate_key_enc: string };
    raw.close();

    expect(row.delegate_key_enc).not.toBe(KEY_A);
    expect(row.delegate_key_enc).not.toContain(KEY_A);
    // The stored value is the `iv:authTag:ciphertext` envelope and decrypts
    // back to the original key.
    expect(row.delegate_key_enc.split(":")).toHaveLength(3);
    expect(decryptSecret(row.delegate_key_enc)).toBe(KEY_A);
  });

  it("listByOwner returns only that owner's shares, without keys", () => {
    const store = getShareStore();
    const tokenA = newShareToken();
    const tokenB = newShareToken();

    store.create({
      token: tokenA,
      ownerAccountId: "0xowner-list-a",
      publicKeyHex: "pk-a",
      delegateKey: KEY_A,
      manifest: { mode: "summary", namespaces: namespacesForMode("summary") },
      label: "a",
    });
    store.create({
      token: tokenB,
      ownerAccountId: "0xowner-list-b",
      publicKeyHex: "pk-b",
      delegateKey: KEY_B,
      manifest: { mode: "full", namespaces: namespacesForMode("full") },
      label: "b",
    });

    const summaries = store.listByOwner("0xowner-list-a");
    expect(summaries).toHaveLength(1);
    const summary = summaries[0]!;
    expect(summary.token).toBe(tokenA);
    expect(summary.label).toBe("a");
    expect(summary.manifest.mode).toBe("summary");

    // No credential / handle fields leak into the summary.
    expect("delegateKey" in summary).toBe(false);
    expect("publicKeyHex" in summary).toBe(false);
    expect("ownerAccountId" in summary).toBe(false);

    // The other owner's share is not included.
    expect(summaries.some((s) => s.token === tokenB)).toBe(false);
  });

  it("revoke stamps revokedAt; getByToken still resolves it flagged revoked", () => {
    const store = getShareStore();
    const token = newShareToken();
    store.create({
      token,
      ownerAccountId: "0xowner-revoke",
      publicKeyHex: "pk-revoke",
      delegateKey: KEY_A,
      manifest: { mode: "summary", namespaces: namespacesForMode("summary") },
      label: null,
    });

    expect(store.getByToken(token)?.revokedAt).toBeNull();

    store.revoke(token);

    const record = store.getByToken(token);
    expect(record).not.toBeNull();
    expect(typeof record?.revokedAt).toBe("number");
    // The key is still decryptable after revoke (revoke is a status flag).
    expect(record?.delegateKey).toBe(KEY_A);
  });

  it("getByToken returns null for an unknown token", () => {
    expect(getShareStore().getByToken("does-not-exist")).toBeNull();
  });

  it("round-trips a manifest carrying sessionIds (create → getByToken)", () => {
    const store = getShareStore();
    const token = newShareToken();
    const manifest: ShareManifest = {
      mode: "summary",
      namespaces: namespacesForMode("summary"),
      sessionIds: ["sess-a", "sess-b"],
    };

    store.create({
      token,
      ownerAccountId: "0xowner-sessions",
      publicKeyHex: "pk-sessions",
      delegateKey: KEY_A,
      manifest,
      label: null,
    });

    const record = store.getByToken(token);
    expect(record?.manifest.sessionIds).toEqual(["sess-a", "sess-b"]);
    expect(record?.manifest).toEqual(manifest);
  });

  it("parseManifest ignores a non-array sessionIds (omits the field)", () => {
    const store = getShareStore();
    const token = newShareToken();

    // Write a row directly with a malformed `sessionIds` so we exercise the
    // parser's defensive filtering without depending on `create`'s typing.
    const sqlite = process.getBuiltinModule(
      "node:sqlite",
    ) as typeof import("node:sqlite");
    const raw = new sqlite.DatabaseSync(TMP_DB);
    raw
      .prepare(
        `INSERT INTO shares (
          token, owner_account_id, public_key_hex, delegate_key_enc,
          manifest_json, label, created_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        token,
        "0xowner-bad-sessions",
        "pk",
        // Reuse the store to produce valid ciphertext for the key column.
        encryptSecret(KEY_A),
        JSON.stringify({
          mode: "summary",
          namespaces: namespacesForMode("summary"),
          sessionIds: "not-an-array",
        }),
        null,
        Date.now(),
        null,
      );
    raw.close();

    const record = store.getByToken(token);
    expect(record).not.toBeNull();
    expect("sessionIds" in (record?.manifest ?? {})).toBe(false);
  });
});
