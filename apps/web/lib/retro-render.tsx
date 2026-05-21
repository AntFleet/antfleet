// Pure renderer for the static retro receipt page at
// /retro/<case-id>. Takes the verbatim Phase 1 evidence bundle + the
// master-copy caveat strings, returns one <article> subtree.
//
// Why this lives in its own module (rather than inlined in page.tsx):
// future retro cases ship as additional sibling pages under /retro/<case-id>
// and reuse the same renderer with their own JSON. The page file's job is
// just I/O (load JSON + caveat from disk) + the page-specific caveat short
// + medium copy. Everything else flows through here.
//
// Constraint: no I/O, no DB, no fetch. Pure function of (evidence, caveat).

import type { ReactElement } from "react";

import type { Finding } from "./review-types";

// ---------- Types ----------------------------------------------------------

// `Finding` is the canonical type re-exported from review-types.ts → the
// upstream @antfleet/cli ReviewOutput shape. Reusing it (rather than
// redefining a structural copy) ensures the retro page automatically picks
// up schema additions; if a `triage` or similar field lands upstream the
// renderer compiles unchanged.

export type RetroEvidence = {
  caseId: string;
  label: string;
  incidentDate: string;
  lossesUsd: number;
  repo: string;
  parentSha: string;
  introducingPrSha: string;
  promptSha: string;
  promptFiles: string[];
  pipelineVersion: string;
  pipelineCommitSha: string;
  modelIds: { anthropic: string; openai: string };
  scannedAt: string;
  anthropicRawFindings: Finding[];
  openaiRawFindings: Finding[];
  anthropicError: string | null;
  openaiError: string | null;
  unanimousFindings: Finding[];
  introducingFiles: string[];
  introducingHunks: Array<{ path: string; lineStart: number; lineEnd: number }>;
  outcome: "A" | "B" | "C";
  outcomeRationale: string;
};

export type CaveatCopy = {
  short: string;
  medium: string;
  long: string;
};

// AI-coauthor attribution for cases where the introducing commit carries a
// `Co-Authored-By: <agent>` trailer. Optional — the renderer omits the
// callout when this parameter isn't supplied, so the module remains usable
// for future non-AI-coauthored cases without a code change.
export type AICoauthor = {
  author: string;
  coauthor: string;
  commitSha: string;
  commitUrl: string;
};

// External post-mortem source links. Optional — the renderer omits the
// entire footer section when this array is empty/undefined. Pattern keeps
// the operator from accidentally shipping dead `href="#"` placeholders if
// they merge before pasting real URLs.
export type RetroSource = {
  label: string;
  url: string;
};

// ---------- Helpers (inlined per ralplan: no new shared lib) ---------------

// Format a USD integer as "$1.78M" / "$340K" / "$1.20B". Used both in the
// hero and in the OG image generator, hence the export. Truncates at two
// decimals; we'd rather under-state than over-claim.
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return "$0";
  if (amount >= 1_000_000_000) {
    return `$${(amount / 1_000_000_000).toFixed(2).replace(/\.?0+$/, "")}B`;
  }
  if (amount >= 1_000_000) {
    return `$${(amount / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  }
  if (amount >= 1_000) {
    return `$${(amount / 1_000).toFixed(0)}K`;
  }
  return `$${amount.toFixed(0)}`;
}

function shortSha(sha: string, n = 12): string {
  return sha.length > n ? sha.slice(0, n) : sha;
}

function formatEvidenceLocation(ev: Finding["evidence"][number]): string {
  if (ev.startLine === null) return ev.path;
  if (ev.endLine === null || ev.endLine === ev.startLine) {
    return `${ev.path}:${ev.startLine}`;
  }
  return `${ev.path}:${ev.startLine}-${ev.endLine}`;
}

// Tailwind tone for the outcome banner. Tokens match globals.css (var(--color-*));
// outcome-specific tints are local Tailwind utility classes since we only need
// three muted accents and the constraint forbids adding to globals.css.
function outcomeClasses(outcome: RetroEvidence["outcome"]): string {
  switch (outcome) {
    case "A":
      return "border-emerald-300 bg-emerald-50 text-emerald-900";
    case "B":
      return "border-amber-300 bg-amber-50 text-amber-900";
    case "C":
    default:
      return "border-slate-300 bg-slate-50 text-slate-900";
  }
}

// ---------- Renderer -------------------------------------------------------

export function renderRetroEvidence(
  evidence: RetroEvidence,
  caveat: CaveatCopy,
  aiCoauthor?: AICoauthor,
  sources?: RetroSource[],
): ReactElement {
  const reproduceCommand =
    `pnpm exec tsx apps/web/scripts/run-retro-scan.ts \\\n` +
    `  --repo ${evidence.repo} --pr-sha ${evidence.introducingPrSha} \\\n` +
    `  --case-id ${evidence.caseId} --label "${evidence.label}" \\\n` +
    `  --loss-usd ${evidence.lossesUsd} --incident-date ${evidence.incidentDate}`;

  return (
    <article className="mx-auto max-w-4xl px-6 py-16 text-[var(--color-ink)]">
      {/* 1 — HERO */}
      <header className="mb-16">
        <p className="font-mono text-xs uppercase tracking-widest text-[var(--color-ink-subtle)] mb-4">
          Retro · {evidence.caseId}
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-[var(--color-ink)] leading-tight">
          {evidence.label}
        </h1>
        <p className="mt-5 text-lg text-[var(--color-ink-muted)] leading-relaxed max-w-2xl">
          {caveat.short}
        </p>
        <div className="mt-10 flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <span className="text-5xl font-semibold tracking-tight text-[var(--color-ink)]">
            {formatUsd(evidence.lossesUsd)}
          </span>
          <span className="font-mono text-sm text-[var(--color-ink-subtle)]">
            incident · {evidence.incidentDate}
          </span>
        </div>
      </header>

      {/* 1.5 — AI COAUTHOR CALLOUT (optional) */}
      {aiCoauthor !== undefined && (
        <section
          aria-labelledby="ai-coauthor-heading"
          className="mb-12 rounded-md border-l-4 border-[var(--color-line-strong)] bg-[var(--color-bg-elevated)] px-6 py-5"
        >
          <p
            id="ai-coauthor-heading"
            className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)] mb-3"
          >
            AI coauthor
          </p>
          <p className="text-base text-[var(--color-ink)] leading-relaxed">
            The introducing commit was authored by{" "}
            <span className="font-medium">{aiCoauthor.author}</span> and coauthored by{" "}
            <span className="font-medium">{aiCoauthor.coauthor}</span> per the commit trailer.
          </p>
          <a
            href={aiCoauthor.commitUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-block font-mono text-xs text-[var(--color-ink)] underline underline-offset-2 hover:text-[var(--color-ink-muted)] break-all"
          >
            View commit {shortSha(aiCoauthor.commitSha)} on GitHub →
          </a>
        </section>
      )}

      {/* 2 — OUTCOME BANNER */}
      <section
        className={`retro-outcome-${evidence.outcome.toLowerCase()} mb-16 rounded-md border px-6 py-5 ${outcomeClasses(
          evidence.outcome,
        )}`}
      >
        <p className="font-mono text-xs uppercase tracking-widest mb-2 opacity-70">
          Outcome {evidence.outcome}
        </p>
        <p className="text-base leading-relaxed">{caveat.medium}</p>
      </section>

      {/* 3 — METHODOLOGY */}
      <section className="mb-16">
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-5">
          Methodology
        </h2>
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-[160px_1fr] text-sm">
          <dt className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">
            Repo
          </dt>
          <dd className="font-mono text-[var(--color-ink)] break-all">
            {evidence.repo}@{shortSha(evidence.parentSha)}
          </dd>

          <dt className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">
            Introducing PR
          </dt>
          <dd className="font-mono text-[var(--color-ink)] break-all">
            {evidence.introducingPrSha}
          </dd>

          <dt className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">
            Prompt SHA
          </dt>
          <dd className="font-mono text-[var(--color-ink)] break-all">{evidence.promptSha}</dd>

          <dt className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">
            Pipeline
          </dt>
          <dd className="font-mono text-[var(--color-ink)] break-all">
            {evidence.pipelineVersion} @ {shortSha(evidence.pipelineCommitSha)}
          </dd>

          <dt className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">
            Models
          </dt>
          <dd className="font-mono text-[var(--color-ink)] break-all">
            {evidence.modelIds.anthropic}, {evidence.modelIds.openai}
          </dd>

          <dt className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">
            Scanned at
          </dt>
          <dd className="font-mono text-[var(--color-ink)] break-all">{evidence.scannedAt}</dd>
        </dl>

        <div className="mt-8 rounded-md border-l-4 border-[var(--color-line-strong)] bg-[var(--color-bg-elevated)] px-5 py-4 text-sm leading-relaxed text-[var(--color-ink-muted)]">
          {caveat.long}
        </div>
      </section>

      {/* 4 — REPRODUCE */}
      <section className="mb-16">
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-5">
          Reproduce this scan
        </h2>
        <p className="text-sm leading-relaxed text-[var(--color-ink-muted)] mb-4">
          Requires the AntFleet retro-scan tool — open-source release pending. The prompt SHA and
          pipeline commit SHA in the methodology block above pin the methodology regardless of when
          the tool ships.
        </p>
        <pre className="overflow-x-auto rounded-md border border-[var(--color-line)] bg-[var(--color-bg-elevated)] p-4 font-mono text-xs leading-relaxed text-[var(--color-ink)]">
          <code>{reproduceCommand}</code>
        </pre>
      </section>

      {/* 5 — PER-PROVIDER FINDINGS */}
      <section className="mb-16">
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-5">
          Per-provider findings (verbatim)
        </h2>
        <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
          <ProviderColumn
            providerName="Anthropic"
            modelId={evidence.modelIds.anthropic}
            findings={evidence.anthropicRawFindings}
            error={evidence.anthropicError}
          />
          <ProviderColumn
            providerName="OpenAI"
            modelId={evidence.modelIds.openai}
            findings={evidence.openaiRawFindings}
            error={evidence.openaiError}
          />
        </div>
      </section>

      {/* 6 — UNANIMOUS GATE */}
      <section className="mb-16">
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-5">
          Unanimous gate (intersection)
        </h2>
        {evidence.unanimousFindings.length === 0 ? (
          <p className="text-sm italic text-[var(--color-ink-muted)]">
            (none — the unanimous gate did not fire on any finding)
          </p>
        ) : (
          <div className="flex flex-col gap-6">
            {evidence.unanimousFindings.map((f, i) => (
              <FindingCard key={`u-${i}`} finding={f} />
            ))}
          </div>
        )}
      </section>

      {/* 7 — SOURCES FOOTER (gated: omitted when no real URLs supplied) */}
      {sources !== undefined && sources.length > 0 && (
        <footer className="border-t border-[var(--color-line)] pt-8">
          <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-4">
            Source post-mortems
          </h2>
          <ul className="flex flex-col gap-2 text-sm">
            {sources.map((s, i) => (
              <li key={i}>
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--color-ink)] underline underline-offset-2 hover:text-[var(--color-ink-muted)]"
                >
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
        </footer>
      )}
    </article>
  );
}

// ---------- Sub-components -------------------------------------------------

function ProviderColumn({
  providerName,
  modelId,
  findings,
  error,
}: {
  providerName: string;
  modelId: string;
  findings: Finding[];
  error: string | null;
}): ReactElement {
  return (
    <div>
      <h3 className="text-sm font-semibold text-[var(--color-ink)] mb-1">{providerName}</h3>
      <p className="font-mono text-[11px] text-[var(--color-ink-subtle)] mb-5">{modelId}</p>
      {error !== null ? (
        <p className="text-sm italic text-[var(--color-ink-muted)]">(provider error: {error})</p>
      ) : findings.length === 0 ? (
        <p className="text-sm italic text-[var(--color-ink-muted)]">(no findings)</p>
      ) : (
        <div className="flex flex-col gap-6">
          {findings.map((f, i) => (
            <FindingCard key={i} finding={f} />
          ))}
        </div>
      )}
    </div>
  );
}

function FindingCard({ finding }: { finding: Finding }): ReactElement {
  const first = finding.evidence[0];
  const location = first !== undefined ? formatEvidenceLocation(first) : null;
  return (
    <div className="rounded-md border border-[var(--color-line)] bg-[var(--color-bg)] p-5">
      <h3 className="text-base font-semibold text-[var(--color-ink)] leading-snug">
        {finding.title}
      </h3>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] uppercase tracking-widest rounded-full border border-[var(--color-line-strong)] px-2 py-0.5 text-[var(--color-ink-muted)]">
          {finding.severity} / {finding.confidence}
        </span>
        <span className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">
          {finding.category}
        </span>
      </div>
      {location !== null && (
        <p className="mt-3 font-mono text-xs text-[var(--color-ink)] break-all">{location}</p>
      )}
      <p className="mt-4 text-sm leading-relaxed text-[var(--color-ink-muted)] whitespace-pre-line">
        {finding.reasoning}
      </p>
      <p className="mt-4 text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)]">
        Fix
      </p>
      <p className="mt-1 text-sm leading-relaxed text-[var(--color-ink-muted)] whitespace-pre-line">
        {finding.recommendation}
      </p>
    </div>
  );
}
