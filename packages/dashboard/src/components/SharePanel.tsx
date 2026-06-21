"use client";

/**
 * SharePanel — selection-driven, server-mediated share link minting.
 *
 * Replaces the old global "Share" header button + {@link ShareDialog}. The
 * workspace now drives sharing from a *selection*: the owner selects one or
 * more sessions (or opens this panel from a single session's detail page) and
 * this panel mints a link scoped to exactly those `sessionIds`.
 *
 * Token model (server-mediated, DB-only): "Create link" calls the `createShare`
 * server action with `{ mode, sessionIds, repo?, recipient? }`, which stores the
 * owner's logged-in delegate key ENCRYPTED server-side alongside a manifest (the
 * allowed namespaces for the mode + the session-id/repo scope), and returns only
 * a random opaque token. No on-chain mint, no gas. The panel assembles that
 * token into a canonical link:
 *
 *   ${origin}/v/<token>
 *
 * The delegate private key never reaches the browser. A recipient opening the
 * token is recalled on their behalf by the server, which enforces the manifest
 * (mode + the specific sessions). A link is an opaque handle, not a credential.
 */

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { ShareNetwork, X, CircleNotch, Copy, Check, Warning, MagnifyingGlass } from "@phosphor-icons/react";
import type { ShareMode } from "../server/share-manifest";
import { createShare } from "../app/actions/share";
import { lookupEmail } from "../app/actions/directory";
import { Button } from "./ui";

/** A `0x`-prefixed 64-hex Sui account object id. */
const ACCOUNT_ID_RE = /^0x[0-9a-fA-F]{64}$/;
/** Conservative email shape check (mirrors the directory action). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Shorten an account id for compact display. */
function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 6)}…${id.slice(-4)}`;
}

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

/** Email-lookup state for the "Share to" field when an email is entered. */
type LookupState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "found"; accountId: string }
  | { kind: "notfound" }
  | { kind: "error"; message: string };

/** Build the canonical server-mediated share link (token only — never a key). */
function buildShareLink(input: { origin: string; token: string }): string {
  return `${input.origin}/v/${input.token}`;
}

export function SharePanel({ sessionIds, repo, onClose }: SharePanelProps) {
  const [mode, setMode] = useState<ShareMode>("summary");
  const [subject, setSubject] = useState<string>("");
  const [recipient, setRecipient] = useState<string>("");
  const [lookup, setLookup] = useState<LookupState>({ kind: "idle" });
  const [state, setState] = useState<PanelState>({ kind: "idle" });
  const [copied, setCopied] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const count = sessionIds.length;

  const trimmedRecipient = recipient.trim();
  const recipientIsEmail = EMAIL_RE.test(trimmedRecipient);
  const recipientIsAccount = ACCOUNT_ID_RE.test(trimmedRecipient);
  const recipientInvalid =
    trimmedRecipient.length > 0 && !recipientIsEmail && !recipientIsAccount;

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
        ...(subject.trim().length > 0 ? { label: subject.trim() } : {}),
        ...(recipientIsAccount ? { recipientAccountId: trimmedRecipient } : {}),
        ...(recipientIsEmail ? { recipientEmail: trimmedRecipient } : {}),
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

  /** Resolve the entered email to an account id (preview before sharing). */
  const handleCheckEmail = async () => {
    const email = trimmedRecipient.toLowerCase();
    if (!EMAIL_RE.test(email)) return;
    setLookup({ kind: "checking" });
    try {
      const res = await lookupEmail({ email });
      if (!res.ok) {
        setLookup({ kind: "error", message: res.message });
        return;
      }
      setLookup(
        res.accountId !== null
          ? { kind: "found", accountId: res.accountId }
          : { kind: "notfound" },
      );
    } catch {
      setLookup({ kind: "error", message: "Lookup failed. Try again." });
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

          {/* Subject */}
          <div>
            <label
              htmlFor="share-subject"
              className="mb-2 block text-xs font-medium text-muted"
            >
              Subject
            </label>
            <input
              id="share-subject"
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="e.g. React/Next.js work for review"
              maxLength={120}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-ink focus:outline-none focus:ring-1 focus:ring-ink/20"
            />
            <p className="mt-1 text-[11px] leading-relaxed text-muted">
              Optional. A short title for this share, shown to the recipient. If
              left blank, a default label is used. &ldquo;Shared by&rdquo; is taken
              from your linked email automatically.
            </p>
          </div>

          {/* Address to a recipient (optional) — account id OR email */}
          <div>
            <label
              htmlFor="share-recipient"
              className="mb-2 block text-xs font-medium text-muted"
            >
              Share to (account id or email)
            </label>
            <div className="flex items-stretch gap-2">
              <input
                id="share-recipient"
                type="text"
                value={recipient}
                onChange={(e) => {
                  setRecipient(e.target.value);
                  setLookup({ kind: "idle" });
                  if (state.kind === "ready" || state.kind === "error") {
                    setState({ kind: "idle" });
                  }
                }}
                placeholder="0x… account id or name@example.com"
                spellCheck={false}
                autoCapitalize="none"
                className="min-w-0 flex-1 rounded-md border border-border bg-surface px-3 py-2 font-mono text-[12px] text-ink placeholder:text-muted focus:border-ink focus:outline-none focus:ring-1 focus:ring-ink/20"
              />
              {recipientIsEmail ? (
                <button
                  type="button"
                  onClick={() => void handleCheckEmail()}
                  disabled={lookup.kind === "checking"}
                  className="flex flex-shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-xs font-medium text-ink transition-colors hover:bg-canvas focus:outline-none focus:ring-1 focus:ring-ink/20 disabled:opacity-50"
                  aria-label="Look up the account for this email"
                >
                  {lookup.kind === "checking" ? (
                    <CircleNotch size={13} weight="bold" className="animate-spin" aria-hidden="true" />
                  ) : (
                    <MagnifyingGlass size={13} weight="bold" aria-hidden="true" />
                  )}
                  Check
                </button>
              ) : null}
            </div>

            {/* Email lookup result */}
            {recipientIsEmail && lookup.kind === "found" ? (
              <p className="mt-1.5 text-[11px] text-pastel-greenText">
                → linked to account{" "}
                <span className="font-mono text-ink">{shortId(lookup.accountId)}</span>
              </p>
            ) : null}
            {recipientIsEmail && lookup.kind === "notfound" ? (
              <p className="mt-1.5 text-[11px] text-pastel-redText">
                No account is linked to this email yet — they must link it under
                &ldquo;Link email&rdquo; first.
              </p>
            ) : null}
            {recipientIsEmail && lookup.kind === "error" ? (
              <p className="mt-1.5 text-[11px] text-pastel-redText">{lookup.message}</p>
            ) : null}
            {recipientInvalid ? (
              <p className="mt-1.5 text-[11px] text-pastel-redText">
                Enter a full account id (0x…) or a valid email.
              </p>
            ) : null}

            <p className="mt-1 text-[11px] leading-relaxed text-muted">
              Optional. When set, the share is <span className="font-medium text-ink">addressed</span>:
              only that account can open the link (after signing in), and it appears in their
              &ldquo;Shared with me&rdquo; page. Leave blank for an open link anyone can view.
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
              disabled={state.kind === "creating" || count === 0 || recipientInvalid}
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
                  enforced server-side per this share&apos;s manifest, and you can revoke it
                  anytime from Manage shares (revocation is instant — no gas). When addressed to
                  an account or email, only that recipient can open it after signing in.
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
