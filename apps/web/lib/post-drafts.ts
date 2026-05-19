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
