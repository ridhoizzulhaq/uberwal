"use client";

/**
 * TokenNamespaceView — read-only recall surface for a single namespace inside
 * the server-mediated ("token") share experience.
 *
 * This is the token-based replacement for the retired SharedNamespaceView. The
 * recipient never holds a key: every recall goes through `recallByToken`, which
 * resolves the opaque token to a stored share server-side, enforces the
 * manifest, and returns only allowed content.
 *
 * It reuses the existing per-namespace card components and mirrors the
 * authenticated pages' loading / empty / error patterns. There is no distance
 * slider — `recallByToken` defaults `maxDistance` to 1.0 so the recipient sees
 * everything shared with them.
 */

import { useCallback, useEffect, useState } from "react";
import type { Namespace, RecallEntry } from "@uberwal/shared";
import {
  CalendarBlank,
  ChartLineUp,
  ChatsCircle,
  FileText,
  GraduationCap,
  Warning,
} from "@phosphor-icons/react";
import { recallByToken } from "../app/actions/shared-access";
import { SearchBox } from "./SearchBox";
import { SkillCard } from "./SkillCard";
import { ProductivityCard } from "./ProductivityCard";
import { SessionBlock } from "./SessionBlock";
import { ReportBlock } from "./ReportBlock";
import { TranscriptCard } from "./TranscriptCard";
import { IconBadge } from "./ui";

const RECALL_LIMIT = 20;

/** "grid" namespaces use a responsive grid; "list" namespaces stack vertically. */
type Layout = "grid" | "list";

interface NamespaceConfig {
  defaultQuery: string;
  placeholder: string;
  emptyLabel: string;
  layout: Layout;
  icon: typeof GraduationCap;
}

const CONFIG: Record<Namespace, NamespaceConfig> = {
  skills: {
    defaultQuery: "skills and technologies",
    placeholder: "Search skills...",
    emptyLabel: "No skills shared yet",
    layout: "grid",
    icon: GraduationCap,
  },
  productivity: {
    defaultQuery: "productivity and output",
    placeholder: "Search productivity...",
    emptyLabel: "No productivity shared yet",
    layout: "grid",
    icon: ChartLineUp,
  },
  sessions: {
    defaultQuery: "session summary",
    placeholder: "Search sessions...",
    emptyLabel: "No sessions shared yet",
    layout: "list",
    icon: CalendarBlank,
  },
  reports: {
    defaultQuery: "report",
    placeholder: "Search reports...",
    emptyLabel: "No reports shared yet",
    layout: "list",
    icon: FileText,
  },
  transcripts: {
    defaultQuery: "transcript",
    placeholder: "Search transcripts...",
    emptyLabel: "No transcripts shared yet",
    layout: "list",
    icon: ChatsCircle,
  },
};

function renderCard(namespace: Namespace, entry: RecallEntry) {
  switch (namespace) {
    case "skills":
      return <SkillCard entry={entry} />;
    case "productivity":
      return <ProductivityCard entry={entry} />;
    case "sessions":
      return <SessionBlock entry={entry} />;
    case "reports":
      return <ReportBlock entry={entry} />;
    case "transcripts":
      // Transcripts are raw chunked text — render them in full (no truncation).
      return <TranscriptCard entry={entry} />;
  }
}

function GridSkeleton() {
  return (
    <div className="flex h-full flex-col justify-between rounded-lg border border-border bg-surface p-5 animate-skeleton-pulse">
      <div className="flex flex-col gap-2.5">
        <div className="h-3 w-full rounded bg-canvas" />
        <div className="h-3 w-4/5 rounded bg-canvas" />
        <div className="h-3 w-2/3 rounded bg-canvas" />
      </div>
      <div className="mt-6 h-2.5 w-16 rounded bg-canvas" />
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 animate-skeleton-pulse">
      <div className="flex flex-col gap-2">
        <div className="h-3 w-full rounded bg-canvas" />
        <div className="h-3 w-11/12 rounded bg-canvas" />
        <div className="h-3 w-4/5 rounded bg-canvas" />
        <div className="h-3 w-3/5 rounded bg-canvas" />
      </div>
      <div className="h-px bg-border" />
      <div className="h-2.5 w-20 rounded bg-canvas" />
    </div>
  );
}

export interface TokenNamespaceViewProps {
  token: string;
  namespace: Namespace;
}

export function TokenNamespaceView({ token, namespace }: TokenNamespaceViewProps) {
  const config = CONFIG[namespace];

  const [results, setResults] = useState<RecallEntry[]>([]);
  const [hasFetched, setHasFetched] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const runRecall = useCallback(
    async (query: string): Promise<void> => {
      setLoading(true);
      // No maxDistance — the server defaults it to 1.0 (no upper-distance filter).
      const outcome = await recallByToken({
        token,
        namespace,
        query,
        limit: RECALL_LIMIT,
      });
      setLoading(false);
      setHasFetched(true);
      if (outcome.ok) {
        setResults(outcome.results);
        setError(null);
      } else {
        setError(outcome.message);
      }
    },
    [token, namespace],
  );

  useEffect(() => {
    void runRecall(config.defaultQuery);
  }, [runRecall, config.defaultQuery]);

  const handleSearchSubmit = useCallback(
    (query: string): void => {
      void runRecall(query);
    },
    [runRecall],
  );

  const showEmptyState = hasFetched && !loading && results.length === 0 && error === null;
  const showSkeletons = loading && results.length === 0;
  const isGrid = config.layout === "grid";
  const skeletonCount = isGrid ? 6 : 4;
  const Icon = config.icon;

  const listClass = isGrid
    ? "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
    : "flex flex-col gap-3";

  return (
    <div className="flex flex-col gap-4">
      <SearchBox
        onSubmit={handleSearchSubmit}
        defaultValue={config.defaultQuery}
        placeholder={config.placeholder}
        ariaLabel={`Search ${namespace}`}
        disabled={loading}
      />

      {error !== null ? (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-pastel-red bg-pastel-red px-4 py-3"
        >
          <Warning size={16} weight="bold" className="mt-0.5 flex-shrink-0 text-pastel-redText" aria-hidden="true" />
          <div className="text-sm">
            <span className="font-medium text-pastel-redText">This view could not be loaded.</span>{" "}
            <span className="text-pastel-redText">{error}</span>
          </div>
        </div>
      ) : null}

      {showSkeletons ? (
        <ul aria-label={`Loading ${namespace}`} aria-busy="true" className={listClass}>
          {Array.from({ length: skeletonCount }).map((_, i) => (
            <li key={i}>{isGrid ? <GridSkeleton /> : <ListSkeleton />}</li>
          ))}
        </ul>
      ) : null}

      {showEmptyState ? (
        <div
          role="status"
          className="flex flex-col items-start gap-3 rounded-lg border border-border bg-surface px-6 py-10"
        >
          <IconBadge tone="neutral" className="h-9 w-9">
            <Icon size={18} weight="regular" aria-hidden="true" />
          </IconBadge>
          <p className="text-sm font-medium text-ink">{config.emptyLabel}</p>
        </div>
      ) : null}

      {results.length > 0 ? (
        <div>
          <div className="mb-3 flex items-center gap-2">
            <span className="font-mono text-xs text-muted">
              {results.length} {results.length === 1 ? "result" : "results"}
            </span>
            {loading ? (
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted animate-pulse">
                refreshing
              </span>
            ) : null}
          </div>

          <ul
            aria-label={`${namespace} results`}
            className={[
              listClass,
              loading ? "opacity-60 transition-opacity duration-200" : "opacity-100",
            ].join(" ")}
          >
            {results.map((entry, index) => (
              <li key={`${entry.blob_id}-${index}`}>{renderCard(namespace, entry)}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export default TokenNamespaceView;
