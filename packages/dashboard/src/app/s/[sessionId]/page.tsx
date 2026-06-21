"use client";

/**
 * Owner session detail route — `/s/<sessionId>` (Wave M3).
 *
 * Reads the `sessionId` from the route params and calls the `getSessionDetail`
 * server action to gather that session's linked memories across the per-session
 * namespaces. Sections render in a fixed order:
 *
 *   1. Summary       — the session summary's full text (never truncated).
 *   2. Skills        — grid of {@link SkillCard}.
 *   3. Productivity  — grid of {@link ProductivityCard}.
 *   4. Transcript    — the transcript chunks IN FULL via {@link TranscriptCard},
 *                      in the server-provided (index-sorted) order.
 *
 * Each section shows a serif heading + a count and a quiet per-section empty
 * state. A "Share this session" button opens the {@link SharePanel} pre-seeded
 * with just this session id. When `getSessionDetail` reports
 * "Not authenticated" the page redirects to `/login`.
 */

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import type { RecallEntry } from "@uberwal/shared";
import { ShareNetwork, Warning } from "@phosphor-icons/react";

import { getSessionDetail } from "../../actions/recall";
import { SessionDetailView } from "../../../components/SessionDetailView";
import { SharePanel } from "../../../components/SharePanel";
import { Button } from "../../../components/ui";

interface SessionDetail {
  summary: RecallEntry | null;
  skills: RecallEntry[];
  productivity: RecallEntry[];
  transcripts: RecallEntry[];
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; detail: SessionDetail }
  | { kind: "error"; message: string };

/** Derive the session title from the summary's first non-empty line (shown in full). */
function detailTitle(summary: RecallEntry | null): string {
  if (summary === null) return "Session";
  const firstLine = summary.text.split("\n").find((line) => line.trim().length > 0);
  const base = (firstLine ?? "").trim();
  if (base.length === 0) return "Session";
  return base;
}

export default function SessionDetailPage() {
  const router = useRouter();
  const params = useParams<{ sessionId: string }>();
  const sessionId =
    typeof params.sessionId === "string" ? decodeURIComponent(params.sessionId) : "";

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [shareOpen, setShareOpen] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const outcome = await getSessionDetail({ sessionId });
      if (cancelled) return;
      if (!outcome.ok) {
        if (outcome.message === "Not authenticated") {
          router.replace("/login");
          return;
        }
        setState({ kind: "error", message: outcome.message });
        return;
      }
      setState({
        kind: "ready",
        detail: {
          summary: outcome.summary,
          skills: outcome.skills,
          productivity: outcome.productivity,
          transcripts: outcome.transcripts,
        },
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [router, sessionId]);

  const title =
    state.kind === "ready" ? detailTitle(state.detail.summary) : "Session";

  const shortId = sessionId.length > 14 ? `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}` : sessionId;

  const openShare = useCallback(() => setShareOpen(true), []);

  return (
    <div className="min-h-[100dvh] bg-canvas">
      {shareOpen ? (
        <SharePanel sessionIds={[sessionId]} onClose={() => setShareOpen(false)} />
      ) : null}

      {/* Top bar */}
      <header className="sticky top-0 z-30 border-b border-border bg-surface">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-6 py-3">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-muted transition-colors duration-150 hover:bg-canvas hover:text-ink focus:outline-none focus:ring-1 focus:ring-ink/20"
          >
            ← Back to workspace
          </Link>
          <div className="ml-auto">
            <Button variant="secondary" size="sm" onClick={openShare}>
              <ShareNetwork size={15} weight="bold" aria-hidden="true" />
              Share this session
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-5xl flex-col gap-10 px-6 py-10 animate-slide-up">
        {/* Title */}
        <div className="flex flex-col gap-1.5">
          <h1 className="font-serif text-[28px] font-semibold leading-tight tracking-tight text-ink">
            {title}
          </h1>
          {sessionId.length > 0 ? (
            <span className="font-mono text-xs text-muted">{shortId}</span>
          ) : null}
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
                This session could not be loaded.
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
            <span className="ml-1 text-sm">Loading session…</span>
          </div>
        ) : null}

        {state.kind === "ready" ? (
          <SessionDetailView
            summary={state.detail.summary}
            skills={state.detail.skills}
            productivity={state.detail.productivity}
            transcripts={state.detail.transcripts}
          />
        ) : null}
      </main>
    </div>
  );
}
