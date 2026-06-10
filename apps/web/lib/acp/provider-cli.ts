import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AcpReviewDeliverable, AcpReviewError } from "./review-contract";

const execFileAsync = promisify(execFile);

export type AcpCliResponse = {
  stdout: string;
  stderr: string;
  json: unknown;
};

export type AcpProviderCliOptions = {
  chainId?: string;
  packageId?: string | null;
  acpBinary?: string;
};

export async function setAcpJobBudget(args: {
  acpJobId: string;
  amountUsdc: string;
  options?: AcpProviderCliOptions;
}): Promise<AcpCliResponse> {
  const options = args.options ?? {};
  const cliArgs = [
    "provider",
    "set-budget",
    "--job-id",
    args.acpJobId,
    "--amount",
    args.amountUsdc,
    "--chain-id",
    options.chainId ?? "8453",
  ];
  if (options.packageId !== undefined && options.packageId !== null && options.packageId !== "") {
    cliArgs.push("--package-id", options.packageId);
  }
  return runAcpCli(options.acpBinary ?? "acp", cliArgs);
}

export async function submitAcpDeliverable(args: {
  acpJobId: string;
  deliverable: AcpReviewDeliverable | AcpReviewError;
  options?: AcpProviderCliOptions;
}): Promise<AcpCliResponse> {
  const options = args.options ?? {};
  return runAcpCli(options.acpBinary ?? "acp", [
    "provider",
    "submit",
    "--job-id",
    args.acpJobId,
    "--deliverable",
    JSON.stringify(args.deliverable),
    "--chain-id",
    options.chainId ?? "8453",
  ]);
}

async function runAcpCli(binary: string, args: string[]): Promise<AcpCliResponse> {
  const { stdout, stderr } = await execFileAsync(binary, args, {
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
  });
  const trimmed = stdout.trim();
  return {
    stdout,
    stderr,
    json: trimmed.length === 0 ? null : parseMaybeJson(trimmed),
  };
}

function parseMaybeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
