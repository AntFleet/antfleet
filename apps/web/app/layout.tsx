import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Self-hosted via next/font so there's no FOIT/FOUT and no third-party
// request at runtime. Inter for everything sans, JetBrains Mono for SHAs +
// inline code (the only monospace use per AGENTS.md §15).
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jbMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jb-mono",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://www.antfleet.dev"),
  title: "AntFleet — trust substrate for autonomous code",
  description:
    "AI code review with receipts. Agreement between independent frontier models is the trust gate; every closure is SHA-pinned to GitHub's event log.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jbMono.variable}`}>
      <body className="min-h-dvh flex flex-col">
        <SiteHeader />
        <main className="flex-1">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}

function SiteHeader() {
  return (
    <header className="border-b border-[var(--color-line)]">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <a href="/" className="font-semibold tracking-tight text-[var(--color-ink)]">
          AntFleet
        </a>
        <nav className="flex items-center gap-7 text-sm text-[var(--color-ink-muted)]">
          <a href="/architecture" className="hover:text-[var(--color-ink)] transition-colors">
            Architecture
          </a>
          <a href="/activity" className="hover:text-[var(--color-ink)] transition-colors">
            Activity
          </a>
          <a href="/receipts" className="hover:text-[var(--color-ink)] transition-colors">
            Receipts
          </a>
          <a href="/roadmap" className="hover:text-[var(--color-ink)] transition-colors">
            Roadmap
          </a>
          <a href="/policy" className="hover:text-[var(--color-ink)] transition-colors">
            Policy
          </a>
        </nav>
      </div>
    </header>
  );
}

function SiteFooter() {
  return (
    <footer className="border-t border-[var(--color-line)]">
      <div className="mx-auto flex max-w-5xl flex-col gap-3 px-6 py-8 text-sm text-[var(--color-ink-subtle)] sm:flex-row sm:items-center sm:justify-between">
        <span>AntFleet — trust substrate for autonomous code work.</span>
        <nav className="flex items-center gap-5 font-mono text-xs">
          <a
            href="/receipts"
            className="hover:text-[var(--color-ink)] transition-colors"
          >
            receipts
          </a>
          <a
            href="/changelog"
            className="hover:text-[var(--color-ink)] transition-colors"
          >
            changelog
          </a>
          <a
            href="/roadmap"
            className="hover:text-[var(--color-ink)] transition-colors"
          >
            roadmap
          </a>
          <a
            href="/policy"
            className="hover:text-[var(--color-ink)] transition-colors"
          >
            policy
          </a>
          <a
            href="https://github.com/AntFleet/antfleet"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-[var(--color-ink)] transition-colors"
          >
            github
          </a>
          <a
            href="https://x.com/AntFleetDev"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-[var(--color-ink)] transition-colors"
          >
            x
          </a>
        </nav>
      </div>
    </footer>
  );
}
