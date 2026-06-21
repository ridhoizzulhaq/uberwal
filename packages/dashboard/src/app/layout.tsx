/**
 * Root layout for the Uberwal dashboard.
 *
 * Provides the html/body shell, font variables (Geist Sans for UI, Geist Mono
 * for meta/code, Newsreader serif for editorial headings), and global CSS.
 * All route chrome lives in the dashboard route-group layout so the login
 * page renders without sidebar chrome.
 */

import type { ReactNode } from "react";
import { Geist, Geist_Mono, Newsreader } from "next/font/google";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

const newsreader = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
});

export const metadata = {
  title: "Uberwal",
  description:
    "Browse skills, productivity, sessions, and reports stored in Walrus Memory.",
};

export interface RootLayoutProps {
  children: ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${newsreader.variable}`}
    >
      <body className="min-h-[100dvh] bg-canvas text-ink antialiased font-sans">
        {children}
      </body>
    </html>
  );
}
