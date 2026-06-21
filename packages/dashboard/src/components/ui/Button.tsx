/**
 * Button — primary action element.
 *
 * Variants:
 *  - `primary`   solid ink (#111) background, white text, hover shifts to #333.
 *  - `secondary` white background with a 1px structural border.
 *  - `ghost`     transparent, hover fills with the warm canvas tone.
 *
 * Radius is ~6px, there is no heavy shadow, and pressing scales to 0.98.
 */

import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-ink text-white hover:bg-[#333333]",
  secondary: "bg-surface text-ink border border-border hover:bg-canvas",
  ghost: "bg-transparent text-ink hover:bg-canvas",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-10 px-4 text-sm",
};

export function Button({
  variant = "primary",
  size = "md",
  type = "button",
  className = "",
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-2 rounded-md font-medium transition-[background-color,transform] duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`.trim()}
      {...rest}
    >
      {children}
    </button>
  );
}

export default Button;
