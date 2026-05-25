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
  title: "AntFleet — the trust layer for code written by agents",
  description:
    "The trust layer for code written by agents. Two independent frontier models review every PR; only unanimous findings post, and every closure is SHA-pinned to GitHub's event log.",
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
          <a href="/receipts" className="hover:text-[var(--color-ink)] transition-colors">
            Receipts
          </a>
          <a href="/disagreements" className="hover:text-[var(--color-ink)] transition-colors">
            Disagreements
          </a>
          <a href="/agents" className="hover:text-[var(--color-ink)] transition-colors">
            Agents
          </a>
          <a href="/benchmarks" className="hover:text-[var(--color-ink)] transition-colors">
            Benchmarks
          </a>
          <a href="/roasts" className="hover:text-[var(--color-ink)] transition-colors">
            Roasts
          </a>
          <a href="/impact" className="hover:text-[var(--color-ink)] transition-colors">
            Impact
          </a>
          <div className="relative group">
            <span className="cursor-default hover:text-[var(--color-ink)] transition-colors">
              About
            </span>
            <div className="invisible absolute right-0 top-full z-50 pt-2 group-hover:visible">
              <div className="flex flex-col gap-1 rounded-md border border-[var(--color-line)] bg-[var(--color-bg)] px-1 py-1 shadow-md min-w-[160px]">
                <AboutLink href="/about" label="Architecture" />
                <AboutLink href="/about/api" label="API" />
                <AboutLink href="/about/methodology" label="Methodology" />
                <AboutLink href="/about/changelog" label="Changelog" />
                <AboutLink href="/about/roadmap" label="Roadmap" />
                <AboutLink href="/about/policy" label="Policy" />
              </div>
            </div>
          </div>
        </nav>
      </div>
    </header>
  );
}

function AboutLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      className="block rounded px-3 py-1.5 text-sm text-[var(--color-ink-muted)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-ink)] transition-colors"
    >
      {label}
    </a>
  );
}

function SiteFooter() {
  return (
    <footer className="border-t border-[var(--color-line)]">
      <div className="mx-auto flex max-w-5xl flex-col gap-3 px-6 py-8 text-sm text-[var(--color-ink-subtle)] sm:flex-row sm:items-center sm:justify-between">
        <span>AntFleet — the trust layer for code written by agents.</span>
        <nav className="flex flex-wrap items-center gap-5 font-mono text-xs">
          <a href="/receipts" className="hover:text-[var(--color-ink)] transition-colors">
            receipts
          </a>
          <a href="/disagreements" className="hover:text-[var(--color-ink)] transition-colors">
            disagreements
          </a>
          <a href="/agents" className="hover:text-[var(--color-ink)] transition-colors">
            agents
          </a>
          <a href="/benchmarks" className="hover:text-[var(--color-ink)] transition-colors">
            benchmarks
          </a>
          <a href="/roasts" className="hover:text-[var(--color-ink)] transition-colors">
            roasts
          </a>
          <a href="/impact" className="hover:text-[var(--color-ink)] transition-colors">
            impact
          </a>
          <span className="text-[var(--color-line)]">&middot;</span>
          <a href="/digest" className="hover:text-[var(--color-ink)] transition-colors">
            digest
          </a>
          <a href="/retro" className="hover:text-[var(--color-ink)] transition-colors">
            retro
          </a>
          <a href="/activity" className="hover:text-[var(--color-ink)] transition-colors">
            activity
          </a>
          <a href="/about/changelog" className="hover:text-[var(--color-ink)] transition-colors">
            changelog
          </a>
          <a href="/about/roadmap" className="hover:text-[var(--color-ink)] transition-colors">
            roadmap
          </a>
          <a href="/about/policy" className="hover:text-[var(--color-ink)] transition-colors">
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
