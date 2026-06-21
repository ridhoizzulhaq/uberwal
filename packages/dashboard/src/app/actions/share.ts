"use server";

/**
 * Owner-side server actions for the server-mediated ("token") share model.
 *
 * A share link carries only a random opaque token (e.g. `/v/<token>`), never a
 * key. Creating a share mints a dedicated on-chain delegate key, stores it
 * ENCRYPTED at rest alongside a manifest of what's allowed, and returns only
 * the token. The delegate private key is never returned to the client and
 * never leaves the server boundary — when a recipient opens a token, the
 * server resolves it and recalls on their behalf (see `shared-access.ts`).
 *
 * All three actions require an owner session: the account id is read from the
 * session cookie, never accepted from the client, so a caller can only ever
 * create, list, or revoke shares for their own account.
 */

import { getSession } from "../../server/session.js";
import { isValidAccountId } from "@uberwal/shared";
import {
  createShareDelegateKey,
  revokeShareDelegateKey,
} from "../../server/account-share.js";
import {
  namespacesForMode,
  type ShareMode,
} from "../../server/share-manifest.js";
import {
  getShareStore,
  newShareToken,
  type ShareSummary,
} from "../../server/share-store.js";

/** Result of {@link createShare}. */
export type CreateShareResult =
  | { ok: true; token: string }
  | { ok: false; message: string };

/** Result of {@link revokeShare}. */
export type RevokeShareResult = { ok: true } | { ok: false; message: string };

/**
 * Build the default on-chain/display label for a share when the caller omits
 * one: `uberwal-<mode>-<YYYY-MM-DD>` (UTC date), matching the prior labeling
 * convention so on-chain audits stay readable.
 */
function defaultLabel(mode: ShareMode): string {
  const date = new Date().toISOString().slice(0, 10);
  return `uberwal-${mode}-${date}`;
}

/**
 * Extract a human-readable message from a thrown value.
 *
 * Mirrors the recall action's helper so share failures surface useful SDK and
 * configuration error messages while never rendering `[object Object]`.
 */
function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  return "Share request failed.";
}

/**
 * Create a server-mediated share for the current owner.
 *
 * Mints a dedicated delegate key on-chain, stores it encrypted with a manifest
 * describing the allowed namespaces (derived from `mode`), an optional
 * `blobIds` whitelist, and an optional `sessionIds` whitelist, then returns the
 * opaque token to embed in the link.
 *
 * Returns `{ ok: false }` when unauthenticated or when minting/storage fails
 * (e.g. missing `SUI_PRIVATE_KEY` / `MEMWAL_PACKAGE_ID`). The delegate private
 * key is never included in the result.
 */
export async function createShare(input: {
  mode: ShareMode;
  sessionIds?: string[];
  blobIds?: string[];
  label?: string;
  sharedBy?: string;
  recipientAccountId?: string;
  repo?: string;
}): Promise<CreateShareResult> {
  const session = await getSession();
  if (session === null) {
    return { ok: false, message: "Not authenticated" };
  }

  // Optional recipient addressing: when provided it must be a well-formed
  // account id, so the share lands in the right "Shared with me" inbox.
  const rawRecipient =
    typeof input.recipientAccountId === "string" ? input.recipientAccountId.trim() : "";
  if (rawRecipient.length > 0 && !isValidAccountId(rawRecipient)) {
    return {
      ok: false,
      message:
        "Recipient account id must be 0x followed by 64 hexadecimal characters.",
    };
  }
  const recipientAccountId = rawRecipient.length > 0 ? rawRecipient : null;

  try {
    const namespaces = namespacesForMode(input.mode);
    const label =
      typeof input.label === "string" && input.label.length > 0
        ? input.label
        : defaultLabel(input.mode);

    const minted = await createShareDelegateKey({
      accountId: session.accountId,
      label,
    });

    const token = newShareToken();
    const repo =
      typeof input.repo === "string" && input.repo.trim().length > 0
        ? input.repo.trim()
        : null;
    const manifest = {
      mode: input.mode,
      namespaces,
      ...(input.blobIds !== undefined && input.blobIds.length > 0
        ? { blobIds: input.blobIds }
        : {}),
      ...(input.sessionIds !== undefined && input.sessionIds.length > 0
        ? { sessionIds: input.sessionIds }
        : {}),
      ...(repo !== null ? { repo } : {}),
    };

    // "Shared by" identity shown to the recipient. Use the owner-provided
    // display name when present; otherwise leave null and let the recipient
    // view fall back to a short form of the owner account id.
    const sharedBy =
      typeof input.sharedBy === "string" && input.sharedBy.trim().length > 0
        ? input.sharedBy.trim()
        : null;

    getShareStore().create({
      token,
      ownerAccountId: session.accountId,
      publicKeyHex: minted.publicKeyHex,
      delegateKey: minted.delegateKey,
      manifest,
      label,
      sharedBy,
      recipientAccountId,
    });

    return { ok: true, token };
  } catch (error) {
    return { ok: false, message: toErrorMessage(error) };
  }
}

/**
 * Revoke a share by token.
 *
 * Loads the record, verifies it belongs to the calling owner, removes the
 * delegate key on-chain, then marks the share revoked in the store. Returns
 * `{ ok: false }` when unauthenticated, when the token is unknown, when the
 * caller does not own the share, or when the on-chain removal fails.
 */
export async function revokeShare(input: {
  token: string;
}): Promise<RevokeShareResult> {
  const session = await getSession();
  if (session === null) {
    return { ok: false, message: "Not authenticated" };
  }

  const store = getShareStore();
  const record = store.getByToken(input.token);
  if (record === null) {
    return { ok: false, message: "Share not found." };
  }
  if (record.ownerAccountId !== session.accountId) {
    return { ok: false, message: "You are not authorized to revoke this share." };
  }

  try {
    await revokeShareDelegateKey({
      accountId: session.accountId,
      publicKeyHex: record.publicKeyHex,
    });
    store.revoke(input.token);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toErrorMessage(error) };
  }
}

/**
 * List the current owner's shares as key-free summaries (newest first).
 *
 * Returns an empty list when unauthenticated rather than throwing, so a
 * client surface can render an empty state without special-casing auth.
 */
export async function listShares(): Promise<ShareSummary[]> {
  const session = await getSession();
  if (session === null) {
    return [];
  }
  return getShareStore().listByOwner(session.accountId);
}

/** One entry in the current viewer's "Shared with me" inbox. */
export interface SharedWithMeItem {
  /** Opaque token to open the shared view at `/v/<token>`. */
  token: string;
  /** Share mode (full vs summary). */
  mode: ShareMode;
  /** Optional human label for the share. */
  label: string | null;
  /** Who shared it (owner-provided name, or a short account id). */
  sharedBy: string | null;
  /** Whether the share is scoped to specific sessions. */
  sessionScoped: boolean;
  /** Project/repository the share is scoped to, when set. */
  repo: string | null;
  /** Creation time (epoch ms). */
  createdAt: number;
}

/** Result of {@link listSharesForMe}. */
export type SharedWithMeResult =
  | { ok: true; items: SharedWithMeItem[] }
  | { ok: false; message: string };

/**
 * List active shares ADDRESSED to the current viewer's account — their
 * "Shared with me" inbox.
 *
 * Reads the viewer's account id from the session (never from the client), so a
 * caller only ever sees shares directed at their own account. Revoked shares
 * are omitted. Returns `{ ok: false, message: "Not authenticated" }` when there
 * is no session so the page can route to login (distinct from an empty inbox).
 *
 * Note: this is app-layer addressing — the share's opaque token is still the
 * access mechanism. This action surfaces the token to the addressed recipient
 * so they don't need a link sent out-of-band.
 */
export async function listSharesForMe(): Promise<SharedWithMeResult> {
  const session = await getSession();
  if (session === null) {
    return { ok: false, message: "Not authenticated" };
  }
  const items = getShareStore()
    .listForRecipient(session.accountId)
    .filter((s) => s.revokedAt === null)
    .map((s) => ({
      token: s.token,
      mode: s.manifest.mode,
      label: s.label,
      sharedBy: s.sharedBy,
      sessionScoped:
        s.manifest.sessionIds !== undefined && s.manifest.sessionIds.length > 0,
      repo: s.manifest.repo ?? null,
      createdAt: s.createdAt,
    }));
  return { ok: true, items };
}
