"use client";

/**
 * Manage Shares page.
 *
 * Lists the owner's server-mediated share links by calling the `listShares`
 * server action (returning key-free {@link ShareSummary} rows) and lets the
 * owner revoke any active link. Revoking calls the `revokeShare` server action
 * with the share's opaque `token`; on success the list is refreshed so the row
 * shows as revoked.
 *
 * A share link carries only the token (`/v/<token>`) — never a key. Access is
 * enforced server-side per the share's manifest (Summary vs Full). The page
 * itself does not enforce a role; the underlying server actions require an
 * owner session.
 *
 * Reached from the workspace top bar and the Share dialog's "Manage shares"
 * link.
 */

import { useEffect, useState } from "react";
import { ShareNetwork, Trash, Copy, Check } from "@phosphor-icons/react";
import { listShares, revokeShare } from "../actions/share";
import type { ShareSummary } from "../../server/share-store";
import type { ShareMode } from "../../server/share-manifest";
import { Badge, Card, IconBadge } from "../../components/ui";
import { LinkEmailCard } from "../../components/LinkEmailCard";

/** Map a share mode to a pastel Badge variant. */
function modeBadgeVariant(mode: ShareMode): "blue" | "yellow" {
  return mode === "summary" ? "blue" : "yellow";
}

/** Human label for a share mode. */
function modeLabel(mode: ShareMode): string {
  return mode === "summary" ? "Summary" : "Full";
}

/** Format a creation timestamp as an absolute local date + time. */
function formatCreatedAt(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return new Date(ms).toISOString();
  }
}

/** Build the share link for a token against the current origin. */
function shareLinkFor(token: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/v/${token}`;
}

export default function SharesPage() {
  const [hydrated, setHydrated] = useState<boolean>(false);
  const [shares, setShares] = useState<ShareSummary[]>([]);
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    void (async () => {
      const list = await listShares();
      if (!active) return;
      setShares(list);
      setHydrated(true);
    })();
    return () => {
      active = false;
    };
  }, []);

  const handleCopy = async (token: string) => {
    try {
      await navigator.clipboard.writeText(shareLinkFor(token));
      setCopiedToken(token);
      setTimeout(() => {
        setCopiedToken((current) => (current === token ? null : current));
      }, 2000);
    } catch {
      // Clipboard unavailable — the link text is still visible to copy manually.
    }
  };

  const handleRevoke = async (token: string) => {
    setPendingToken(token);
    setErrors((prev) => {
      const next = { ...prev };
      delete next[token];
      return next;
    });

    try {
      const result = await revokeShare({ token });
      if (result.ok) {
        const list = await listShares();
        setShares(list);
      } else {
        setErrors((prev) => ({ ...prev, [token]: result.message }));
      }
    } catch {
      setErrors((prev) => ({
        ...prev,
        [token]: "Failed to revoke this share. Try again.",
      }));
    } finally {
      setPendingToken(null);
    }
  };

  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-3xl flex-col gap-8 px-6 py-10 animate-slide-up">
      <div className="flex flex-col gap-1">
        <a
          href="/"
          className="mb-1 inline-flex w-fit items-center gap-1.5 text-xs font-medium text-muted underline-offset-2 transition-colors hover:text-ink hover:underline"
        >
          ← Back to workspace
        </a>
        <h1 className="font-serif text-[28px] font-semibold tracking-tight text-ink">
          Manage shares
        </h1>
      </div>

      {/* Link email to account — lets others share to you by email */}
      <LinkEmailCard />

      {/* Empty state */}
      {hydrated && shares.length === 0 ? (
        <Card className="flex flex-col items-start gap-3 px-6 py-10">
          <IconBadge tone="neutral" className="h-9 w-9">
            <ShareNetwork size={18} weight="regular" aria-hidden="true" />
          </IconBadge>
          <div>
            <p className="text-sm font-medium text-ink">No active share links</p>
            <p className="mt-0.5 text-sm text-muted">
              Select one or more sessions in the workspace and choose &ldquo;Share
              selected&rdquo; to mint a link. Links you create will appear here so you can
              copy or revoke them anytime.
            </p>
          </div>
        </Card>
      ) : null}

      {/* Share rows */}
      {shares.length > 0 ? (
        <ul aria-label="Share links" className="flex flex-col gap-3">
          {shares.map((share) => {
            const pending = pendingToken === share.token;
            const error = errors[share.token];
            const revoked = share.revokedAt !== null;
            const copied = copiedToken === share.token;
            const link = shareLinkFor(share.token);
            return (
              <li key={share.token}>
                <Card className="flex flex-col gap-3 p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex min-w-0 flex-col gap-2">
                      <div className="flex items-center gap-2.5">
                        <Badge variant={modeBadgeVariant(share.manifest.mode)}>
                          {modeLabel(share.manifest.mode)}
                        </Badge>
                        {revoked ? <Badge variant="neutral">Revoked</Badge> : null}
                        <span className="font-mono text-xs text-muted">
                          {formatCreatedAt(share.createdAt)}
                        </span>
                      </div>
                      {share.label ? (
                        <p className="truncate font-mono text-sm text-ink" title={share.label}>
                          {share.label}
                        </p>
                      ) : null}
                      <div className="flex items-center gap-2">
                        <span className="truncate font-mono text-[11px] text-muted" title={link}>
                          {link}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            void handleCopy(share.token);
                          }}
                          className={[
                            "flex flex-shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors duration-150 focus:outline-none focus:ring-1 focus:ring-ink/20",
                            copied
                              ? "border-pastel-green bg-pastel-green text-pastel-greenText"
                              : "border-border bg-surface text-ink hover:bg-canvas",
                          ].join(" ")}
                          aria-label="Copy share link"
                        >
                          {copied ? (
                            <>
                              <Check size={12} weight="bold" aria-hidden="true" />
                              Copied
                            </>
                          ) : (
                            <>
                              <Copy size={12} weight="bold" aria-hidden="true" />
                              Copy
                            </>
                          )}
                        </button>
                      </div>
                    </div>

                    {revoked ? (
                      <span className="flex-shrink-0 px-3 py-2 text-xs font-medium text-muted">
                        Revoked
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          void handleRevoke(share.token);
                        }}
                        disabled={pending}
                        className="flex flex-shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium text-pastel-redText transition-colors duration-150 hover:bg-pastel-red disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-ink/20"
                      >
                        <Trash size={13} weight="bold" aria-hidden="true" />
                        {pending ? "Revoking..." : "Revoke"}
                      </button>
                    )}
                  </div>

                  {error ? (
                    <p
                      role="alert"
                      className="rounded-md border border-pastel-red bg-pastel-red px-3 py-2 text-xs text-pastel-redText"
                    >
                      {error}
                    </p>
                  ) : null}
                </Card>
              </li>
            );
          })}
        </ul>
      ) : null}
    </main>
  );
}
