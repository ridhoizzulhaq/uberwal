"use server";

/**
 * Owner-side server actions for the server-mediated ("token") share model.
 *
 * A share link carries only a random opaque token (e.g. `/v/<token>`), never a
 * key. Creating a share stores the owner's logged-in delegate key ENCRYPTED at
 * rest alongside a manifest of what's allowed (Option B: DB-only — no on-chain
 * mint, no gas, no owner wallet required), and returns only the token. The
 * delegate key never leaves the server boundary; when a recipient opens a
 * token the server resolves it and recalls on their behalf (see
 * `shared-access.ts`). Revocation is server-side: marking the record revoked
 * makes the server refuse the token (the recipient only ever holds the token).
 *
 * All actions require an owner session: the account id (and the delegate key
 * reused for the share) come from the session cookie, never from the client,
 * so a caller can only ever create, list, or revoke shares for their own
 * account.
 */

import { getSession } from "../../server/session.js";
import { isValidAccountId } from "@uberwal/shared";
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
 * Build the default display label for a share when the caller omits one:
 * `uberwal-<mode>-<YYYY-MM-DD>` (UTC date), matching the prior labeling
 * convention so share listings stay readable.
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
 * Create a server-mediated share for the current owner (Option B: DB-only).
 *
 * Stores the owner's logged-in delegate key ENCRYPTED alongside a manifest
 * describing the allowed namespaces (derived from `mode`), an optional
 * `blobIds` whitelist, an optional `sessionIds` whitelist, and an optional
 * `repo` scope, then returns the opaque token. No on-chain minting, no gas, no
 * `SUI_PRIVATE_KEY` required.
 *
 * The recipient may be addressed by `recipientAccountId` OR by `recipientEmail`
 * (resolved to an account id via the email↔account directory). When a recipient
 * is set, the share is addressed+gated: only that account can open `/v/<token>`
 * (see `shared-access.ts`), and it appears in their "Shared with me" inbox.
 *
 * Returns `{ ok: false }` when unauthenticated, when an email isn't linked to
 * any account, or on storage failure. The delegate key is never returned.
 */
export async function createShare(input: {
  mode: ShareMode;
  sessionIds?: string[];
  blobIds?: string[];
  label?: string;
  recipientAccountId?: string;
  recipientEmail?: string;
  repo?: string;
}): Promise<CreateShareResult> {
  const session = await getSession();
  if (session === null) {
    return { ok: false, message: "Not authenticated" };
  }

  // Resolve the recipient (optional). Prefer an explicit account id; otherwise
  // resolve an email through the directory. A provided-but-unresolvable
  // recipient is an error so the owner doesn't silently mint an open link when
  // they intended an addressed one.
  let recipientAccountId: string | null = null;
  const rawAccount =
    typeof input.recipientAccountId === "string" ? input.recipientAccountId.trim() : "";
  const rawEmail =
    typeof input.recipientEmail === "string"
      ? input.recipientEmail.trim().toLowerCase()
      : "";
  if (rawAccount.length > 0) {
    if (!isValidAccountId(rawAccount)) {
      return {
        ok: false,
        message:
          "Recipient account id must be 0x followed by 64 hexadecimal characters.",
      };
    }
    recipientAccountId = rawAccount;
  } else if (rawEmail.length > 0) {
    const resolved = getShareStore().getAccountByEmail(rawEmail);
    if (resolved === null) {
      return {
        ok: false,
        message: `No account is linked to ${rawEmail}. Ask them to link their email under "Link email" first.`,
      };
    }
    recipientAccountId = resolved;
  }

  try {
    const namespaces = namespacesForMode(input.mode);
    const label =
      typeof input.label === "string" && input.label.length > 0
        ? input.label
        : defaultLabel(input.mode);

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

    // "Shared by" identity is derived from the directory (the owner's linked
    // email), NOT typed by the user. When no email is linked we fall back to
    // the FULL account id (never abbreviated) so the recipient always sees who
    // shared it.
    const ownerEmail = getShareStore().getEmailByAccount(session.accountId);
    const sharedBy = ownerEmail ?? session.accountId;

    // Option B (DB-only): reuse the owner's logged-in delegate key rather than
    // minting a dedicated on-chain key. `publicKeyHex` is empty because there
    // is no on-chain revoke handle — revocation is server-side via `revoke`.
    getShareStore().create({
      token,
      ownerAccountId: session.accountId,
      publicKeyHex: "",
      delegateKey: session.delegateKey,
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
 * Revoke a share by token (DB-only).
 *
 * Loads the record, verifies it belongs to the calling owner, then marks the
 * share revoked in the store. Because access is server-mediated (the recipient
 * only ever holds the opaque token, never the key), marking the record revoked
 * makes every recipient action refuse the token — no on-chain transaction is
 * needed. Returns `{ ok: false }` when unauthenticated, when the token is
 * unknown, or when the caller does not own the share.
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
  /** Subject/label for the share (the title the sender gave it). */
  label: string | null;
  /** Who shared it: the sender's linked email, else their FULL account id. */
  sender: string;
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
      // Sender display: the owner's linked email when present, else the FULL
      // account id (not abbreviated). A legacy `sharedBy` stored in the
      // abbreviated `0x…` form is ignored so it's replaced by the full id.
      sender:
        s.sharedBy !== null && s.sharedBy.length > 0 && !s.sharedBy.includes("…")
          ? s.sharedBy
          : s.ownerAccountId,
      sessionScoped:
        s.manifest.sessionIds !== undefined && s.manifest.sessionIds.length > 0,
      repo: s.manifest.repo ?? null,
      createdAt: s.createdAt,
    }));
  return { ok: true, items };
}
