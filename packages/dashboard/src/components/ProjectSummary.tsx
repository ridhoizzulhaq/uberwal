"use client";

/**
 * ProjectSummary — on-demand, repo-scoped synthesis ("wiki-for-now").
 *
 * Instead of a persisted wiki artifact, this runs the existing repo-scoped
 * reader (`askReader` with a `repo` filter) under a fixed summary prompt and
 * renders the result as markdown. It reads ONLY the selected project's memories
 * (runReader scopes by `repo`) and is always fresh because it recalls at click
 * time. No new MCP tool, no stored blob — the synthesis lives only in this view.
 *
 * Promote to a persisted `compile_wiki` / `get_wiki` only when a stable,
 * citable, shareable artifact is actually needed.
 */

import { useState } from "react";
import {
  ArrowClockwise,
  CircleNotch,
  Sparkle,
  Warning,
} from "@phosphor-icons/react";

import { askReader } from "../app/actions/reader";
import { Markdown } from "./Markdown";
import { Button, Card } from "./ui";

/** Fixed prompt used for the on-demand project synthesis. */
const SUMMARY_PROMPT =
  "Summarize this project from the recalled memories: what was built, the key " +
  "skills and technologies demonstrated, and notable outcomes or decisions. Be " +
  "concise and structured (a few short sections or bullet points). Ground every " +
  "claim strictly in the provided context; do not invent anything not present.";

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; reply: string; usedCount: number }
  | { kind: "error"; message: string };

export interface ProjectSummaryProps {
  /** The active project/repository label to scope the synthesis to. */
  repo: string;
}

export function ProjectSummary({ repo }: ProjectSummaryProps) {
  const [state, setState] = useState<State>({ kind: "idle" });

  const run = async (): Promise<void> => {
    setState({ kind: "loading" });
    // `repo` triggers runReader's scoped mode (neutral prompt, repo-filtered),
    // so the preset is effectively unused — pass a valid default.
    const result = await askReader({
      preset: "recruiting",
      repo,
      messages: [{ role: "user", content: SUMMARY_PROMPT }],
    });
    if (result.ok) {
      setState({
        kind: "ready",
        reply: result.reply,
        usedCount: result.usedMemories.length,
      });
    } else {
      setState({ kind: "error", message: result.message });
    }
  };

  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Sparkle size={16} weight="bold" className="flex-shrink-0 text-ink" aria-hidden="true" />
          <span className="font-serif text-[15px] font-semibold tracking-tight text-ink">
            Project summary
          </span>
          <span className="truncate font-mono text-[11px] text-muted">{repo}</span>
        </div>
        {state.kind === "ready" || state.kind === "error" ? (
          <button
            type="button"
            onClick={() => void run()}
            className="inline-flex flex-shrink-0 items-center gap-1 text-xs font-medium text-muted underline-offset-2 transition-colors hover:text-ink hover:underline"
          >
            <ArrowClockwise size={13} weight="bold" aria-hidden="true" />
            Refresh
          </button>
        ) : null}
      </div>

      {state.kind === "idle" ? (
        <div className="flex flex-col items-start gap-2.5">
          <p className="text-sm leading-relaxed text-muted">
            Generate an on-demand synthesis across this project&apos;s sessions. It
            reads only <span className="font-mono text-ink">{repo}</span> and is
            grounded strictly in your captured memories.
          </p>
          <Button variant="secondary" size="sm" onClick={() => void run()}>
            <Sparkle size={14} weight="bold" aria-hidden="true" />
            Summarize this project
          </Button>
        </div>
      ) : null}

      {state.kind === "loading" ? (
        <div className="flex items-center gap-2 text-muted">
          <CircleNotch size={15} weight="bold" className="animate-spin" aria-hidden="true" />
          <span className="text-sm">Synthesizing {repo}…</span>
        </div>
      ) : null}

      {state.kind === "error" ? (
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
          <div className="text-sm">
            <span className="font-medium text-pastel-redText">Could not summarize.</span>{" "}
            <span className="text-pastel-redText">{state.message}</span>
          </div>
        </div>
      ) : null}

      {state.kind === "ready" ? (
        <div className="flex flex-col gap-2">
          <div className="text-sm leading-relaxed text-ink">
            <Markdown>{state.reply}</Markdown>
          </div>
          <p className="text-[10px] text-muted">
            based on {state.usedCount} {state.usedCount === 1 ? "memory" : "memories"}
          </p>
        </div>
      ) : null}
    </Card>
  );
}

export default ProjectSummary;
