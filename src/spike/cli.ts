/**
 * Spike-runner CLI argument parsing. Pure function so it can be unit-tested
 * without touching the network or the filesystem.
 */

import { FleetError } from "../errors.js";

export type AgreementModeName = "unanimous" | "majority" | "any";

export type SpikeArgs = {
  /** Number of independent runs to execute. Default: 1. */
  runs: number;
  /** Explicit provider list, or null to use the spike's default order. */
  providers: string[] | null;
  /** Agreement mode for the stacked filter. Default: unanimous. */
  mode: AgreementModeName;
  /** Hard cost ceiling in USD. Default: $5. */
  costCeilingUsd: number;
};

export const DEFAULT_SPIKE_ARGS: SpikeArgs = {
  runs: 1,
  providers: null,
  mode: "unanimous",
  costCeilingUsd: 5,
};

const MODE_NAMES: ReadonlySet<AgreementModeName> = new Set(["unanimous", "majority", "any"]);

function isMode(value: string): value is AgreementModeName {
  return MODE_NAMES.has(value as AgreementModeName);
}

export function parseSpikeArgs(argv: readonly string[]): SpikeArgs {
  const result: SpikeArgs = { ...DEFAULT_SPIKE_ARGS };

  const take = (flag: string, index: number): string => {
    const next = argv[index + 1];
    if (next === undefined) {
      throw new FleetError(`${flag} requires a value`, 2, "invalid-usage");
    }
    return next;
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i] ?? "";
    if (arg === "--runs") {
      const raw = take("--runs", i);
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new FleetError(`--runs must be a positive integer (got: ${raw})`, 2, "invalid-usage");
      }
      result.runs = parsed;
      i += 2;
      continue;
    }
    if (arg === "--providers") {
      const raw = take("--providers", i);
      const list = raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (list.length === 0) {
        throw new FleetError(`--providers list must be non-empty`, 2, "invalid-usage");
      }
      result.providers = list;
      i += 2;
      continue;
    }
    if (arg === "--mode") {
      const raw = take("--mode", i);
      if (!isMode(raw)) {
        throw new FleetError(
          `--mode must be one of unanimous|majority|any (got: ${raw})`,
          2,
          "invalid-usage",
        );
      }
      result.mode = raw;
      i += 2;
      continue;
    }
    if (arg === "--ceiling") {
      const raw = take("--ceiling", i);
      const parsed = Number.parseFloat(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new FleetError(
          `--ceiling must be a positive number in USD (got: ${raw})`,
          2,
          "invalid-usage",
        );
      }
      result.costCeilingUsd = parsed;
      i += 2;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      throw new FleetError(
        "usage: spike [--runs N] [--providers a,b,c] [--mode unanimous|majority|any] [--ceiling USD]",
        0,
        "usage",
      );
    }
    throw new FleetError(`unknown argument: ${arg}`, 2, "invalid-usage");
  }

  return result;
}
