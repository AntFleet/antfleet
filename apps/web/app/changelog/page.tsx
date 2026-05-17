import type { Metadata } from "next";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseChangelog } from "@/lib/changelog";

// Changelog page — the agent log. Reads the canonical CHANGELOG.md at the
// repo root (bundled into the deployment via Next's includeOutsideRoot
// hook in next.config). Force-dynamic so a fresh deploy always picks up
// the latest. Honors the §15 brand discipline: terse, dated, sourced.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Changelog · AntFleet",
  description: "What the AntFleet fleet has shipped — agent-attributed shipments, latest first.",
};

async function loadChangelogMarkdown(): Promise<string> {
  // process.cwd() points at apps/web in both Vercel and local dev. The
  // prebuild step copies ../../CHANGELOG.md → ./CHANGELOG.md so the file
  // lives inside the function bundle. Repo-root fallback covers `pnpm dev`
  // runs that haven't gone through prebuild.
  const candidates = [
    path.join(process.cwd(), "CHANGELOG.md"),
    path.join(process.cwd(), "..", "..", "CHANGELOG.md"),
  ];
  for (const p of candidates) {
    try {
      return await readFile(p, "utf8");
    } catch {
      // try next candidate
    }
  }
  return "# Changelog\n\nNo entries yet.";
}

export default async function ChangelogPage() {
  const markdown = await loadChangelogMarkdown();
  const doc = parseChangelog(markdown);

  return (
    <>
      <Hero introHtml={doc.intro} />
      <SectionDivider />
      {doc.sections.map((s) => (
        <LogSection key={s.heading} section={s} />
      ))}
      {doc.appendix !== null && (
        <>
          <SectionDivider />
          <Appendix appendix={doc.appendix} />
        </>
      )}
    </>
  );
}

function ContentWrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6">{children}</div>;
}

function SectionDivider() {
  return <div className="border-t border-[var(--color-line)] my-16" />;
}

function Hero({ introHtml }: { introHtml: string }) {
  return (
    <section className="py-20 pb-12">
      <ContentWrap>
        <p className="font-mono text-xs text-[var(--color-ink-subtle)] mb-6 tracking-widest uppercase">
          Changelog · agent log
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-[var(--color-ink)] leading-snug max-w-xl">
          What the fleet has shipped.
        </h1>
        <div
          className="mt-5 prose-text max-w-xl text-base leading-relaxed text-[var(--color-ink-muted)]"
          dangerouslySetInnerHTML={{ __html: introHtml }}
        />
      </ContentWrap>
    </section>
  );
}

function LogSection({ section }: { section: { heading: string; entries: ReturnType<typeof parseChangelog>["sections"][number]["entries"] } }) {
  return (
    <section className="pb-12">
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-5">
          {section.heading}
        </h2>
        <ul className="flex flex-col gap-4 max-w-xl text-sm text-[var(--color-ink-muted)] leading-relaxed">
          {section.entries.map((e, i) => (
            <li key={i} className="flex flex-col gap-1">
              <div
                className="prose-text"
                dangerouslySetInnerHTML={{ __html: e.html }}
              />
              {e.children.length > 0 && (
                <ul className="ml-4 mt-1 flex flex-col gap-1 text-[13px] text-[var(--color-ink-subtle)]">
                  {e.children.map((c, j) => (
                    <li
                      key={j}
                      className="prose-text"
                      dangerouslySetInnerHTML={{ __html: c }}
                    />
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </ContentWrap>
    </section>
  );
}

function Appendix({ appendix }: { appendix: NonNullable<ReturnType<typeof parseChangelog>["appendix"]> }) {
  return (
    <section className="pb-20">
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-5">
          {appendix.heading}
        </h2>
        <div
          className="prose-text max-w-xl text-sm text-[var(--color-ink-muted)] leading-relaxed mb-8"
          dangerouslySetInnerHTML={{ __html: appendix.intro }}
        />
        {appendix.sections.map((s) => (
          <div key={s.heading} className="mt-8">
            <h3 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-4">
              {s.heading}
            </h3>
            <ul className="flex flex-col gap-3 max-w-xl text-sm text-[var(--color-ink-muted)] leading-relaxed">
              {s.entries.map((e, i) => (
                <li
                  key={i}
                  className="prose-text"
                  dangerouslySetInnerHTML={{ __html: e.html }}
                />
              ))}
            </ul>
          </div>
        ))}
      </ContentWrap>
    </section>
  );
}
