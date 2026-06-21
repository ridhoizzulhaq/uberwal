"use client";

/**
 * Owner workspace — a SESSION-CENTRIC list (Wave M3).
 *
 * The workspace is now organized around captured *sessions* rather than a
 * cross-namespace search. On mount it calls the `listSessions` server action
 * and renders each session as a selectable {@link Card}:
 *
 *   - A checkbox enables multi-select (legacy sessions captured before
 *     per-session linkage — `sessionId === null` — render WITHOUT a checkbox
 *     since they can't be shared individually).
 *   - The card body (everything but the checkbox) navigates to the session
 *     detail route `/s/<sessionId>`.
 *   - A {@link SearchBox} filters the loaded list client-side (case-insensitive
 *     substring over the summary text). No backend round-trip.
 *
 * Sharing is SELECTION-DRIVEN: there is no global "Share" button in the header.
 * Instead, selecting ≥1 session reveals a sticky action bar with a "Share
 * selected" button that opens the {@link SharePanel}, pre-seeded with the
 * selected session ids.
 *
 * When `listSessions` reports "Not authenticated" the page redirects to
 * `/login`.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CalendarBlank,
  ChatCircle,
  ShareNetwork,
  Warning,
  X,
} from "@phosphor-icons/react";

import { listSessions, type SessionSummary } from "./actions/recall";
import { SearchBox } from "../components/SearchBox";
import { AssistantDrawer } from "../components/AssistantDrawer";
import { SharePanel } from "../components/SharePanel";
import { ProjectSummary } from "../components/ProjectSummary";
import { DashboardShell } from "../components/DashboardShell";
import { Badge, Button, Card, IconBadge } from "../components/ui";

/** Number of skeleton rows shown while the session list loads. */
const SKELETON_ROWS = 4;

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

/** Shorten a sessionId for compact mono display. */
function shortSessionId(sessionId: string): string {
  if (sessionId.length <= 14) return sessionId;
  return `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}`;
}

function SessionSkeleton() {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border bg-surface p-5 animate-skeleton-pulse">
      <div className="mt-0.5 h-4 w-4 rounded bg-canvas" />
      <div className="flex flex-1 flex-col gap-2.5">
        <div className="h-3.5 w-2/3 rounded bg-canvas" />
        <div className="h-3 w-full rounded bg-canvas" />
        <div className="h-2.5 w-24 rounded bg-canvas" />
      </div>
    </div>
  );
}

export default function WorkspacePage() {
  const router = useRouter();

  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState<string>("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [repoFilter, setRepoFilter] = useState<string | null>(null);

  const [assistantOpen, setAssistantOpen] = useState<boolean>(false);
  const [shareOpen, setShareOpen] = useState<boolean>(false);
  // Legacy sessions (no sessionId) can't navigate to a detail route, but the
  // owner can still expand them inline to read the full summary text.
  const [expandedLegacy, setExpandedLegacy] = useState<Set<string>>(new Set());

  // Load the session list on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const outcome = await listSessions();
      if (cancelled) return;
      setLoading(false);
      if (!outcome.ok) {
        if (outcome.message === "Not authenticated") {
          router.replace("/login");
          return;
        }
        setError(outcome.message);
        return;
      }
      setError(null);
      setSessions(outcome.sessions);
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  // Client-side case-insensitive substring filter over the summary text,
  // additionally narrowed to the active repo chip when one is selected.
  const filtered = useMemo<SessionSummary[]>(() => {
    const needle = query.trim().toLowerCase();
    return sessions.filter((s) => {
      if (repoFilter !== null && s.repo !== repoFilter) return false;
      if (needle.length > 0 && !s.text.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [sessions, query, repoFilter]);

  // Distinct project labels across the loaded sessions, sorted for stable
  // chip order. Drives the repo filter row (hidden when no session has a repo).
  const repos = useMemo<string[]>(() => {
    const set = new Set<string>();
    for (const s of sessions) {
      if (s.repo !== null && s.repo.length > 0) set.add(s.repo);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [sessions]);

  const toggleSelected = useCallback((sessionId: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);

  const clearSelection = useCallback((): void => {
    setSelected(new Set());
  }, []);

  // Select every currently-visible, non-legacy session — makes "select a whole
  // repo" one click once a repo chip narrows the list.
  const selectAllInView = useCallback((): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const s of filtered) {
        if (s.sessionId !== null) next.add(s.sessionId);
      }
      return next;
    });
  }, [filtered]);

  const toggleLegacyExpanded = useCallback((blobId: string): void => {
    setExpandedLegacy((prev) => {
      const next = new Set(prev);
      if (next.has(blobId)) next.delete(blobId);
      else next.add(blobId);
      return next;
    });
  }, []);

  const openSession = useCallback(
    (sessionId: string): void => {
      router.push(`/s/${encodeURIComponent(sessionId)}`);
    },
    [router],
  );

  const selectedIds = useMemo<string[]>(() => Array.from(selected), [selected]);
  const selectedCount = selectedIds.length;

  // When every selected session shares one repo, surface it so the assistant
  // and share panel can scope to that single project; otherwise `null`.
  const selectedRepo = useMemo<string | null>(() => {
    const set = new Set<string | null>();
    for (const s of sessions) {
      if (s.sessionId !== null && selected.has(s.sessionId)) {
        set.add(s.repo);
      }
    }
    if (set.size !== 1) return null;
    const only = set.values().next().value;
    return typeof only === "string" && only.length > 0 ? only : null;
  }, [sessions, selected]);

  // Selected sessions paired with display titles, so the assistant drawer can
  // label exactly which sessions are in scope (not just a count).
  const selectedSessions = useMemo<{ id: string; title: string }[]>(
    () =>
      sessions
        .filter(
          (s): s is SessionSummary & { sessionId: string } =>
            s.sessionId !== null && selected.has(s.sessionId),
        )
        .map((s) => ({ id: s.sessionId, title: sessionTitle(s.text) })),
    [sessions, selected],
  );

  return (
    <DashboardShell>
      {shareOpen ? (
        <SharePanel
          sessionIds={selectedIds}
          onClose={() => setShareOpen(false)}
          {...(selectedRepo !== null ? { repo: selectedRepo } : {})}
        />
      ) : null}

      {/* Content */}
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10 pb-28 animate-slide-up">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-[28px] font-semibold tracking-tight text-ink">
            Sessions
          </h1>
          <p className="text-sm leading-relaxed text-muted">
            Every session captured into your memory. Open one to read its detail, or
            select sessions to share them or ask the assistant about them.
          </p>
        </div>

        {/* Search */}
        <SearchBox
          onSubmit={setQuery}
          placeholder="Filter sessions..."
          ariaLabel="Filter sessions"
        />

        {/* Repo filter row — only shown once at least one session has a repo. */}
        {repos.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-muted">
              Project
            </span>
            <button
              type="button"
              onClick={() => setRepoFilter(null)}
              aria-pressed={repoFilter === null}
              className={[
                "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors duration-150 focus:outline-none focus:ring-1 focus:ring-ink/20",
                repoFilter === null
                  ? "border-ink bg-canvas text-ink"
                  : "border-border text-muted hover:border-ink/40 hover:text-ink",
              ].join(" ")}
            >
              All
            </button>
            {repos.map((repo) => (
              <button
                key={repo}
                type="button"
                onClick={() => setRepoFilter((prev) => (prev === repo ? null : repo))}
                aria-pressed={repoFilter === repo}
                className={[
                  "rounded-md border px-2.5 py-1 font-mono text-xs font-medium transition-colors duration-150 focus:outline-none focus:ring-1 focus:ring-ink/20",
                  repoFilter === repo
                    ? "border-ink bg-canvas text-ink"
                    : "border-border text-muted hover:border-ink/40 hover:text-ink",
                ].join(" ")}
              >
                {repo}
              </button>
            ))}
            {filtered.some((s) => s.sessionId !== null) ? (
              <button
                type="button"
                onClick={selectAllInView}
                className="ml-auto text-xs font-medium text-muted underline-offset-2 transition-colors hover:text-ink hover:underline"
              >
                Select all in view
              </button>
            ) : null}
          </div>
        ) : null}

        {/* On-demand project synthesis ("wiki-for-now") when a repo is active.
            Keyed on repoFilter so switching projects resets its state. */}
        {repoFilter !== null ? (
          <ProjectSummary key={repoFilter} repo={repoFilter} />
        ) : null}

        {/* Whole-request error (e.g. configuration failure) */}
        {error !== null ? (
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
                Your sessions could not be loaded.
              </span>{" "}
              <span className="text-pastel-redText">{error}</span>
            </div>
          </div>
        ) : null}

        {/* Loading skeletons */}
        {loading ? (
          <ul aria-label="Loading sessions" aria-busy="true" className="flex flex-col gap-3">
            {Array.from({ length: SKELETON_ROWS }).map((_, i) => (
              <li key={i}>
                <SessionSkeleton />
              </li>
            ))}
          </ul>
        ) : null}

        {/* Empty state */}
        {!loading && error === null && sessions.length === 0 ? (
          <div
            role="status"
            className="flex flex-col items-start gap-3 rounded-lg border border-border bg-surface px-6 py-10"
          >
            <IconBadge tone="neutral" className="h-9 w-9">
              <CalendarBlank size={18} weight="regular" aria-hidden="true" />
            </IconBadge>
            <p className="text-sm font-medium text-ink">
              No sessions yet — capture one with the Uberwal MCP
            </p>
          </div>
        ) : null}

        {/* No matches for the current filter */}
        {!loading && error === null && sessions.length > 0 && filtered.length === 0 ? (
          <div
            role="status"
            className="flex flex-col items-start gap-3 rounded-lg border border-border bg-surface px-6 py-10"
          >
            <IconBadge tone="neutral" className="h-9 w-9">
              <CalendarBlank size={18} weight="regular" aria-hidden="true" />
            </IconBadge>
            <p className="text-sm font-medium text-ink">No sessions match your filter</p>
          </div>
        ) : null}

        {/* Session list */}
        {!loading && filtered.length > 0 ? (
          <ul aria-label="Sessions" className="flex flex-col gap-3">
            {filtered.map((session) => {
              const isLegacy = session.sessionId === null;
              const sid = session.sessionId;
              const checked = sid !== null && selected.has(sid);
              const title = sessionTitle(session.text);
              const preview = sessionPreview(session.text);

              return (
                <li key={`${session.blob_id}`}>
                  <Card className="flex flex-col gap-3 p-5">
                    <div className="flex items-start gap-3">
                      {/* Checkbox (multi-select) — omitted for legacy sessions. */}
                      {isLegacy ? (
                        <span className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
                      ) : (
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleSelected(sid as string)}
                          aria-label={`Select session ${title}`}
                          className="mt-1 h-4 w-4 flex-shrink-0 cursor-pointer accent-ink"
                        />
                      )}

                      {/* Card body — non-legacy navigates to /s/<id>; legacy
                          toggles an inline expansion of its full summary. */}
                      <button
                        type="button"
                        onClick={() => {
                          if (isLegacy) toggleLegacyExpanded(session.blob_id);
                          else openSession(sid as string);
                        }}
                        aria-expanded={isLegacy ? expandedLegacy.has(session.blob_id) : undefined}
                        className="flex min-w-0 flex-1 flex-col gap-1.5 text-left focus:outline-none"
                      >
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
                            legacy — click to read summary (can&apos;t be shared individually)
                          </span>
                        ) : (
                          <span className="flex flex-wrap items-center gap-2">
                            {session.repo !== null && session.repo.length > 0 ? (
                              <Badge variant="neutral">{session.repo}</Badge>
                            ) : null}
                            <span className="font-mono text-[11px] text-muted">
                              {shortSessionId(sid as string)}
                            </span>
                          </span>
                        )}
                      </button>
                    </div>

                    {/* Legacy inline expansion: the full summary text. */}
                    {isLegacy && expandedLegacy.has(session.blob_id) ? (
                      <div className="border-t border-border pt-3">
                        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink">
                          {session.text}
                        </p>
                      </div>
                    ) : null}
                  </Card>
                </li>
              );
            })}
          </ul>
        ) : null}
      </main>

      {/* Selection action bar (sticky) */}
      {selectedCount > 0 ? (
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
            <div className="ml-auto flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => setAssistantOpen(true)}>
                <ChatCircle size={15} weight="bold" aria-hidden="true" />
                Ask assistant
              </Button>
              <Button variant="primary" size="sm" onClick={() => setShareOpen(true)}>
                <ShareNetwork size={15} weight="bold" aria-hidden="true" />
                Share selected
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <AssistantDrawer
        open={assistantOpen && selectedCount > 0}
        onClose={() => setAssistantOpen(false)}
        sessions={selectedSessions}
        {...(selectedRepo !== null ? { repo: selectedRepo } : {})}
      />
    </DashboardShell>
  );
}
