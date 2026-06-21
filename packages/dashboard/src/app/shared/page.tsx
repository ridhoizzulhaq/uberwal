"use client";

/**
 * "Shared with me" — the inbox of shares ADDRESSED to the signed-in account.
 *
 * When an owner creates a share and addresses it to a recipient's account id,
 * that share shows up here after the recipient signs in (no link needed). Each
 * row opens the server-mediated view at `/v/<token>`; the token remains the
 * access mechanism — this page just surfaces it to the addressed recipient.
 *
 * Requires a session: an unauthenticated viewer is routed to `/login`.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CalendarBlank, Tray, Warning, X } from "@phosphor-icons/react";

import { listSharesForMe, type SharedWithMeItem } from "../actions/share";
import { DashboardShell } from "../../components/DashboardShell";
import { CompareDrawer } from "../../components/CompareDrawer";
import { Badge, Button, Card, IconBadge } from "../../components/ui";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; items: SharedWithMeItem[] }
  | { kind: "error"; message: string };

/** Format an epoch-ms timestamp as a short, locale-stable UTC date. */
function formatDate(ms: number): string {
  try {
    return new Date(ms).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

export default function SharedWithMePage() {
  const router = useRouter();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [compareOpen, setCompareOpen] = useState<boolean>(false);

  const toggleSelected = useCallback((token: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(token)) next.delete(token);
      else next.add(token);
      return next;
    });
  }, []);

  const selectedTokens = Array.from(selected);
  const selectedSources =
    state.kind === "ready"
      ? state.items
          .filter((item) => selected.has(item.token))
          .map((item) => ({
            token: item.token,
            subject:
              item.label !== null && item.label.length > 0
                ? item.label
                : "Shared session",
          }))
      : [];

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const outcome = await listSharesForMe();
      if (cancelled) return;
      if (!outcome.ok) {
        if (outcome.message === "Not authenticated") {
          router.replace("/login");
          return;
        }
        setState({ kind: "error", message: outcome.message });
        return;
      }
      setState({ kind: "ready", items: outcome.items });
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <DashboardShell>
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10 pb-28 animate-slide-up">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-[28px] font-semibold tracking-tight text-ink">
            Shared with me
          </h1>
          <p className="text-sm leading-relaxed text-muted">
            Sessions other people have shared with your account. Open one to view
            what they shared — no link needed.
          </p>
        </div>

        {state.kind === "error" ? (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-lg border border-pastel-red bg-pastel-red px-4 py-3"
          >
            <Warning
              size={16}
              weight="bold"
              className="mt-0.5 flex-shrink-0 text-pastel-redText"
              aria-hidden="true"
            />
            <div className="text-sm">
              <span className="font-medium text-pastel-redText">
                Your shared items could not be loaded.
              </span>{" "}
              <span className="text-pastel-redText">{state.message}</span>
            </div>
          </div>
        ) : null}

        {state.kind === "loading" ? (
          <div className="flex items-center gap-3 text-muted">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted" style={{ animationDelay: "0ms" }} />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted" style={{ animationDelay: "150ms" }} />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted" style={{ animationDelay: "300ms" }} />
            <span className="ml-1 text-sm">Loading…</span>
          </div>
        ) : null}

        {state.kind === "ready" && state.items.length === 0 ? (
          <div
            role="status"
            className="flex flex-col items-start gap-3 rounded-lg border border-border bg-surface px-6 py-10"
          >
            <IconBadge tone="neutral" className="h-9 w-9">
              <Tray size={18} weight="regular" aria-hidden="true" />
            </IconBadge>
            <p className="text-sm font-medium text-ink">Nothing shared with you yet</p>
            <p className="text-sm text-muted">
              When someone addresses a share to your account id, it appears here.
            </p>
          </div>
        ) : null}

        {state.kind === "ready" && state.items.length > 0 ? (
          <ul aria-label="Shared with me" className="flex flex-col gap-3">
            {state.items.map((item) => {
              const isSelected = selected.has(item.token);
              const title =
                item.label !== null && item.label.length > 0
                  ? item.label
                  : "Shared session";
              return (
                <li key={item.token}>
                  <Card className="flex items-start gap-3 p-5 transition-colors hover:bg-canvas">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelected(item.token)}
                      aria-label={`Select "${title}" for comparison`}
                      className="mt-1.5 h-4 w-4 flex-shrink-0 cursor-pointer accent-ink"
                    />
                    <Link
                      href={`/v/${item.token}`}
                      className="flex min-w-0 flex-1 items-start gap-3"
                    >
                      <IconBadge tone="neutral" className="mt-0.5 h-8 w-8">
                        <CalendarBlank size={16} weight="regular" aria-hidden="true" />
                      </IconBadge>
                      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                        <span className="font-serif text-[17px] font-semibold leading-snug tracking-tight text-ink">
                          {title}
                        </span>
                        <span className="break-all text-xs text-muted">
                          from <span className="font-medium text-ink">{item.sender}</span>
                        </span>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant={item.mode === "summary" ? "blue" : "yellow"}>
                            {item.mode === "summary" ? "Summary" : "Full"}
                          </Badge>
                          {item.sessionScoped ? (
                            <Badge variant="neutral">Specific sessions</Badge>
                          ) : null}
                          {item.repo !== null && item.repo.length > 0 ? (
                            <Badge variant="neutral">{item.repo}</Badge>
                          ) : null}
                          <span className="font-mono text-[11px] text-muted">
                            {formatDate(item.createdAt)}
                          </span>
                        </div>
                      </div>
                    </Link>
                  </Card>
                </li>
              );
            })}
          </ul>
        ) : null}
      </main>

      {/* Selection action bar — compare the selected shares in the AI. */}
      {selectedTokens.length > 0 ? (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface/95 backdrop-blur-sm">
          <div className="mx-auto flex max-w-5xl items-center gap-3 px-6 py-3">
            <Badge variant="neutral">{selectedTokens.length} selected</Badge>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="inline-flex items-center gap-1 text-xs font-medium text-muted underline-offset-2 transition-colors hover:text-ink hover:underline"
            >
              <X size={13} weight="bold" aria-hidden="true" />
              Clear
            </button>
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => setCompareOpen(true)}
              >
                Assistant
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <CompareDrawer
        open={compareOpen && selectedSources.length >= 1}
        onClose={() => setCompareOpen(false)}
        sources={selectedSources}
      />
    </DashboardShell>
  );
}
