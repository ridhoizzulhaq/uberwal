"use server";

/**
 * Email ↔ account directory actions.
 *
 * Lets a logged-in owner link an email to their account id so others can
 * address a share to that email (resolved to the account id at share-create
 * time). The mapping is SELF-ASSERTED: there is no email-ownership
 * verification, so it is a convenience directory, not proof of identity. The
 * account id always comes from the session — a caller can only ever map an
 * email to THEIR OWN account.
 */

import { getSession } from "../../server/session.js";
import { getShareStore } from "../../server/share-store.js";

/** Conservative email shape check (not RFC-perfect; rejects obvious garbage). */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Normalize an email for storage/lookup: trim + lowercase. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Result of {@link registerEmail} / {@link getMyEmail}. */
export type MyEmailResult =
  | { ok: true; email: string | null; accountId: string }
  | { ok: false; message: string };

/** Result of {@link lookupEmail}. */
export type LookupEmailResult =
  | { ok: true; email: string; accountId: string | null }
  | { ok: false; message: string };

/**
 * Link the current owner's email to their account id (insert or replace).
 *
 * Reads the account id from the session, never from the client. Returns the
 * stored email + account id on success.
 */
export async function registerEmail(input: {
  email: string;
}): Promise<MyEmailResult> {
  const session = await getSession();
  if (session === null) {
    return { ok: false, message: "Not authenticated" };
  }
  const email = normalizeEmail(input.email);
  if (!EMAIL_PATTERN.test(email)) {
    return { ok: false, message: "Enter a valid email address." };
  }
  try {
    getShareStore().setEmailMapping(email, session.accountId);
    return { ok: true, email, accountId: session.accountId };
  } catch {
    return { ok: false, message: "Could not save the email mapping. Try again." };
  }
}

/**
 * Return the email currently linked to the owner's account, if any.
 */
export async function getMyEmail(): Promise<MyEmailResult> {
  const session = await getSession();
  if (session === null) {
    return { ok: false, message: "Not authenticated" };
  }
  const email = getShareStore().getEmailByAccount(session.accountId);
  return { ok: true, email, accountId: session.accountId };
}

/**
 * Resolve an email to its linked account id (or `null` if unlinked).
 *
 * Requires a session (only logged-in owners look up recipients when sharing).
 * Used by the SharePanel to preview "this email points to account X" before
 * minting a share.
 */
export async function lookupEmail(input: {
  email: string;
}): Promise<LookupEmailResult> {
  const session = await getSession();
  if (session === null) {
    return { ok: false, message: "Not authenticated" };
  }
  const email = normalizeEmail(input.email);
  if (!EMAIL_PATTERN.test(email)) {
    return { ok: false, message: "Enter a valid email address." };
  }
  const accountId = getShareStore().getAccountByEmail(email);
  return { ok: true, email, accountId };
}
