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
  const lines = [
    sevLine,
    input.topFindingTitle ?? "",
    input.pageUrl,
  ];
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
