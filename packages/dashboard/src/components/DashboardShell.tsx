"use client";

/**
 * DashboardShell — the authenticated app frame: a left sidebar with primary
 * navigation ("My sessions", "Shared with me", "Shared links") plus a sign-out
 * footer, and a scrollable content column for the page.
 *
 * Used by the owner-facing pages (`/`, `/shared`, `/shares`). The recipient
 * share view (`/v/<token>`) is intentionally standalone (zero-login) and does
 * NOT use this shell.
 */

import type { ReactNode } from "react";
import { useCallback } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { CalendarBlank, ShareNetwork, SignOut, Tray } from "@phosphor-icons/react";

import { logout } from "../app/actions/auth";

const NAV_ITEMS = [
  { href: "/", label: "My sessions", icon: CalendarBlank },
  { href: "/shared", label: "Shared with me", icon: Tray },
  { href: "/shares", label: "Shared links", icon: ShareNetwork },
] as const;

export interface DashboardShellProps {
  children: ReactNode;
}

export function DashboardShell({ children }: DashboardShellProps) {
  const router = useRouter();
  const pathname = usePathname();

  const handleLogout = useCallback(async (): Promise<void> => {
    await logout();
    router.replace("/login");
  }, [router]);

  return (
    <div className="flex min-h-[100dvh] bg-canvas">
      {/* Sidebar */}
      <aside className="sticky top-0 flex h-[100dvh] w-56 flex-shrink-0 flex-col border-r border-border bg-surface">
        <div className="px-5 py-4">
          <Link
            href="/"
            className="font-serif text-lg font-semibold tracking-tight text-ink transition-opacity hover:opacity-80"
          >
            Uberwal
          </Link>
        </div>

        <nav aria-label="Primary" className="flex flex-1 flex-col gap-0.5 px-3 py-2">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
            const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={[
                  "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors duration-150 focus:outline-none focus:ring-1 focus:ring-ink/20",
                  active
                    ? "bg-canvas text-ink"
                    : "text-muted hover:bg-canvas hover:text-ink",
                ].join(" ")}
              >
                <Icon size={16} weight={active ? "bold" : "regular"} aria-hidden="true" />
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-border px-3 py-3">
          <button
            type="button"
            onClick={() => void handleLogout()}
            className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-muted transition-colors duration-150 hover:bg-canvas hover:text-ink focus:outline-none focus:ring-1 focus:ring-ink/20"
          >
            <SignOut size={15} weight="regular" aria-hidden="true" />
            Sign out
          </button>
        </div>
      </aside>

      {/* Content column */}
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

export default DashboardShell;
