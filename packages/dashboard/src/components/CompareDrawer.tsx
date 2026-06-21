"use client";

/**
 * CompareDrawer — the cross-source compare assistant hosted in a right-side
 * slide-over, mirroring {@link AssistantDrawer} on the main workspace.
 *
 * Opened from the "Shared with me" inbox after selecting 2+ shares. It reasons
 * across the selected shares' memories via `askCompare` (server-mediated; the
 * delegate keys never reach the browser). No link-pasting here — the sources
 * are exactly the selected inbox items, listed by their subject.
 */

import { ReaderChat } from "./ReaderChat";
import { askCompare } from "../app/actions/shared-access";
import { Drawer } from "./ui";

export interface CompareDrawerProps {
  open: boolean;
  onClose: () => void;
  /** The selected shares to compare, with their subject for display. */
  sources: { token: string; subject: string }[];
}

export function CompareDrawer({ open, onClose, sources }: CompareDrawerProps) {
  const tokens = sources.map((s) => s.token);
  const count = sources.length;
  const description =
    count === 1
      ? "Reasoning over 1 shared source."
      : `Comparing ${count} shared sources side by side.`;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Assistant"
      description={description}
      widthClass="w-full max-w-2xl"
    >
      {count > 0 ? (
        <div className="mb-4 flex flex-col gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-muted">
            In scope
          </span>
          <ul className="flex flex-wrap gap-1.5">
            {sources.map((source) => (
              <li key={source.token}>
                <span
                  title={source.subject}
                  className="inline-block max-w-[240px] truncate rounded-md border border-border bg-canvas px-2 py-1 text-xs text-ink"
                >
                  {source.subject}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <ReaderChat
        ask={({ preset, messages }) => askCompare({ preset, messages, tokens })}
      />
    </Drawer>
  );
}

export default CompareDrawer;
