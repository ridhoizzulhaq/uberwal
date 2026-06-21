"use client";

/**
 * AssistantDrawer — the Reader chat hosted in a right-side slide-over.
 *
 * Wraps the existing {@link ReaderChat} (authenticated `askReader` by default)
 * in the shared {@link Drawer} so the owner can open the assistant from the
 * workspace top bar without leaving the page.
 */

import { ReaderChat, type AskReader } from "./ReaderChat";
import { Drawer } from "./ui";

export interface AssistantDrawerProps {
  open: boolean;
  onClose: () => void;
  /** The selected sessions the assistant is scoped to, with display titles. */
  sessions: { id: string; title: string }[];
  /**
   * Optional project/repository the selection belongs to. When all selected
   * sessions share one repo, it is shown in the scope header and forwarded to
   * the reasoning turn as an extra filter.
   */
  repo?: string;
  /**
   * Optional reasoning function. Defaults (in ReaderChat) to the authenticated
   * `askReader`. The share-recipient view passes a closure over
   * `askReaderByToken` so the scoped read goes through the share token.
   */
  ask?: AskReader;
}

export function AssistantDrawer({ open, onClose, sessions, repo, ask }: AssistantDrawerProps) {
  const count = sessions.length;
  const description =
    count === 1
      ? "Reasoning over the 1 selected session."
      : `Reasoning over the ${count} selected sessions.`;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Assistant"
      description={description}
      widthClass="w-full max-w-lg"
    >
      {/* In-scope session labels — exactly which sessions the assistant reads. */}
      {count > 0 ? (
        <div className="mb-4 flex flex-col gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-muted">
            In scope
          </span>
          {repo !== undefined && repo.length > 0 ? (
            <span className="inline-flex w-fit items-center gap-1 rounded-md border border-border bg-canvas px-2 py-1 font-mono text-[11px] text-ink">
              repo: {repo}
            </span>
          ) : null}
          <ul className="flex flex-wrap gap-1.5">
            {sessions.map((session) => (
              <li key={session.id}>
                <span
                  title={session.title}
                  className="inline-block max-w-[240px] truncate rounded-md border border-border bg-canvas px-2 py-1 text-xs text-ink"
                >
                  {session.title}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <ReaderChat
        sessionIds={sessions.map((session) => session.id)}
        showPersona={false}
        {...(repo !== undefined && repo.length > 0 ? { repo } : {})}
        {...(ask !== undefined ? { ask } : {})}
      />
    </Drawer>
  );
}

export default AssistantDrawer;
