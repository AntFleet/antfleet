import type { Provider } from "../provider.js";
import { FleetError, assertDefined } from "../errors.js";
import type { FixPlanOutput, ReviewOutput, RevalidateOutput } from "../types.js";
import { AgreementMode, ProviderReview, mergeFindings } from "./agreement.js";

export type StackedOptions = {
  providers: Provider[];
  agreement: AgreementMode;
};

export function stackedProvider(opts: StackedOptions): Provider {
  if (opts.providers.length === 0) {
    throw new FleetError("stacked provider requires at least one child", 2, "invalid-config");
  }
  const stackedName = `stacked[${opts.agreement}](${opts.providers.map((p) => p.name).join("+")})`;
  return {
    name: stackedName,
    async check(root: string): Promise<string> {
      const settled = await Promise.allSettled(opts.providers.map((p) => p.check(root)));
      const successes: string[] = [];
      const failures: string[] = [];
      for (const [i, s] of settled.entries()) {
        const provider = assertDefined(opts.providers[i], "stacked: provider index out of range");
        if (s.status === "fulfilled") {
          successes.push(`${provider.name}: ${s.value}`);
        } else {
          failures.push(`${provider.name}: ${formatError(s.reason)}`);
        }
      }
      if (successes.length === 0) {
        throw new FleetError(
          `stacked provider: all children failed check (${failures.join("; ")})`,
          4,
          "provider-auth",
        );
      }
      const parts = [`${stackedName} ready`, ...successes];
      if (failures.length > 0) {
        parts.push(`(unavailable: ${failures.join("; ")})`);
      }
      return parts.join(" | ");
    },
    async review(root: string, prompt: string, model: string | null): Promise<ReviewOutput> {
      const settled = await Promise.allSettled(
        opts.providers.map((p) => p.review(root, prompt, model)),
      );
      const perProvider: ProviderReview[] = [];
      const failureNotes: string[] = [];
      for (const [i, s] of settled.entries()) {
        const provider = assertDefined(opts.providers[i], "stacked: provider index out of range");
        if (s.status === "fulfilled") {
          perProvider.push({ providerName: provider.name, output: s.value });
        } else {
          failureNotes.push(`provider ${provider.name} failed: ${formatError(s.reason)}`);
          logFailure(provider.name, "review", s.reason);
        }
      }
      if (perProvider.length === 0) {
        throw new FleetError(
          `stacked provider: all children failed review (${failureNotes.join("; ")})`,
          1,
          "provider-failure",
        );
      }
      const { agreed, disagreements } = mergeFindings(perProvider, opts.agreement);
      const inspected = {
        files: dedupe(perProvider.flatMap((p) => p.output.inspected.files)),
        symbols: dedupe(perProvider.flatMap((p) => p.output.inspected.symbols)),
        notes: [
          `${stackedName}: ${perProvider.length}/${opts.providers.length} provider(s) responded`,
          ...perProvider.flatMap((p) =>
            p.output.inspected.notes.map((n) => `[${p.providerName}] ${n}`),
          ),
          ...failureNotes,
          ...disagreements.map((d) => `disagreement: ${d.finding.title} (${d.reason})`),
        ],
      };
      return { findings: agreed, inspected };
    },
    async fix(root: string, prompt: string, model: string | null): Promise<FixPlanOutput> {
      // Plan-only: return the first successful child plan. Cross-provider
      // plan merging is intentionally out of scope here.
      const settled = await Promise.allSettled(
        opts.providers.map((p) => p.fix(root, prompt, model)),
      );
      const failures: string[] = [];
      let chosen: { provider: string; plan: FixPlanOutput } | null = null;
      for (const [i, s] of settled.entries()) {
        const provider = assertDefined(opts.providers[i], "stacked: provider index out of range");
        if (s.status === "fulfilled") {
          if (chosen === null) {
            chosen = { provider: provider.name, plan: s.value };
          }
        } else {
          failures.push(`${provider.name}: ${formatError(s.reason)}`);
          logFailure(provider.name, "fix", s.reason);
        }
      }
      if (chosen === null) {
        throw new FleetError(
          `stacked provider: all children failed fix (${failures.join("; ")})`,
          1,
          "provider-failure",
        );
      }
      const failureSuffix = failures.length > 0 ? `; ${failures.length} provider(s) failed` : "";
      return {
        ...chosen.plan,
        steps: [
          `[stacked: using plan from ${chosen.provider}${failureSuffix}]`,
          ...chosen.plan.steps,
        ],
      };
    },
    async revalidate(
      root: string,
      prompt: string,
      model: string | null,
    ): Promise<RevalidateOutput> {
      const settled = await Promise.allSettled(
        opts.providers.map((p) => p.revalidate(root, prompt, model)),
      );
      const outcomes: RevalidateOutput[] = [];
      const failures: string[] = [];
      for (const [i, s] of settled.entries()) {
        const provider = assertDefined(opts.providers[i], "stacked: provider index out of range");
        if (s.status === "fulfilled") {
          outcomes.push(s.value);
        } else {
          failures.push(`${provider.name}: ${formatError(s.reason)}`);
          logFailure(provider.name, "revalidate", s.reason);
        }
      }
      if (outcomes.length === 0) {
        throw new FleetError(
          `stacked provider: all children failed revalidate (${failures.join("; ")})`,
          1,
          "provider-failure",
        );
      }
      const winningOutcome = tallyOutcomes(outcomes);
      return {
        outcome: winningOutcome,
        reasoning: `stacked revalidate across ${outcomes.length}/${opts.providers.length} provider(s): ${outcomes.map((o) => o.outcome).join(", ")}`,
        commands: dedupe(outcomes.flatMap((o) => o.commands)),
      };
    },
  };
}

function tallyOutcomes(outcomes: RevalidateOutput[]): RevalidateOutput["outcome"] {
  const counts = new Map<RevalidateOutput["outcome"], number>();
  for (const o of outcomes) {
    counts.set(o.outcome, (counts.get(o.outcome) ?? 0) + 1);
  }
  const sorted = Array.from(counts.entries()).toSorted((a, b) => b[1] - a[1]);
  const top = assertDefined(sorted[0], "tallyOutcomes: empty outcomes");
  const tied = sorted.filter(([, c]) => c === top[1]).map(([o]) => o);
  if (tied.length === 1) {
    return assertDefined(tied[0], "tallyOutcomes: unreachable");
  }
  // Tie-break: most conservative outcome wins.
  const priority: RevalidateOutput["outcome"][] = ["open", "uncertain", "false-positive", "fixed"];
  for (const p of priority) {
    if (tied.includes(p)) {
      return p;
    }
  }
  return "uncertain";
}

function dedupe<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function logFailure(provider: string, op: string, err: unknown): void {
  // Graceful degradation: stderr so operators see it without failing the run.
  process.stderr.write(`stacked: provider ${provider} ${op} failed: ${formatError(err)}\n`);
}
