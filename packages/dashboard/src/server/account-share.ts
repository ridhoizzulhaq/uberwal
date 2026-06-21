import "server-only";

/**
 * Server-only owner-side helpers for "seamless sharing".
 *
 * Seamless sharing mints a *dedicated* MemWal delegate key per share link
 * instead of handing out the developer's own session delegate key. Each link
 * therefore carries its own key that can be revoked independently on-chain,
 * without disturbing the owner's session or other outstanding links. This is
 * the "delegate-key-per-share, anyone-with-the-link-can-view" model.
 *
 * Both operations here are *on-chain owner actions*: they require the account
 * owner's Sui wallet key (`SUI_PRIVATE_KEY`, bech32 `suiprivkey1...`) to sign
 * the `add_delegate_key` / `remove_delegate_key` move calls, plus the Walrus
 * Memory contract package id (`MEMWAL_PACKAGE_ID`). They run only on the
 * server, are gated behind a developer session at the action layer, and never
 * touch a client bundle.
 *
 * Security:
 * - The minted delegate *private* key is returned to the caller exactly once
 *   so the client can assemble the share link. It is never logged or persisted
 *   server-side; the client owns share metadata (localStorage).
 * - `SUI_PRIVATE_KEY` is an owner secret. It is read from the environment only,
 *   never returned, never logged.
 */

import {
  addDelegateKey,
  generateDelegateKey,
  removeDelegateKey,
} from "@mysten-incubation/memwal/account";

/** Sui networks the on-chain share calls support. */
export type SuiNetwork = "testnet" | "mainnet";

/** Input to {@link createShareDelegateKey}. */
export interface CreateShareDelegateKeyInput {
  /** `0x`-prefixed Walrus Memory account object id to attach the key to. */
  accountId: string;
  /**
   * On-chain label applied to the minted key (e.g.
   * `uberwal-summary-2025-01-31`). Supplied by the caller so labeling policy
   * lives at the action layer, not here.
   */
  label: string;
}

/**
 * Result of minting a share delegate key.
 *
 * `delegateKey` is the freshly minted Ed25519 *private* key (hex). The client
 * embeds it in the share link and stores share metadata locally; the server
 * keeps no copy.
 */
export interface CreateShareDelegateKeyResult {
  /** Newly minted delegate private key (hex). Sensitive — handle once. */
  delegateKey: string;
  /** Delegate public key (hex), used as the revoke handle. */
  publicKeyHex: string;
  /** Derived Sui address for the delegate key. */
  suiAddress: string;
  /** On-chain label applied to the key. */
  label: string;
}

/** Input to {@link revokeShareDelegateKey}. */
export interface RevokeShareDelegateKeyInput {
  /** `0x`-prefixed Walrus Memory account object id the key belongs to. */
  accountId: string;
  /** Delegate public key (hex) to remove from the account on-chain. */
  publicKeyHex: string;
}

/** Result of revoking a share delegate key. */
export interface RevokeShareDelegateKeyResult {
  ok: boolean;
  /** Transaction digest of the on-chain `remove_delegate_key` call. */
  digest: string;
}

/**
 * Resolve the owner's Sui private key from the environment.
 *
 * Throws a clear, actionable error when missing so a misconfigured deployment
 * surfaces a useful message at the action layer rather than an opaque SDK
 * failure deep in transaction signing. The value itself is never returned to
 * callers or logged.
 */
function requireSuiPrivateKey(): string {
  const value = process.env["SUI_PRIVATE_KEY"];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      "SUI_PRIVATE_KEY environment variable is required to create or revoke " +
        "share links. Provide the owner wallet key in bech32 form " +
        "(suiprivkey1...).",
    );
  }
  return value;
}

/**
 * Resolve the Walrus Memory contract package id from the environment.
 *
 * Required by `addDelegateKey` / `removeDelegateKey`; throws when missing.
 */
function requirePackageId(): string {
  const value = process.env["MEMWAL_PACKAGE_ID"];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      "MEMWAL_PACKAGE_ID environment variable is required to create or revoke " +
        "share links. Provide the Walrus Memory contract package id (0x...).",
    );
  }
  return value;
}

/**
 * Resolve the target Sui network, defaulting to `"testnet"`.
 *
 * Any value other than the two known networks falls back to `"testnet"` so a
 * typo can't silently target mainnet.
 */
function resolveSuiNetwork(): SuiNetwork {
  return process.env["SUI_NETWORK"] === "mainnet" ? "mainnet" : "testnet";
}

/**
 * Mint a dedicated delegate key for a share link and register it on-chain.
 *
 * Generates a fresh Ed25519 keypair, then calls `addDelegateKey` signed by the
 * owner's Sui wallet key so the relayer will accept recalls authenticated with
 * the new key. Returns the minted private key (once) plus the public key hex
 * the caller can later pass to {@link revokeShareDelegateKey}.
 *
 * Throws when `SUI_PRIVATE_KEY` or `MEMWAL_PACKAGE_ID` is missing, or when the
 * on-chain transaction fails.
 */
export async function createShareDelegateKey(
  input: CreateShareDelegateKeyInput,
): Promise<CreateShareDelegateKeyResult> {
  const suiPrivateKey = requireSuiPrivateKey();
  const packageId = requirePackageId();
  const suiNetwork = resolveSuiNetwork();
  const label = input.label;

  const delegate = await generateDelegateKey();

  const added = await addDelegateKey({
    accountId: input.accountId,
    publicKey: delegate.publicKey,
    label,
    packageId,
    suiPrivateKey,
    suiNetwork,
  });

  return {
    delegateKey: delegate.privateKey,
    publicKeyHex: added.publicKey,
    suiAddress: added.suiAddress,
    label,
  };
}

/**
 * Revoke a previously minted share delegate key on-chain.
 *
 * Calls `removeDelegateKey` signed by the owner's Sui wallet key. After this
 * settles, the relayer rejects recalls authenticated with the removed key, so
 * the corresponding share link stops working.
 *
 * Throws when `SUI_PRIVATE_KEY` or `MEMWAL_PACKAGE_ID` is missing, or when the
 * on-chain transaction fails.
 */
export async function revokeShareDelegateKey(
  input: RevokeShareDelegateKeyInput,
): Promise<RevokeShareDelegateKeyResult> {
  const suiPrivateKey = requireSuiPrivateKey();
  const packageId = requirePackageId();
  const suiNetwork = resolveSuiNetwork();

  const removed = await removeDelegateKey({
    accountId: input.accountId,
    publicKey: input.publicKeyHex,
    packageId,
    suiPrivateKey,
    suiNetwork,
  });

  return { ok: true, digest: removed.digest };
}
