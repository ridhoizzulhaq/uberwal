"use client";

/**
 * Server-mediated share recipient view — "anyone with the link can view".
 *
 * ZERO setup: no login, no role switch, no distance slider. The link carries
 * only an opaque token in the path (`/v/<token>`). On mount we resolve the
 * token to lightweight metadata via `getShareMeta` AND list the shared sessions
 * via `listSessionsByToken`; the delegate key never reaches the browser — every
 * recall and assistant turn is mediated by the server, which enforces the
 * share's manifest (including the session whitelist).
 *
 * The view is SESSION-CENTRIC, mirroring the owner workspace: it lists the
 * shared sessions and, when one is opened, lazily loads its full detail via
 * `getSessionDetailByToken` (cached in state) and renders it with the shared
 * {@link SessionDetailView}. When no sessions are available to this token (the
 * `sessions` namespace isn't shared, or none survive the manifest's session
 * whitelist) it falls back to the per-namespace {@link TokenNamespaceView} so
 * the recipient still sees the allowed namespaces.
 *
 * This route lives outside the (dashboard) route group, so it renders with the
 * root layout only — no sidebar, no auth gate.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { CaretDown, ChatCircle, Warning, X } from "@phosphor-icons/react";
import type { Namespace, RecallEntry } from "@uberwal/shared";
import {
  getShareMeta,
  listSessionsByToken,
  getSessionDetailByToken,
  askReaderByToken,
  type ShareMetaResult,
} from "../../actions/shared-access";
import type { SessionSummary } from "../../actions/recall";
import { ReaderChat } from "../../../components/ReaderChat";
import { AssistantDrawer } from "../../../components/AssistantDrawer";
import { SessionDetailView } from "../../../components/SessionDetailView";
import { TokenNamespaceView } from "../../../components/TokenNamespaceView";
import { Badge, Button, Card, IconBadge } from "../../../components/ui";

type ShareMeta = Extract<ShareMetaResult, { ok: true }>;

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; meta: ShareMeta; sessions: SessionSummary[] }
  | { kind: "error"; message: string; needsLogin?: boolean };

interface SessionDetail {
  summary: RecallEntry | null;
  skills: RecallEntry[];
  productivity: RecallEntry[];
  transcripts: RecallEntry[];
}

/** Per-session lazy-load state, cached so a session loads at most once. */
type DetailState =
  | { kind: "loading" }
  | { kind: "ready"; detail: SessionDetail }
  | { kind: "error"; message: string };

/** Derive a short, human title from a session summary's text (first line). */
function sessionTitle(text: string): string {
  const firstLine = text.split("\n").find((line) => line.trim().length > 0);
  const base = (firstLine ?? text).trim();
  if (base.length === 0) return "Untitled session";
  return base.length > 80 ? `${base.slice(0, 80)}…` : base;
}

/** Derive a one-line muted preview (the text after the title), if any. */
function sessionPreview(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const collapsed = trimmed.replace(/\s+/g, " ");
  if (collapsed.length <= 80) return null;
  const preview = collapsed.slice(80, 220).trim();
  return preview.length > 0 ? `${preview}…` : null;
}

function ErrorCard({ message, needsLogin }: { message: string; needsLogin?: boolean }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <Card className="max-w-md p-6">
        <div className="flex flex-col items-start gap-3">
          <IconBadge tone="red" className="h-9 w-9">
            <Warning size={18} weight="bold" aria-hidden="true" />
          </IconBadge>
          <div>
            <h1 className="font-serif text-lg font-semibold tracking-tight text-ink">
              {needsLogin ? "Sign in to view" : "Link unavailable"}
            </h1>
            <p className="mt-1 text-sm leading-relaxed text-muted">{message}</p>
            {needsLogin ? (
              <a
                href="/login"
                className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-2 text-xs font-medium text-ink transition-colors hover:bg-canvas focus:outline-none focus:ring-1 focus:ring-ink/20"
              >
                Sign in, then reopen this link
              </a>
            ) : null}
          </div>
        </div>
      </Card>
    </main>
  );
}

/** Three-dot bouncing loader used for inline detail loads. */
function DotLoader({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 text-muted">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted" style={{ animationDelay: "0ms" }} />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted" style={{ animationDelay: "150ms" }} />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted" style={{ animationDelay: "300ms" }} />
      <span className="ml-1 text-sm">{label}</span>
    </div>
  );
}

/**
 * One shared session row with inline-expand. Clicking the header toggles the
 * detail; the first open lazily loads it via `getSessionDetailByToken`, after
 * which it stays cached in the parent's state.
 */
function SharedSessionRow({
  token,
  session,
  selected,
  onToggleSelect,
}: {
  token: string;
  session: SessionSummary;
  selected: boolean;
  onToggleSelect: () => void;
}) {
  const [open, setOpen] = useState<boolean>(false);
  const [detail, setDetail] = useState<DetailState | null>(null);

  const sessionId = session.sessionId;
  const title = sessionTitle(session.text);
  const preview = sessionPreview(session.text);

  const toggle = useCallback(() => {
    const next = !open;
    setOpen(next);
    // Lazy-load on first open; cache afterwards. The side effects live OUTSIDE
    // any setState updater so we never trigger a state update during another
    // component's render (which React flags as a setState-in-render error).
    if (next && detail === null && sessionId !== null) {
      setDetail({ kind: "loading" });
      void (async () => {
        const outcome = await getSessionDetailByToken({ token, sessionId });
        if (!outcome.ok) {
          setDetail({ kind: "error", message: outcome.message });
          return;
        }
        setDetail({
          kind: "ready",
          detail: {
            summary: outcome.summary,
            skills: outcome.skills,
            productivity: outcome.productivity,
            transcripts: outcome.transcripts,
          },
        });
      })();
    }
  }, [open, detail, sessionId, token]);

  // Legacy sessions (no sessionId) can't be gathered individually.
  const isLegacy = sessionId === null;

  return (
    <li>
      <Card className="flex flex-col">
        <div className="flex items-start gap-3 p-5">
          {isLegacy ? (
            <span className="mt-1 h-4 w-4 flex-shrink-0" aria-hidden="true" />
          ) : (
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggleSelect}
              aria-label={`Select session ${title}`}
              className="mt-1 h-4 w-4 flex-shrink-0 cursor-pointer accent-ink"
            />
          )}
          <button
            type="button"
            onClick={toggle}
            disabled={isLegacy}
            aria-expanded={open}
            className="flex min-w-0 flex-1 items-start gap-3 text-left focus:outline-none focus:ring-1 focus:ring-ink/20 disabled:cursor-default"
          >
            <CaretDown
              size={16}
              weight="bold"
              className="mt-1 flex-shrink-0 text-muted transition-transform duration-150"
              style={{ transform: open ? "rotate(180deg)" : "none" }}
              aria-hidden="true"
            />
            <span className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className="font-serif text-[17px] font-semibold leading-snug tracking-tight text-ink">
                {title}
              </span>
              {preview !== null ? (
                <span className="line-clamp-2 text-sm leading-relaxed text-muted">
                  {preview}
                </span>
              ) : null}
              {isLegacy ? (
                <span className="text-[11px] text-muted">
                  legacy — no per-session detail
                </span>
              ) : null}
            </span>
          </button>
        </div>

        {open && !isLegacy ? (
          <div className="flex flex-col gap-8 border-t border-border px-5 py-6">
            {detail === null || detail.kind === "loading" ? (
              <DotLoader label="Loading session…" />
            ) : null}
            {detail !== null && detail.kind === "error" ? (
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
                  <span className="text-pastel-redText">{detail.message}</span>
                </div>
              </div>
            ) : null}
            {detail !== null && detail.kind === "ready" ? (
              <SessionDetailView
                summary={detail.detail.summary}
                skills={detail.detail.skills}
                productivity={detail.detail.productivity}
                transcripts={detail.detail.transcripts}
              />
            ) : null}
          </div>
        ) : null}
      </Card>
    </li>
  );
}

export default function TokenSharePage() {
  const params = useParams<{ token: string }>();
  const token = typeof params.token === "string" ? params.token : "";

  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [meta, sessionList] = await Promise.all([
        getShareMeta({ token }),
        listSessionsByToken({ token }),
      ]);
      if (cancelled) return;
      if (!meta.ok) {
        setState({
          kind: "error",
          message: meta.message,
          needsLogin: meta.needsLogin === true,
        });
        return;
      }
      if (meta.revoked) {
        setState({ kind: "error", message: "This shared link has been revoked." });
        return;
      }
      const sessions = sessionList.ok ? sessionList.sessions : [];
      setState({ kind: "ready", meta, sessions });
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assistantOpen, setAssistantOpen] = useState<boolean>(false);

  const toggleSelected = useCallback((sessionId: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);

  const clearSelection = useCallback((): void => setSelected(new Set()), []);

  if (state.kind === "loading") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-canvas px-4">
        <DotLoader label="Opening shared view…" />
      </main>
    );
  }

  if (state.kind === "error") {
    return <ErrorCard message={state.message} needsLogin={state.needsLogin === true} />;
  }

  const { meta, sessions } = state;
  const modeBadge =
    meta.mode === "summary"
      ? { variant: "blue" as const, label: "Summary" }
      : { variant: "yellow" as const, label: "Full" };

  const hasSessions = sessions.length > 0;

  // Selected shared sessions (with titles) the recipient assistant scopes to.
  const selectedSessions = sessions
    .filter(
      (s): s is SessionSummary & { sessionId: string } =>
        s.sessionId !== null && selected.has(s.sessionId),
    )
    .map((s) => ({ id: s.sessionId, title: sessionTitle(s.text) }));
  const selectedCount = selectedSessions.length;

  return (
    <main className="min-h-screen bg-canvas">
      {/* Top bar */}
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-2 px-6 py-4">
          <span className="font-serif text-lg font-semibold tracking-tight text-ink">
            Uberwal
          </span>
          <Badge variant="neutral">Shared view</Badge>
          <Badge variant={modeBadge.variant}>{modeBadge.label}</Badge>
          <span className="break-all text-sm text-muted">
            Shared by <span className="font-medium text-ink">{meta.sharedBy}</span>
          </span>
          {meta.label !== null && meta.label.length > 0 ? (
            <span className="text-sm text-ink">{meta.label}</span>
          ) : null}
          {meta.sessionScoped ? (
            <Badge variant="neutral">Specific sessions shared</Badge>
          ) : null}
          {meta.repo !== null && meta.repo.length > 0 ? (
            <Badge variant="neutral">Project: {meta.repo}</Badge>
          ) : null}
          <p className="basis-full text-sm text-muted sm:basis-auto sm:ml-auto">
            Read-only access shared with you.
          </p>
        </div>
      </header>

      {/* Content */}
      <div className="mx-auto flex max-w-5xl flex-col gap-12 px-6 py-12 pb-28">
        {hasSessions ? (
          /* Session-centric view: select sessions to ask the assistant, or open one to read. */
          <section className="flex flex-col gap-4 animate-slide-up">
            <div className="flex flex-col gap-1">
              <h2 className="font-serif text-[22px] font-semibold tracking-tight text-ink">
                Shared sessions
              </h2>
              <p className="text-sm leading-relaxed text-muted">
                Open a session to read its detail, or select sessions and ask the
                assistant about them. You see only what was shared with you.
              </p>
            </div>
            <ul aria-label="Shared sessions" className="flex flex-col gap-3">
              {sessions.map((session) => (
                <SharedSessionRow
                  key={session.blob_id}
                  token={token}
                  session={session}
                  selected={
                    session.sessionId !== null && selected.has(session.sessionId)
                  }
                  onToggleSelect={() => {
                    if (session.sessionId !== null) toggleSelected(session.sessionId);
                  }}
                />
              ))}
            </ul>
          </section>
        ) : (
          /* Fallback: per-namespace rendering for the allowed namespaces. */
          meta.namespaces.map((namespace: Namespace) => (
            <section key={namespace} className="flex flex-col gap-4 animate-slide-up">
              <h2 className="font-serif text-[22px] font-semibold capitalize tracking-tight text-ink">
                {namespace}
              </h2>
              <TokenNamespaceView token={token} namespace={namespace} />
            </section>
          ))
        )}

        {/* Whole-share Reader chat — only for the per-namespace fallback. The
            session-centric view uses the selection-driven assistant below. */}
        {!hasSessions ? (
          <section className="flex flex-col gap-4 animate-slide-up">
            <div className="flex flex-col gap-1">
              <h2 className="font-serif text-[22px] font-semibold tracking-tight text-ink">
                Assistant
              </h2>
              <p className="text-sm leading-relaxed text-muted">
                Ask the reader agent about the memories shared with you.
              </p>
            </div>
            <ReaderChat
              initialPreset="recruiting"
              ask={({ preset, messages }) => askReaderByToken({ preset, messages, token })}
            />
          </section>
        ) : null}
      </div>

      {/* Selection action bar (sticky) — session-centric view only */}
      {hasSessions && selectedCount > 0 ? (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface/95 backdrop-blur-sm">
          <div className="mx-auto flex max-w-5xl items-center gap-3 px-6 py-3">
            <Badge variant="neutral">{selectedCount} selected</Badge>
            <button
              type="button"
              onClick={clearSelection}
              className="inline-flex items-center gap-1 text-xs font-medium text-muted underline-offset-2 transition-colors hover:text-ink hover:underline"
            >
              <X size={13} weight="bold" aria-hidden="true" />
              Clear
            </button>
            <div className="ml-auto">
              <Button variant="primary" size="sm" onClick={() => setAssistantOpen(true)}>
                <ChatCircle size={15} weight="bold" aria-hidden="true" />
                Ask assistant
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <AssistantDrawer
        open={assistantOpen && selectedCount > 0}
        onClose={() => setAssistantOpen(false)}
        sessions={selectedSessions}
        ask={({ preset, messages, sessionIds }) =>
          askReaderByToken({
            token,
            preset,
            messages,
            ...(sessionIds ? { sessionIds } : {}),
          })
        }
      />
    </main>
  );
}
