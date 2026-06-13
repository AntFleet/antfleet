import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { logDebug, logWarn, messageOf } from "./log";

export type PostDraftInput = {
  slug: string;
  title: string;
  body: string;
};

function safeSlug(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// Operator-facing post drafts land under ANTFLEET_DRAFTS_DIR when set.
// In production (Vercel) the filesystem is read-only, so the env var is
// unset and the helper short-circuits to a log line. The previous
// implementation tried to mkdir under process.cwd() and surfaced EROFS
// to every caller, which had two real-world consequences: identity-drift
// + drift cron silently failed mid-run, and a thrown writePostDraft in
// the roast pipeline caused roast-runner's catch to mark already-
// published roasts as rejected. Both paths now treat the write as
// best-effort.
export async function writePostDraft(
  input: PostDraftInput,
  now = new Date(),
): Promise<string | null> {
  const dir = process.env["ANTFLEET_DRAFTS_DIR"];
  if (dir === undefined || dir.length === 0) {
    logDebug("post_draft.skipped", { reason: "ANTFLEET_DRAFTS_DIR_unset", slug: input.slug });
    return null;
  }
  const iso = now.toISOString().replace(/[:.]/g, "-");
  const filename = `${iso}-${safeSlug(input.slug) || "post"}.md`;
  const filePath = path.join(dir, filename);
  const markdown = `TODO(voice)\n\n# ${input.title}\n\n${input.body.trim()}\n`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, markdown, "utf8");
    return filePath;
  } catch (err) {
    logWarn("post_draft.write_failed", {
      slug: input.slug,
      dir,
      message: messageOf(err),
    });
    return null;
  }
}

export type RoastPostDraftInput = {
  submissionId: string;
  repoFullName: string;
  pageUrl: string;
  findingsCount: number;
  topSeverity: string | null;
  topFindingTitle: string | null;
  submitterHandle: string | null;
};

export async function writeRoastPostDraft(
  input: RoastPostDraftInput,
  now = new Date(),
): Promise<string | null> {
  const sevLine =
    input.topSeverity !== null
      ? `${input.findingsCount} findings · top severity: ${input.topSeverity}`
      : `${input.findingsCount} findings`;
  const lines = [sevLine, input.topFindingTitle ?? "", input.pageUrl];
  if (input.submitterHandle !== null && input.submitterHandle.trim().length > 0) {
    const handle = input.submitterHandle.replace(/^@+/, "");
    lines.push(`submitted by @${handle}`);
  }
  const body = lines.filter((l) => l.trim().length > 0).join("\n");
  const repoSlug = input.repoFullName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return writePostDraft(
    {
      slug: `roast-${repoSlug}-${input.submissionId.slice(0, 8)}`,
      title: `AntFleet roasted ${input.repoFullName}`,
      body,
    },
    now,
  );
}

// Factory watcher draft helpers. Each transition emits one draft to
// .omc/state/posts/<iso>-factory-<slug>-<phase>.md.

export type FactoryDraftBase = {
  tokenAddress: string;
  tokenSymbol: string | null;
  tokenName: string | null;
};

function factoryDraftSlug(input: FactoryDraftBase, suffix: string): string {
  const id = input.tokenSymbol ?? input.tokenName ?? input.tokenAddress.slice(0, 10);
  return `factory-${id}-${suffix}`;
}

function factoryDraftDisplay(input: FactoryDraftBase): string {
  return input.tokenSymbol ?? input.tokenName ?? input.tokenAddress.slice(0, 10);
}

export type FactoryDetectedDraftInput = FactoryDraftBase & {
  deployerAddress: string;
};

export async function writeFactoryDetectedDraft(
  input: FactoryDetectedDraftInput,
  now = new Date(),
): Promise<string | null> {
  const display = factoryDraftDisplay(input);
  const nameLine =
    input.tokenName !== null && input.tokenSymbol !== null && input.tokenName !== input.tokenSymbol
      ? `${input.tokenName} (${input.tokenSymbol}) at ${input.tokenAddress}`
      : `${display} at ${input.tokenAddress}`;
  const body = [
    "new liquid agent detected",
    nameLine,
    `deployer: ${input.deployerAddress}`,
    "antfleet is looking for the repo →",
  ].join("\n");
  return writePostDraft(
    {
      slug: factoryDraftSlug(input, "detected"),
      title: `liquid factory deploy: ${display}`,
      body,
    },
    now,
  );
}

export type FactoryRepoFoundDraftInput = FactoryDraftBase & {
  repoFullName: string;
};

export async function writeFactoryRepoFoundDraft(
  input: FactoryRepoFoundDraftInput,
  now = new Date(),
): Promise<string | null> {
  const display = factoryDraftDisplay(input);
  const body = [
    `repo found for ${display}: github.com/${input.repoFullName}`,
    "antfleet is benchmarking inside the deposit window →",
  ].join("\n");
  return writePostDraft(
    {
      slug: factoryDraftSlug(input, "repo-found"),
      title: `repo found: ${display} → ${input.repoFullName}`,
      body,
    },
    now,
  );
}

export type FactoryVerdictDraftInput = FactoryDraftBase & {
  findingsCount: number;
  topSeverity: string | null;
  pageUrl: string;
};

export async function writeFactoryVerdictDraft(
  input: FactoryVerdictDraftInput,
  now = new Date(),
): Promise<string | null> {
  const display = factoryDraftDisplay(input);
  const sevLine = input.topSeverity !== null ? `top severity: ${input.topSeverity}` : null;
  const body = [
    `pre-launch verdict for ${display}: ${input.findingsCount} consensus finding${input.findingsCount === 1 ? "" : "s"}`,
    sevLine,
    "depositors deciding in the next 24h:",
    input.pageUrl,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  return writePostDraft(
    {
      slug: factoryDraftSlug(input, "verdict"),
      title: `pre-launch verdict: ${display}`,
      body,
    },
    now,
  );
}

// Sprint 4 — operator-claim verification draft. Fires when /api/claim
// verifies a signature and attributes a repo to a factory_launches row.
export type ClaimVerifiedDraftInput = FactoryDraftBase & {
  repoFullName: string;
};

export async function writeClaimVerifiedDraft(
  input: ClaimVerifiedDraftInput,
  now = new Date(),
): Promise<string | null> {
  const display = factoryDraftDisplay(input);
  const body = [
    `operator-verified: ${display} is github.com/${input.repoFullName}`,
    "agent now has a source-of-truth code surface on antfleet",
    `antfleet.dev/agents/${input.tokenAddress}`,
  ].join("\n");
  return writePostDraft(
    {
      slug: factoryDraftSlug(input, "claimed"),
      title: `claim verified: ${display} → ${input.repoFullName}`,
      body,
    },
    now,
  );
}

// Sprint 4 — receipt of the week draft. Fires when curate-weekly.ts inserts a
// new weekly_features row (auto or operator-curated).
export type WeeklyFeatureDraftInput = {
  agentName: string;
  agentTokenAddress: string;
  findingTitle: string;
  severity: string;
  summary: string;
};

export async function writeWeeklyFeatureDraft(
  input: WeeklyFeatureDraftInput,
  now = new Date(),
): Promise<string | null> {
  const body = [
    `receipt of the week: ${input.agentName}`,
    `${input.findingTitle} (${input.severity})`,
    truncateOneLine(input.summary, 200),
    `antfleet.dev/agents/${input.agentTokenAddress}`,
  ].join("\n");
  const isoWeek = isoWeekSlug(now);
  return writePostDraft(
    {
      slug: `weekly-${isoWeek}-${input.agentName}`,
      title: `receipt of the week: ${input.agentName}`,
      body,
    },
    now,
  );
}

function truncateOneLine(value: string, maxChars: number): string {
  const stripped = value.replace(/\s+/g, " ").trim();
  return stripped.length <= maxChars ? stripped : `${stripped.slice(0, maxChars - 1).trimEnd()}…`;
}

function isoWeekSlug(now: Date): string {
  // ISO week starts Monday. Compute the year and week number for the slug.
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}
