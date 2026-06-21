import "server-only";

/**
 * Reusable AES-256-GCM secret encryption for at-rest storage.
 *
 * The share store persists each share's minted delegate *private* key to disk
 * (SQLite). Storing that key in plaintext would defeat the whole point of the
 * server-mediated model — anyone with read access to the DB file would hold a
 * live credential. This module encrypts secrets before they are written and
 * decrypts them only in-memory when a token is resolved server-side.
 *
 * It deliberately mirrors the AES-256-GCM scheme used by `session.ts`
 * (key derived from `SESSION_SECRET`; value format `iv:authTag:ciphertext`
 * with each part base64url-encoded) so operators configure a single secret.
 * It is a small standalone module rather than an import of `session.ts` so the
 * session cookie code keeps its own behavior and tests untouched; a little
 * duplication is acceptable here.
 *
 * AES-GCM is authenticated encryption: any tampering, truncation, or key
 * mismatch surfaces as a decryption failure, which {@link decryptSecret}
 * reports as `null` rather than throwing or returning partial plaintext.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

/** AES-256-GCM constants. Match `session.ts`. */
const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32; // 256-bit key
const IV_LENGTH = 12; // 96-bit IV is the recommended size for GCM
const AUTH_TAG_LENGTH = 16; // 128-bit auth tag (GCM default)

/**
 * Fixed scrypt salt for deriving a 32-byte key from a non-hex passphrase.
 *
 * Distinct from the session cookie's salt so that, for a passphrase-style
 * `SESSION_SECRET`, the at-rest key and the cookie key are not identical —
 * a small defense-in-depth measure that keeps the two encryption domains
 * separate while still deriving from the same operator secret.
 */
const SCRYPT_SALT = "uberwal-share-secret-v1";

/** Memoized 32-byte key derived from `SESSION_SECRET`. */
let cachedKey: { secret: string; key: Buffer } | null = null;

/**
 * Resolve the AES-256-GCM key from `SESSION_SECRET`.
 *
 * Accepts the same two formats as `session.ts`:
 *   1. A 64-character hex string, used directly as 32 raw key bytes.
 *   2. Any other non-empty string, run through scrypt with a fixed salt.
 *
 * Throws when `SESSION_SECRET` is missing — operating without authenticated
 * encryption is never an acceptable fallback for at-rest secrets.
 */
function deriveKey(): Buffer {
  const secret = process.env["SESSION_SECRET"];
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error(
      "SESSION_SECRET environment variable is required to encrypt share " +
        "secrets at rest. Provide a 64-character hex string (32 random bytes) " +
        "or a non-empty passphrase that will be derived via scrypt.",
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
 * Encrypt `plaintext` with AES-256-GCM under the derived key.
 *
 * Returns a colon-delimited string of three base64url chunks:
 * `${iv}:${authTag}:${ciphertext}`. A fresh random IV is generated per call,
 * so encrypting the same plaintext twice yields different ciphertexts.
 */
export function encryptSecret(plaintext: string): string {
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
 * Decrypt a value produced by {@link encryptSecret}.
 *
 * Returns `null` for any malformed input (wrong number of parts, malformed
 * base64url, wrong IV/auth-tag length) and for any decryption failure
 * (bad auth tag, wrong key, tampered ciphertext). Callers translate `null`
 * into "secret unavailable" so a tampered DB row cannot smuggle partial or
 * forged plaintext into the rest of the system.
 */
export function decryptSecret(value: string): string | null {
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
