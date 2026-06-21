"use client";

/**
 * SharePanel — selection-driven, server-mediated share link minting.
 *
 * Replaces the old global "Share" header button + {@link ShareDialog}. The
 * workspace now drives sharing from a *selection*: the owner selects one or
 * more sessions (or opens this panel from a single session's detail page) and
 * this panel mints a link scoped to exactly those `sessionIds`.
 *
 * Token model (server-mediated): "Create link" calls the `createShare` server
 * action with `{ mode, sessionIds }`, which mints a *dedicated* on-chain
 * delegate key, stores it ENCRYPTED server-side alongside a manifest (the
 * allowed namespaces for the mode + the session-id whitelist), and returns only
 * a random opaque token. The panel assembles that token into a canonical link:
 *
 *   ${origin}/v/<token>
 *
 * The delegate private key never reaches the browser. A recipient opening the
 * token is recalled on their behalf by the server, which enforces the manifest
 * (mode + the specific sessions). A link is an opaque handle, not a credential.
 */

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { ShareNetwork, X, CircleNotch, Copy, Check, Warning } from "@phosphor-icons/react";
import type { ShareMode } from "../server/share-manifest";
import { createShare } from "../app/actions/share";
import { Button } from "./ui";

export interface SharePanelProps {
  /** The selected session ids this link will be scoped to. */
  sessionIds: string[];
  /**
   * Project/repository the selected sessions belong to, when they share one.
   * Recorded on the share so the recipient view + assistant are repo-scoped.
   */
  repo?: string;
  /** Close the panel (Escape, overlay click, X, or after navigation). */
  onClose: () => void;
}

const SHARE_MODES: Array<{ value: ShareMode; label: string; description: string }> = [
  { value: "summary", label: "Summary", description: "Skills, productivity, sessions & reports" },
  { value: "full", label: "Full", description: "Everything, including full transcripts" },
];

type PanelState =
  | { kind: "idle" }
  | { kind: "creating" }
  | { kind: "ready"; url: string }
  | { kind: "error"; message: string };

/** Build the canonical server-mediated share link (token only — never a key). */
function buildShareLink(input: { origin: string; token: string }): string {
  return `${input.origin}/v/${input.token}`;
}

export function SharePanel({ sessionIds, repo, onClose }: SharePanelProps) {
  const [mode, setMode] = useState<ShareMode>("summary");
  const [sharedByName, setSharedByName] = useState<string>("");
  const [recipientAccountId, setRecipientAccountId] = useState<string>("");
  const [state, setState] = useState<PanelState>({ kind: "idle" });
  const [copied, setCopied] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const count = sessionIds.length;

  // Close on Escape.
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // Prevent body scroll while open.
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  // Clear any pending copy timeout on unmount.
  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const handleCreate = async () => {
    setState({ kind: "creating" });
    try {
      const result = await createShare({
        mode,
        sessionIds,
        sharedBy: sharedByName,
        recipientAccountId,
        ...(repo !== undefined && repo.length > 0 ? { repo } : {}),
      });
      if (!result.ok) {
        setState({ kind: "error", message: result.message });
        return;
      }

      const origin = typeof window !== "undefined" ? window.location.origin : "";
      const url = buildShareLink({ origin, token: result.token });

      setState({ kind: "ready", url });
    } catch {
      setState({ kind: "error", message: "Failed to create share link. Try again." });
    }
  };

  const handleCopy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable — the field is selectable as a fallback.
    }
  };

  const handleModeChange = (next: ShareMode) => {
    setMode(next);
    // Reset so the user re-mints a dedicated token for the new mode.
    if (state.kind === "ready" || state.kind === "error") {
      setState({ kind: "idle" });
    }
  };

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 px-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div
        className="relative w-full max-w-md rounded-xl border border-border bg-surface shadow-[0_8px_30px_rgba(0,0,0,0.08)]"
        role="dialog"
        aria-modal="true"
        aria-label="Create a share link for the selected sessions"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-canvas text-ink">
              <ShareNetwork size={15} weight="bold" aria-hidden="true" />
            </span>
            <div>
              <h2 className="font-serif text-base font-semibold tracking-tight text-ink">
                Share selected
              </h2>
              <p className="text-xs text-muted">
                Shares {count} selected session{count === 1 ? "" : "s"}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-canvas hover:text-ink focus:outline-none focus:ring-1 focus:ring-ink/20"
            aria-label="Close"
          >
            <X size={15} weight="bold" aria-hidden="true" />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-col gap-4 px-5 py-4">
          {/* Mode selector */}
          <div>
            <p className="mb-2.5 text-xs font-medium text-muted">What to share</p>
            <div className="grid grid-cols-2 gap-2">
              {SHARE_MODES.map((option) => {
                const selected = mode === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => handleModeChange(option.value)}
                    aria-pressed={selected}
                    className={[
                      "flex flex-col gap-0.5 rounded-lg border px-3 py-2.5 text-left transition-colors duration-150 focus:outline-none focus:ring-1 focus:ring-ink/20",
                      selected
                        ? "border-ink bg-canvas"
                        : "border-border text-muted hover:border-ink/40",
                    ].join(" ")}
                  >
                    <span
                      className={[
                        "text-xs font-semibold",
                        selected ? "text-ink" : "text-muted",
                      ].join(" ")}
                    >
                      {option.label}
                    </span>
                    <span className="text-[11px] leading-tight text-muted">
                      {option.description}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Selection summary */}
          <p className="text-[11px] text-muted">
            This link will include{" "}
            <span className="font-medium text-ink">
              {count} selected session{count === 1 ? "" : "s"}
            </span>
            {repo !== undefined && repo.length > 0 ? (
              <>
                {" "}
                from project <span className="font-mono text-ink">{repo}</span>
              </>
            ) : null}
            .
          </p>

          {/* Shared-by identity */}
          <div>
            <label
              htmlFor="share-shared-by"
              className="mb-2 block text-xs font-medium text-muted"
            >
              Shared by
            </label>
            <input
              id="share-shared-by"
              type="text"
              value={sharedByName}
              onChange={(e) => setSharedByName(e.target.value)}
              placeholder="Your name (shown to the recipient)"
              maxLength={80}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-ink focus:outline-none focus:ring-1 focus:ring-ink/20"
            />
            <p className="mt-1 text-[11px] leading-relaxed text-muted">
              Optional. If left blank, the recipient sees a short form of your
              account id.
            </p>
          </div>

          {/* Address to a recipient (optional) — also shows in their inbox */}
          <div>
            <label
              htmlFor="share-recipient"
              className="mb-2 block text-xs font-medium text-muted"
            >
              Share to (account id)
            </label>
            <input
              id="share-recipient"
              type="text"
              value={recipientAccountId}
              onChange={(e) => {
                setRecipientAccountId(e.target.value);
                if (state.kind === "ready" || state.kind === "error") {
                  setState({ kind: "idle" });
                }
              }}
              placeholder="0x… recipient account id"
              spellCheck={false}
              autoCapitalize="none"
              className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-[12px] text-ink placeholder:text-muted focus:border-ink focus:outline-none focus:ring-1 focus:ring-ink/20"
            />
            <p className="mt-1 text-[11px] leading-relaxed text-muted">
              Optional. When set, this share also appears in that account&apos;s
              &ldquo;Shared with me&rdquo; page after they sign in. The link still
              works on its own.
            </p>
          </div>

          {/* Create button */}
          {state.kind !== "ready" && (
            <Button
              type="button"
              variant="primary"
              onClick={() => {
                void handleCreate();
              }}
              disabled={state.kind === "creating" || count === 0}
              className="w-full"
            >
              {state.kind === "creating" ? (
                <>
                  <CircleNotch size={15} weight="bold" className="animate-spin" aria-hidden="true" />
                  Creating link...
                </>
              ) : (
                <>
                  <ShareNetwork size={15} weight="bold" aria-hidden="true" />
                  Create link
                </>
              )}
            </Button>
          )}

          {/* Error state */}
          {state.kind === "error" && (
            <div
              role="alert"
              className="flex items-start gap-2.5 rounded-md border border-pastel-red bg-pastel-red px-3 py-2.5"
            >
              <Warning
                size={15}
                weight="bold"
                className="mt-0.5 flex-shrink-0 text-pastel-redText"
                aria-hidden="true"
              />
              <div className="text-xs">
                <p className="font-medium text-pastel-redText">{state.message}</p>
                <p className="mt-1 leading-relaxed text-pastel-redText">
                  Server-mediated sharing requires the owner&apos;s on-chain config
                  (SUI_PRIVATE_KEY + MEMWAL_PACKAGE_ID).
                </p>
              </div>
            </div>
          )}

          {/* Ready: show link */}
          {state.kind === "ready" && (
            <div className="flex flex-col gap-2.5">
              <p className="text-xs font-medium text-muted">Share link</p>
              <div className="flex items-stretch gap-2">
                <div className="min-w-0 flex-1 rounded-md border border-border bg-canvas px-3 py-2">
                  <input
                    readOnly
                    value={state.url}
                    title={state.url}
                    aria-label="Share link"
                    className="w-full truncate bg-transparent font-mono text-[11px] text-ink focus:outline-none"
                    onFocus={(e) => e.currentTarget.select()}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => {
                    void handleCopy(state.url);
                  }}
                  className={[
                    "flex flex-shrink-0 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition-colors duration-150 focus:outline-none focus:ring-1 focus:ring-ink/20",
                    copied
                      ? "border-pastel-green bg-pastel-green text-pastel-greenText"
                      : "border-border bg-surface text-ink hover:bg-canvas",
                  ].join(" ")}
                  aria-label="Copy share link"
                >
                  {copied ? (
                    <>
                      <Check size={13} weight="bold" aria-hidden="true" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy size={13} weight="bold" aria-hidden="true" />
                      Copy
                    </>
                  )}
                </button>
              </div>

              <button
                type="button"
                onClick={() => setState({ kind: "idle" })}
                className="self-start text-[11px] text-muted underline-offset-2 hover:text-ink hover:underline"
              >
                Create another link
              </button>
            </div>
          )}

          {/* Security note */}
          <div className="rounded-md border border-border bg-canvas px-3 py-2.5">
            <div className="flex items-start gap-2">
              <Warning
                size={13}
                weight="bold"
                className="mt-0.5 flex-shrink-0 text-muted"
                aria-hidden="true"
              />
              <div>
                <p className="text-[11px] font-medium text-ink">Security note</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
                  The link is an opaque token — the recipient never receives a key. Access is
                  enforced server-side per this share&apos;s manifest (mode + the selected
                  sessions), and you can revoke it anytime from Manage shares. On-chain mint and
                  revoke each cost gas, and an account is limited to roughly 20 delegate keys.
                </p>
              </div>
            </div>
          </div>

          {/* Manage shares link */}
          <div className="border-t border-border pt-3">
            <Link
              href="/shares"
              onClick={onClose}
              className="text-xs font-medium text-muted underline-offset-2 transition-colors hover:text-ink hover:underline"
            >
              Manage shares
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

export default SharePanel;
