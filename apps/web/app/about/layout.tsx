import type { ReactNode } from "react";

const ABOUT_LINKS = [
  { href: "/about", label: "Architecture" },
  { href: "/api", label: "API" },
  { href: "/about/methodology", label: "Methodology" },
  { href: "/about/changelog", label: "Changelog" },
  { href: "/about/roadmap", label: "Roadmap" },
  { href: "/about/policy", label: "Policy" },
] as const;

export default function AboutLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="border-b border-[var(--color-line)]">
        <nav className="mx-auto flex max-w-5xl items-center gap-6 overflow-x-auto px-6 py-3 font-mono text-xs text-[var(--color-ink-subtle)]">
          {ABOUT_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="shrink-0 hover:text-[var(--color-ink)] transition-colors"
            >
              {link.label}
            </a>
          ))}
        </nav>
      </div>
      {children}
    </>
  );
}
