/**
 * Badge — small pill label for tags and statuses.
 *
 * Pill-shaped (rounded-full is OK for small badges only), text-xs, uppercase,
 * with wide tracking and a muted pastel background paired with matching text.
 * The `neutral` variant uses the warm canvas tone with muted text.
 */

import type { HTMLAttributes, ReactNode } from "react";

export type BadgeVariant = "red" | "blue" | "green" | "yellow" | "neutral";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** Muted pastel color family (or neutral). Defaults to `neutral`. */
  variant?: BadgeVariant;
  children: ReactNode;
}

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  red: "bg-pastel-red text-pastel-redText",
  blue: "bg-pastel-blue text-pastel-blueText",
  green: "bg-pastel-green text-pastel-greenText",
  yellow: "bg-pastel-yellow text-pastel-yellowText",
  neutral: "bg-canvas text-muted",
};

export function Badge({
  variant = "neutral",
  className = "",
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide ${VARIANT_CLASSES[variant]} ${className}`.trim()}
      {...rest}
    >
      {children}
    </span>
  );
}

export default Badge;
