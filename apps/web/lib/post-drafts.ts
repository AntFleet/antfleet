import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

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

export async function writePostDraft(input: PostDraftInput, now = new Date()): Promise<string> {
  const dir = path.join(workspaceRoot(), ".omc", "state", "posts");
  await mkdir(dir, { recursive: true });
  const iso = now.toISOString().replace(/[:.]/g, "-");
  const filename = `${iso}-${safeSlug(input.slug) || "post"}.md`;
  const filePath = path.join(dir, filename);
  const markdown = `TODO(voice)\n\n# ${input.title}\n\n${input.body.trim()}\n`;
  await writeFile(filePath, markdown, "utf8");
  return filePath;
}

function workspaceRoot(): string {
  let current = process.cwd();
  for (;;) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
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
): Promise<string> {
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
): Promise<string> {
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
): Promise<string> {
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
): Promise<string> {
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
