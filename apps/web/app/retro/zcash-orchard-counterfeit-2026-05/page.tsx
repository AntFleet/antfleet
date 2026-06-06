import type { Metadata } from "next";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Custom page (not renderRetroEvidence) — this case is a methodology study,
// not a single "did the gate fire" receipt. The four-cell blind matrix
// (generalist × specialist × Opus 4.7 × GPT-5) needs its own layout. Existing
// renderer assumes one evidence bundle + outcome A/B/C; here we have two
// bundles run against the same commit with different prompt variants and
// the story is the comparison, not either result alone.

type Finding = {
  title: string;
  category: string;
  severity: string;
  confidence: string;
  evidence: Array<{
    path: string;
    startLine: number | null;
    endLine: number | null;
    symbol: string | null;
    quote: string | null;
  }>;
  reasoning: string;
  recommendation: string;
};

type EvidenceBundle = {
  caseId: string;
  promptVariant?: string;
  promptSha: string;
  scannedAt: string;
  modelIds: { anthropic: string; openai: string };
  anthropicRawFindings: Finding[];
  openaiRawFindings: Finding[];
};

const baseline = JSON.parse(
  readFileSync(
    join(process.cwd(), "data/retro/zcash-orchard-counterfeit-2026-05.blind-baseline.json"),
    "utf8",
  ),
) as EvidenceBundle;

const specialist = JSON.parse(
  readFileSync(
    join(process.cwd(), "data/retro/zcash-orchard-counterfeit-2026-05.blind-specialist.json"),
    "utf8",
  ),
) as EvidenceBundle;

const META_DESC =
  "Re-ran AntFleet's two-model unanimous review against the 2021 commit that introduced the Zcash Orchard counterfeiting bug disclosed by Taylor Hornby on 2026-05-29. Honest receipt: generalist surfaced adjacent soundness concerns; a 50-line halo2 context block got GPT-5 to the exact fix mechanism, blind.";

export const metadata: Metadata = {
  title: "Retro: Zcash Orchard counterfeiting bug | AntFleet",
  description: META_DESC,
};

export default function RetroZcashOrchardPage() {
  // Pick the most direct hit from each bundle for the headline matrix.
  const baselineAnthropicTopBug = baseline.anthropicRawFindings.find((f) =>
    /q_mul.*first row|enable.*q_mul.*row 0|not constrained|q_mul enabled/i.test(f.title),
  );
  const baselineOpenaiTopBug = baseline.openaiRawFindings.find((f) =>
    /scalar|constrain|decompose|not enabled|first row/i.test(f.title),
  );
  const specialistAnthropicTopBug =
    specialist.anthropicRawFindings.find((f) =>
      /x_p.*y_p.*not constrained|copy-constrained|under-constrained|process_lsb.*base/i.test(
        f.title,
      ),
    ) ?? specialist.anthropicRawFindings[0];
  const specialistOpenaiTopBug =
    specialist.openaiRawFindings.find((f) =>
      /copy-constrained|chip-boundary|base point.*not.*constrained|x_p.*y_p/i.test(f.title),
    ) ?? specialist.openaiRawFindings[0];

  return (
    <article className="mx-auto max-w-3xl px-6 py-16 text-[var(--color-ink)]">
      <header className="border-b border-[var(--color-line)] pb-10">
        <p className="font-mono text-xs tracking-widest uppercase text-[var(--color-ink-subtle)]">
          Retro · methodology study
        </p>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight leading-tight">
          Zcash Orchard counterfeiting bug
        </h1>
        <p className="mt-2 text-base text-[var(--color-ink-muted)]">
          Re-ran our pipeline against the 2021 introducing commit. Honest receipt.
        </p>
        <dl className="mt-8 grid grid-cols-2 gap-x-6 gap-y-3 font-mono text-[11px] text-[var(--color-ink-muted)]">
          <div>
            <dt className="text-[var(--color-ink-subtle)]">Disclosed</dt>
            <dd>2026-05-29 · Taylor Hornby (Shielded Labs)</dd>
          </div>
          <div>
            <dt className="text-[var(--color-ink-subtle)]">Patched</dt>
            <dd>2026-06-01 · halo2 commit d8e48efd</dd>
          </div>
          <div>
            <dt className="text-[var(--color-ink-subtle)]">Retro target</dt>
            <dd>zcash/halo2 @ cc9dd205 (2021-06-05)</dd>
          </div>
          <div>
            <dt className="text-[var(--color-ink-subtle)]">Reviewer stack</dt>
            <dd>
              {baseline.modelIds.anthropic} + {baseline.modelIds.openai}
            </dd>
          </div>
        </dl>
      </header>

      <section className="mt-12 space-y-6 leading-relaxed text-[var(--color-ink)]">
        <h2 className="text-xl font-semibold tracking-tight">The bug</h2>
        <p>
          On May 29, 2026, Taylor Hornby — security engineer at Shielded Labs, working with a custom
          audit harness he calls <code className="font-mono">zcash-full-stack-auditor</code> paired
          with Claude Opus 4.8 — disclosed a critical counterfeiting vulnerability in the Zcash
          Orchard pool. The defect: in the variable-base scalar-multiplication gadget (
          <code className="font-mono">ecc::chip::mul</code>), the per-row base coordinates{" "}
          <code className="font-mono">(x_p, y_p)</code> were written with{" "}
          <code className="font-mono">assign_advice</code> instead of{" "}
          <code className="font-mono">copy_advice</code>. The constancy gate (
          <code className="font-mono">q_mul_2</code>) kept the base constant <em>across rows</em>,
          but never anchored it to the actual base argument. A prover could supply{" "}
          <code className="font-mono">B&apos; ≠ base</code> and the proof still verified — producing{" "}
          <code className="font-mono">[scalar] B&apos;</code> instead of{" "}
          <code className="font-mono">[scalar] base</code>. Unlimited undetectable counterfeit ZEC.
        </p>
        <p>
          The defect was present from Orchard activation in May 2022 until the emergency fix on June
          1, 2026. Four years.
        </p>
      </section>

      <section className="mt-12 space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">The question</h2>
        <p>
          Would AntFleet&apos;s two-model unanimous review — Claude Opus 4.7 + GPT-5, generalist
          prompt, the same gate that runs on every PR — have caught Taylor&apos;s bug at the
          original 2021 introducing commit?
        </p>
        <p>
          And how much closer does a thin halo2-specialist prompt wrapper get us, without a custom
          audit harness or a model upgrade?
        </p>
      </section>

      <section className="mt-12 space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">Methodology</h2>
        <p>
          Four runs, two prompts × two reviewer stacks. All four had the same files, same providers,
          same temperature, same gate. The retro target is the original PR that introduced the
          gadget — <code className="font-mono">cc9dd205</code> on{" "}
          <code className="font-mono">zcash/halo2</code>, June 5, 2021. Both bug surfaces are
          present in that commit.
        </p>
        <ul className="ml-5 list-disc space-y-2 text-sm text-[var(--color-ink-muted)]">
          <li>
            <strong className="text-[var(--color-ink)]">Generalist prompt</strong> — the unmodified
            spike prompt used in production AntFleet review. Asks for findings in eight standard
            categories (correctness, security, concurrency, etc.). No halo2-specific lens.
          </li>
          <li>
            <strong className="text-[var(--color-ink)]">Specialist prompt</strong> — the generalist
            prompt prefixed with a ~50-line halo2 context block describing five circuit-soundness
            defect classes (under-constrained advice cells, constraint-scope gaps, missing
            chip-boundary anchoring, lookup omission, conditional-gate fallback). Names the{" "}
            <em>class</em> of defect; does <strong>not</strong> name the specific bug, file, or
            symbol.
          </li>
        </ul>
        <p className="text-sm text-[var(--color-ink-muted)]">
          Both runs were blind: the prompt label was scrubbed of any reference to the bug,
          mechanism, or disclosure date. The repo name (
          <code className="font-mono">zcash/halo2</code>) and the commit SHA are visible — those are
          what a real reviewer would see.
        </p>
      </section>

      <section className="mt-12 space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">Results</h2>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-subtle)]">
                <th className="py-2 pr-4 font-mono text-[11px] uppercase tracking-widest"> </th>
                <th className="py-2 pr-4 font-mono text-[11px] uppercase tracking-widest">
                  Opus 4.7
                </th>
                <th className="py-2 font-mono text-[11px] uppercase tracking-widest">GPT-5</th>
              </tr>
            </thead>
            <tbody className="text-[var(--color-ink)]">
              <tr className="border-b border-[var(--color-line)] align-top">
                <th className="py-4 pr-4 text-left font-medium">Generalist (production)</th>
                <td className="py-4 pr-4">
                  <span className="font-mono text-[11px] text-amber-700">PARTIAL</span>
                  <p className="mt-1 text-[var(--color-ink-muted)]">
                    Missed Taylor&apos;s specific defect. Flagged{" "}
                    {baselineAnthropicTopBug?.severity?.toUpperCase()}: &ldquo;
                    {baselineAnthropicTopBug?.title}&rdquo;. Adjacent counterfeit-class bug in the
                    same gadget, different mechanism.
                  </p>
                </td>
                <td className="py-4">
                  <span className="font-mono text-[11px] text-amber-700">PARTIAL</span>
                  <p className="mt-1 text-[var(--color-ink-muted)]">
                    Missed Taylor&apos;s specific defect. Flagged{" "}
                    {baselineOpenaiTopBug?.severity?.toUpperCase()}: &ldquo;
                    {baselineOpenaiTopBug?.title}&rdquo;. A different counterfeit-class soundness
                    bug in the same code.
                  </p>
                </td>
              </tr>
              <tr className="align-top">
                <th className="py-4 pr-4 text-left font-medium">
                  + halo2 specialist wrapper (blind)
                </th>
                <td className="py-4 pr-4">
                  <span className="font-mono text-[11px] text-amber-700">PARTIAL</span>
                  <p className="mt-1 text-[var(--color-ink-muted)]">
                    {specialistAnthropicTopBug?.severity?.toUpperCase()}: &ldquo;
                    {specialistAnthropicTopBug?.title}&rdquo;. Caught the bug <em>class</em> but
                    localized to <code className="font-mono text-[12px]">process_lsb</code> instead
                    of the main <code className="font-mono text-[12px]">double_and_add</code> loop.
                    Recall lift over generalist, wrong location.
                  </p>
                </td>
                <td className="py-4">
                  <span className="font-mono text-[11px] text-emerald-700">DIRECT HIT</span>
                  <p className="mt-1 text-[var(--color-ink-muted)]">
                    &ldquo;{specialistOpenaiTopBug?.title}.&rdquo; Mechanism, exploit, and
                    recommended fix line up with the actual June 1, 2026 fix commit point-for-point.
                  </p>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-12 space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">The direct hit, verbatim</h2>
        <p className="text-sm text-[var(--color-ink-muted)]">
          GPT-5, specialist wrapper, blind. No mention of the bug, the disclosure date, or Taylor in
          the prompt.
        </p>

        <blockquote className="border-l-2 border-[var(--color-line-strong)] pl-4 text-sm leading-relaxed">
          <p className="font-medium text-[var(--color-ink)]">
            {specialistOpenaiTopBug?.title}{" "}
            <span className="ml-1 font-mono text-[11px] text-[var(--color-ink-subtle)]">
              ({specialistOpenaiTopBug?.severity})
            </span>
          </p>
          <p className="mt-3 italic text-[var(--color-ink-muted)]">
            &ldquo;{specialistOpenaiTopBug?.reasoning}&rdquo;
          </p>
          <p className="mt-3 text-[var(--color-ink-muted)]">
            <span className="text-[var(--color-ink-subtle)]">Recommendation: </span>
            {specialistOpenaiTopBug?.recommendation}
          </p>
        </blockquote>

        <p className="text-sm text-[var(--color-ink-muted)]">
          Compare to the actual fix commit{" "}
          <a
            href="https://github.com/zcash/halo2/commit/d8e48efd"
            className="underline underline-offset-2"
          >
            d8e48efd
          </a>{" "}
          (Daira-Emma Hopwood, 2026-05-31):
        </p>

        <blockquote className="border-l-2 border-[var(--color-line-strong)] pl-4 text-sm italic leading-relaxed text-[var(--color-ink-muted)]">
          &ldquo;The coordinates were written with{" "}
          <code className="font-mono not-italic">assign_advice</code>, and the constancy chain
          reached neither the doubling-row nor the complete-addition base anchors. A prover could
          therefore run the incomplete loop against a free constant{" "}
          <code className="font-mono not-italic">B&apos; ≠ base</code>... Anchor the base by{" "}
          <code className="font-mono not-italic">copy_advice</code>-ing it into the first incomplete
          row.&rdquo;
        </blockquote>
      </section>

      <section className="mt-12 space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">What we claim</h2>
        <ul className="ml-5 list-disc space-y-2 text-sm">
          <li>
            <strong>
              Production AntFleet probably would not have pinned Taylor&apos;s specific bug at the
              2021 PR.
            </strong>{" "}
            Both providers, generalist prompt, blind: neither identified the missing{" "}
            <code className="font-mono">copy_advice</code> on the base coordinates in the main loop.
            Both surfaced adjacent counterfeit-class defects in the same file.
          </li>
          <li>
            <strong>
              A 50-line halo2 specialist wrapper, blind, closes the gap on one of two reviewers.
            </strong>{" "}
            GPT-5 with the wrapper produces a finding whose mechanism and recommended fix match the
            actual June 2026 fix commit. No model upgrade, no custom harness, no agentic loop. Opus
            4.7 with the same wrapper catches the bug class but localized to{" "}
            <code className="font-mono">process_lsb</code> rather than the main loop — partial
            recall lift.
          </li>
          <li>
            <strong>
              The unanimous AND-gate is the right knob for PR-time noise control and the wrong knob
              for deep targeted audit.
            </strong>{" "}
            A finding only one reviewer surfaces is dropped at the gate, even when both flagged real
            soundness bugs in the same gadget. Audit-mode review is a different product.
          </li>
        </ul>
      </section>

      <section className="mt-12 space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">What we do NOT claim</h2>
        <ul className="ml-5 list-disc space-y-2 text-sm">
          <li>
            <strong>Parity with Taylor&apos;s audit harness.</strong> Taylor used Opus 4.8 (released
            the day before discovery), an agentic loop, multiple targeted prompts, and full Zcash
            protocol context. AntFleet is a continuous diff-time generalist gate. Those are
            different products solving different problems; this study does not collapse that
            distinction.
          </li>
          <li>
            <strong>That AntFleet would have prevented the four-year window.</strong> The 2021
            reviewers were the world&apos;s best halo2 cryptographers and they missed this. Saying
            &ldquo;a 2021-deployed AntFleet would have stopped it&rdquo; requires counterfactuals we
            can&apos;t honestly defend — the model tier in 2021 was different, the install pattern
            would have been different, and a HIGH finding on a soundness flag still depends on a
            human acting on it.
          </li>
          <li>
            <strong>That the specialist wrapper is general-purpose.</strong> It was written knowing
            what defect class we wanted measured. Fairer test: run the wrapper against halo2 commits
            known to <em>not</em> contain under-constraint bugs and measure false-positive rate. We
            have not done that yet.
          </li>
        </ul>
      </section>

      <section className="mt-12 space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">Caveats</h2>
        <ul className="ml-5 list-disc space-y-2 text-sm text-[var(--color-ink-muted)]">
          <li>
            <strong className="text-[var(--color-ink)]">n=1 per cell.</strong> Provider
            non-determinism could flip individual findings between runs. Re-running the blind
            specialist 3–5× would tell us whether GPT-5&apos;s direct hit is stable.
          </li>
          <li>
            <strong className="text-[var(--color-ink)]">Single commit.</strong> We picked the commit
            that introduced the gadget. Whether the gate would surface the bug on a random
            subsequent refactor PR that doesn&apos;t touch the buggy lines is a different question.
          </li>
          <li>
            <strong className="text-[var(--color-ink)]">Specialist prompt is post-hoc.</strong> The
            five defect classes named in the wrapper were chosen knowing what bug class was present.
            The block is bug-class-fair, not bug-fair.
          </li>
          <li>
            <strong className="text-[var(--color-ink)]">Opus 4.7, not 4.8.</strong> Taylor used 4.8.
            Re-running with 4.8 on both prompts is the obvious next step.
          </li>
          <li>
            <strong className="text-[var(--color-ink)]">A first run was contaminated.</strong> The
            original baseline label contained &ldquo;under-constrained base (disclosed
            2026-05-29)&rdquo; — that string landed in the prompt&apos;s feature title and both
            providers nailed the bug, with Anthropic&apos;s reasoning explicitly citing the public
            disclosure. Discarded; blind re-runs above are the actual data.
          </li>
        </ul>
      </section>

      <section className="mt-12 space-y-4 border-t border-[var(--color-line)] pt-10">
        <h2 className="text-xl font-semibold tracking-tight">Sources & artifacts</h2>
        <ul className="space-y-2 text-sm">
          <li>
            <a
              className="underline underline-offset-2"
              href="https://forum.zcashcommunity.com/t/the-orchard-counterfeiting-vulnerability-and-next-steps/56015"
            >
              Shielded Labs: The Orchard Counterfeiting Vulnerability and Next Steps
            </a>{" "}
            — Wilcox, McGee, Hornby
          </li>
          <li>
            <a
              className="underline underline-offset-2"
              href="https://github.com/zcash/halo2/commit/d8e48efd"
            >
              Fix commit d8e48efd
            </a>{" "}
            on zcash/halo2 — &ldquo;Anchor variable-base scalar-mul incomplete-addition base&rdquo;
          </li>
          <li>
            <a
              className="underline underline-offset-2"
              href="https://github.com/zcash/halo2/commit/cc9dd20536ecd3bd3732f4ff2dc5ee230a27de55"
            >
              Introducing commit cc9dd205
            </a>{" "}
            on zcash/halo2 — &ldquo;chip::mul.rs: Implement variable-base scalar mul
            instruction.&rdquo; (2021-06-05, therealyingtong)
          </li>
          <li>
            Blind baseline evidence:{" "}
            <code className="font-mono">
              data/retro/zcash-orchard-counterfeit-2026-05.blind-baseline.json
            </code>{" "}
            — prompt SHA {baseline.promptSha.slice(0, 16)}…
          </li>
          <li>
            Blind specialist evidence:{" "}
            <code className="font-mono">
              data/retro/zcash-orchard-counterfeit-2026-05.blind-specialist.json
            </code>{" "}
            — prompt SHA {specialist.promptSha.slice(0, 16)}…
          </li>
        </ul>

        <p className="mt-6 text-sm text-[var(--color-ink-muted)]">
          Scanned {new Date(baseline.scannedAt).toISOString().slice(0, 10)} ·{" "}
          {baseline.modelIds.anthropic} + {baseline.modelIds.openai} · unanimous-gate pipeline, same
          providers as production
        </p>
      </section>
    </article>
  );
}
