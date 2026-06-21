"use client";

/**
 * Drawer — right-side slide-over panel.
 *
 * A reusable overlay + right panel used for the workspace's Assistant chat and
 * the Shared-links manager. It renders a dimmed backdrop and a surface panel
 * that slides in from the right. Pressing Escape or clicking the backdrop
 * closes it; while open, body scroll is locked. The panel is labelled for
 * assistive tech via `aria-modal` + a generated title id.
 *
 * Styling consumes the minimalist theme tokens only (no gradients, no heavy
 * shadows beyond the subtle structural one the design already uses).
 */

import { useEffect, useId, type ReactNode } from "react";
import { X } from "@phosphor-icons/react";

export interface DrawerProps {
  /** Whether the drawer is open. When false, nothing is rendered. */
  open: boolean;
  /** Called when the user requests dismissal (Escape, backdrop, close button). */
  onClose: () => void;
  /** Serif title shown in the panel header. */
  title: string;
  /** Optional one-line description under the title. */
  description?: string;
  /** Optional Tailwind width utility for the panel. Defaults to a wide column. */
  widthClass?: string;
  children: ReactNode;
}

export function Drawer({
  open,
  onClose,
  title,
  description,
  widthClass = "w-full max-w-md",
  children,
}: DrawerProps) {
  const titleId = useId();

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  // Lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-ink/30"
        aria-hidden="true"
        onClick={onClose}
      />

      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`relative flex h-full flex-col border-l border-border bg-surface ${widthClass} animate-slide-up`}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2
              id={titleId}
              className="font-serif text-lg font-semibold tracking-tight text-ink"
            >
              {title}
            </h2>
            {description !== undefined ? (
              <p className="mt-0.5 text-xs leading-relaxed text-muted">{description}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-canvas hover:text-ink focus:outline-none focus:ring-1 focus:ring-ink/20"
          >
            <X size={16} weight="bold" aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
      </div>
    </div>
  );
}

export default Drawer;
