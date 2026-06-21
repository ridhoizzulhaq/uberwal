/**
 * Card — editorial content surface.
 *
 * A white `article` wrapper with a 1px structural border, generous rounding,
 * and an ultra-subtle hover shadow (near-invisible, opacity < 0.05). Padding
 * is intentionally left to the caller so cards can host dense or airy content.
 */

import type { HTMLAttributes, ReactNode } from "react";

export interface CardProps extends HTMLAttributes<HTMLElement> {
  className?: string;
  children: ReactNode;
}

export function Card({ className = "", children, ...rest }: CardProps) {
  return (
    <article
      className={`rounded-xl border border-border bg-surface transition-shadow duration-200 hover:shadow-[0_2px_8px_rgba(0,0,0,0.04)] ${className}`.trim()}
      {...rest}
    >
      {children}
    </article>
  );
}

export default Card;
