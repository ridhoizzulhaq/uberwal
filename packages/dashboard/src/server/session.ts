import "server-only";

/**
 * Encrypted session cookie for the dashboard.
 *
 * The dashboard never persists delegate keys in client-readable storage
 * (localStorage, sessionStorage) or in a database. Instead, login serializes
 * `{ accountId, delegateKey, role }` into an AES-256-GCM-encrypted payload
 * stored in an httpOnly, Secure, SameSite=Strict cookie. Every server action
 * decrypts the cookie at the start of the request to rebuild a per-request
 * `MemWalClient`, then discards it. This keeps the delegate key on the server
 * boundary at all times, satisfying the credential-flow decision in design.md.
 *
 * The cookie value uses the format `iv:authTag:ciphertext`, where each part
 * is base64url-encoded. AES-GCM gives us authenticated encryption, so any
 * tampering, truncation, or substitution of the cookie surfaces as a
 * decryption failure that is reported as "no session" rather than a partial
 * read.
 *
 * Validates: Requirement 7.1
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { cookies } from "next/headers";

import {
  isValidAccountId,
  isValidDelegateKey,
  type Role,
} from "@uberwal/shared";

/**
 * Decrypted session contents. Mirrors the `SessionPayload` interface in
 * design.md and is the only shape `getSession` ever returns.
 */
export interface SessionPayload {
  /** `0x`-prefixed 64-character hex Sui account object id. */
  accountId: string;
  /** 64-character hex Ed25519 delegate private key (server-only). */
  delegateKey: string;
  /** Selected viewer role, used by the dashboard for tab visibility. */
  role: Role;
}

/** Cookie name. Stable so older sessions can be cleared by name on logout. */
const COOKIE_NAME = "dm_session";

/**
 * Cookie attributes for the session cookie.
 *
 * - `httpOnly` blocks `document.cookie` access from page JavaScript,
 *   protecting the encrypted payload (and the delegate key it contains)
 *   from XSS-driven exfiltration.
 * - `secure` ensures the cookie is only sent over HTTPS in production.
 * - `sameSite: "strict"` prevents the cookie from being attached to
 *   cross-site requests, which mitigates CSRF on state-changing actions.
 * - `path: "/"` makes the session available to every dashboard route.
 */
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env["NODE_ENV"] === "production",
  sameSite: "strict" as const,
  path: "/",
} satisfies {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "strict";
  path: string;
};

/** AES-256-GCM constants. */
const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32; // 256-bit key
const IV_LENGTH = 12; // 96-bit IV is the recommended size for GCM
const AUTH_TAG_LENGTH = 16; // 128-bit auth tag (GCM default)

/**
 * Fixed scrypt salt for deriving a 32-byte key from a non-hex passphrase.
 *
 * A random salt would force us to either (a) persist the salt alongside the
 * cookie, defeating the goal of keeping the cookie self-contained, or (b)
 * regenerate the key per process, invalidating sessions across deploys. A
 * fixed salt keyed to this application's purpose binds the derivation to
 * Uberwal while still benefiting from scrypt's KDF cost; the operator is
 * expected to keep `SESSION_SECRET` itself private.
 */
const SCRYPT_SALT = "dev-memory-session-v1";

/**
 * Memoized 32-byte symmetric key derived from `SESSION_SECRET`.
 *
 * Caching avoids re-running scrypt on every request (scrypt is intentionally
 * expensive) while still recomputing if the env var changes between calls
 * during testing.
 */
let cachedKey: { secret: string; key: Buffer } | null = null;

/**
 * Resolve the AES-256-GCM key from `SESSION_SECRET`.
 *
 * Two formats are accepted:
 *   1. **Pre-hashed:** a 64-character hex string, treated directly as 32
 *      raw key bytes. This is the recommended format in production —
 *      generate it once with `openssl rand -hex 32` and store it in your
 *      secrets manager.
 *   2. **Passphrase:** any other non-empty string is run through scrypt
 *      with a fixed salt to produce 32 deterministic key bytes. This is
 *      convenient for local development but slower per process startup.
 *
 * Throws a clear error when `SESSION_SECRET` is missing, since without it
 * we cannot encrypt or decrypt cookies and operating without authenticated
 * encryption is never an acceptable fallback.
 */
function deriveKey(): Buffer {
  const secret = process.env["SESSION_SECRET"];
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error(
      "SESSION_SECRET environment variable is required. " +
        "Provide a 64-character hex string (32 random bytes) or a non-empty " +
        "passphrase that will be derived via scrypt.",
    );
  }
  if (cachedKey !== null && cachedKey.secret === secret) {
    return cachedKey.key;
  }
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(secret)) {
    key = Buffer.from(secret, "hex");
  } else {
    key = scryptSync(secret, SCRYPT_SALT, KEY_LENGTH);
  }
  cachedKey = { secret, key };
  return key;
}

/**
 * Encrypt `plaintext` with AES-256-GCM under the derived session key.
 *
 * Returns a colon-delimited string of three base64url chunks:
 * `${iv}:${authTag}:${ciphertext}`. base64url is used so the encoded value
 * fits inside a cookie without further URL encoding by the browser.
 */
function encrypt(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

/**
 * Decrypt a cookie value produced by {@link encrypt}.
 *
 * Returns `null` for any malformed input (wrong number of parts, malformed
 * base64url, wrong IV/auth-tag length) and for any decryption failure
 * (bad auth tag, wrong key). Callers translate `null` into "no session"
 * so that an attacker tampering with the cookie cannot distinguish the
 * specific failure mode.
 */
function decrypt(value: string): string | null {
  const parts = value.split(":");
  if (parts.length !== 3) return null;
  const [ivB64, authTagB64, ciphertextB64] = parts;
  if (
    typeof ivB64 !== "string" ||
    typeof authTagB64 !== "string" ||
    typeof ciphertextB64 !== "string" ||
    ivB64.length === 0 ||
    authTagB64.length === 0 ||
    ciphertextB64.length === 0
  ) {
    return null;
  }
  let iv: Buffer;
  let authTag: Buffer;
  let ciphertext: Buffer;
  try {
    iv = Buffer.from(ivB64, "base64url");
    authTag = Buffer.from(authTagB64, "base64url");
    ciphertext = Buffer.from(ciphertextB64, "base64url");
  } catch {
    return null;
  }
  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    return null;
  }
  // `timingSafeEqual` is referenced here only to keep the constant-time
  // primitive in scope for future hardening; AES-GCM's auth tag check is
  // already constant-time inside OpenSSL. This call is a no-op on data
  // we're about to use; it's compiled away by V8 in practice but we keep
  // it explicit so future maintainers don't accidentally drop it.
  void timingSafeEqual;
  try {
    const key = deriveKey();
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Type guard for the `role` field. Mirrors the union in
 * `@uberwal/shared` without re-exporting any internal mapping.
 */
function isValidRole(value: unknown): value is Role {
  return value === "developer" || value === "team-lead" || value === "recruiter";
}

/**
 * Parse and validate the decrypted JSON payload.
 *
 * Returns `null` on any structural problem so a corrupted or attacker-
 * forged cookie cannot smuggle malformed data into the rest of the
 * dashboard. Each field is validated against the same shared validators
 * used at login (`isValidAccountId`, `isValidDelegateKey`) so the cookie
 * cannot encode credentials the login form would have rejected.
 */
function parsePayload(json: string): SessionPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const accountId = obj["accountId"];
  const delegateKey = obj["delegateKey"];
  const role = obj["role"];
  if (typeof accountId !== "string" || !isValidAccountId(accountId)) return null;
  if (typeof delegateKey !== "string" || !isValidDelegateKey(delegateKey)) return null;
  if (!isValidRole(role)) return null;
  return { accountId, delegateKey, role };
}

/**
 * Read and decrypt the current session, if any.
 *
 * Returns `null` when:
 *   - the cookie is absent,
 *   - the cookie value is malformed or fails authentication, or
 *   - the decrypted JSON does not match {@link SessionPayload}.
 *
 * Throws only when `SESSION_SECRET` is missing — a configuration error
 * the operator must fix before the dashboard can serve traffic.
 */
export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const cookie = store.get(COOKIE_NAME);
  if (cookie === undefined) return null;
  const decrypted = decrypt(cookie.value);
  if (decrypted === null) return null;
  return parsePayload(decrypted);
}

/**
 * Encrypt and write the session cookie.
 *
 * Called by the `login` server action after a successful MemWal `health()`
 * check. Subsequent requests within the same browser session can read the
 * payload through {@link getSession}.
 */
export async function setSession(payload: SessionPayload): Promise<void> {
  const json = JSON.stringify(payload);
  const encrypted = encrypt(json);
  const store = await cookies();
  store.set(COOKIE_NAME, encrypted, COOKIE_OPTIONS);
}

/**
 * Clear the session cookie.
 *
 * Called by the `logout` server action. After this, subsequent calls to
 * {@link getSession} return `null` until a new login occurs.
 */
export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}
