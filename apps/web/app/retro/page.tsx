import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "AntFleet · Case Studies",
  description:
    "Post-mortem analyses of high-severity findings caught by AntFleet's dual-model review.",
};

const CASES = [
  {
    slug: "n8n-workflows-api-server-2025-08",
    title: "n8n-workflows CVE-2025-55526 — api_server.py path traversal",
    subtitle:
      "Neutral-label scan — Opus and GPT-5 both caught the path traversal and graded it at the right severity.",
    date: "June 2026",
    severity: "high",
    category: "security",
  },
  {
    slug: "zcash-orchard-counterfeit-2026-05",
    title: "Zcash Orchard counterfeiting bug",
    subtitle:
      "Re-ran our gate against the 2021 introducing commit. Generalist surfaced adjacent soundness; a 50-line halo2 wrapper got GPT-5 to the exact fix mechanism — blind. Honest receipt of where the gate works and where it doesn't.",
    date: "June 2026",
    severity: "critical",
    category: "methodology",
  },
  {
    slug: "openclaw-cve-2026-31998-synology-chat",
    title: "OpenClaw CVE-2026-31998 — synology-chat auth bypass",
    subtitle:
      "HIGH CVE on the fastest-growing OSS project in GitHub history — GPT-5 named the exact vulnerability; unanimous gate fired",
    date: "March 2026",
    severity: "high",
    category: "security",
  },
  {
    slug: "moonwell-mipx43-2026-02",
    title: "Moonwell MIP-X43 oracle bug",
    subtitle:
      "$1.78M incident — AntFleet caught a sibling of the exploited cbETH config in the same PR",
    date: "February 2026",
    severity: "high",
    category: "security",
  },
] as const;

export default function RetroCasesPage() {
  return (
    <>
      <section className="py-20 pb-12">
        <ContentWrap>
          <p className="font-mono text-xs text-[var(--color-ink-subtle)] mb-6 tracking-widest uppercase">
            Post-mortems · deep dives
          </p>

          <h1 className="text-3xl font-semibold tracking-tight text-[var(--color-ink)] leading-snug max-w-xl">
            Case studies
          </h1>

          <p className="mt-6 text-sm text-[var(--color-ink-muted)] max-w-xl leading-relaxed">
            Long-form analyses of high-severity findings. Each case study includes the original
            evidence bundle, per-provider reasoning, and reproducibility instructions.
          </p>
        </ContentWrap>
      </section>

      <SectionDivider />

      <section className="pb-20">
        <ContentWrap>
          <ul className="flex flex-col gap-4">
            {CASES.map((c) => (
              <li key={c.slug}>
                <a
                  href={`/retro/${c.slug}`}
                  className="group block rounded-md border border-[var(--color-line)] p-6 transition-colors hover:bg-[var(--color-bg-elevated)]"
                >
                  <div className="flex flex-wrap items-center gap-2 mb-4">
                    <Badge>{c.severity}</Badge>
                    <Badge>{c.category}</Badge>
                    <span className="font-mono text-[11px] text-[var(--color-ink-subtle)]">
                      {c.date}
                    </span>
                  </div>
                  <h2 className="text-xl font-semibold tracking-tight text-[var(--color-ink)] group-hover:underline underline-offset-2">
                    {c.title}
                  </h2>
                  <p className="mt-3 text-sm text-[var(--color-ink-muted)] leading-relaxed max-w-xl">
                    {c.subtitle}
                  </p>
                  <span className="mt-4 inline-block font-mono text-[11px] text-[var(--color-ink-subtle)] group-hover:text-[var(--color-ink)] transition-colors">
                    read case study →
                  </span>
                </a>
              </li>
            ))}
          </ul>

          <p className="mt-10 text-sm text-[var(--color-ink-muted)]">
            More case studies will be added as findings mature into full post-mortems.
          </p>
        </ContentWrap>
      </section>
    </>
  );
}

function ContentWrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6">{children}</div>;
}

function SectionDivider() {
  return <div className="border-t border-[var(--color-line)] my-16" />;
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-[var(--color-line-strong)] px-2 py-0.5 font-mono text-[11px] text-[var(--color-ink-muted)]">
      {children}
    </span>
  );
}
