// Orchestrate a single Code Scanning push for a repo: load AntFleet's
// publishable findings for the repo, serialize as SARIF, and push.
//
// Called from the SARIF ingest worker after a batch finishes with at
// least one `real` finding promoted. Gated by ANTFLEET_CODESCANNING_PUSH
// at the call site. Errors are returned as structured outcomes, never
// thrown, so the worker can log and continue.

import { loadPublicSarifFindingsForRepo } from "@/db/queries";
import { pushSarifToCodeScanning, type CodeScanningPushOutcome } from "./codescanning-push";
import { findingsToSarif } from "./sarif-export";

const SHA_RE = /^[0-9a-f]{40}$/u;

export type TriggerInput = {
  owner: string;
  repo: string;
  commitSha: string | null;
  ref?: string;
};

export type TriggerOutcome =
  | CodeScanningPushOutcome
  | { kind: "skipped"; reason: "no_findings" }
  | {
      kind: "skipped";
      reason: "invalid_commit_sha";
    };

export async function triggerCodeScanningPush(input: TriggerInput): Promise<TriggerOutcome> {
  if (input.commitSha === null || !SHA_RE.test(input.commitSha)) {
    return { kind: "skipped", reason: "invalid_commit_sha" };
  }
  const rows = await loadPublicSarifFindingsForRepo({
    owner: input.owner,
    repo: input.repo,
  });
  if (rows.length === 0) {
    return { kind: "skipped", reason: "no_findings" };
  }
  const sarif = findingsToSarif({
    owner: input.owner,
    repo: input.repo,
    findings: rows,
  });
  return pushSarifToCodeScanning({
    owner: input.owner,
    repo: input.repo,
    commitSha: input.commitSha,
    ref: input.ref ?? "refs/heads/main",
    sarif,
  });
}
