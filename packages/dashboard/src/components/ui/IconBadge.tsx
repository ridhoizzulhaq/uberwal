/**
 * IconBadge — small square chip that frames a single icon.
 *
 * A 7x7 rounded square with a muted pastel (or neutral) background that centers
 * a Phosphor icon passed as children. Use it to give list rows and headers a
 * quiet splash of editorial color without leaning on heavy iconography.
 *
 * @example
 *   import { Sparkle } from "@phosphor-icons/react";
 *   <IconBadge tone="blue"><Sparkle weight="bold" /></IconBadge>
 */

import type { HTMLAttributes, ReactNode } from "react";

export type IconBadgeTone = "red" | "blue" | "green" | "yellow" | "neutral";

export interface IconBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** Muted pastel color family (or neutral). Defaults to `neutral`. */
  tone?: IconBadgeTone;
  /** A Phosphor icon element. */
  children: ReactNode;
}

const TONE_CLASSES: Record<IconBadgeTone, string> = {
  red: "bg-pastel-red text-pastel-redText",
  blue: "bg-pastel-blue text-pastel-blueText",
  green: "bg-pastel-green text-pastel-greenText",
  yellow: "bg-pastel-yellow text-pastel-yellowText",
  neutral: "bg-canvas text-muted",
};

export function IconBadge({
  tone = "neutral",
  className = "",
  children,
  ...rest
}: IconBadgeProps) {
  return (
    <span
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md ${TONE_CLASSES[tone]} ${className}`.trim()}
      {...rest}
    >
      {children}
    </span>
  );
}

export default IconBadge;
