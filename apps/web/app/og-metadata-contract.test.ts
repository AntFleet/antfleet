import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = join(process.cwd(), "app");

function walk(dir: string, predicate: (filePath: string) => boolean): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const filePath = join(dir, entry);
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      files.push(...walk(filePath, predicate));
      continue;
    }
    if (predicate(filePath)) files.push(filePath);
  }

  return files;
}

function routeDirForPage(pagePath: string): string {
  return pagePath.slice(0, -"/page.tsx".length);
}

describe("OG metadata contract", () => {
  it("keeps file-based OG image routes cacheable and Twitter-sized", () => {
    const ogFiles = walk(appRoot, (filePath) => filePath.endsWith("/opengraph-image.tsx"));

    expect(ogFiles.length).toBeGreaterThan(0);

    for (const filePath of ogFiles) {
      const source = readFileSync(filePath, "utf8");
      const label = relative(process.cwd(), filePath);

      expect(source, `${label} must not force edge runtime`).not.toMatch(
        /export const runtime\s*=\s*["']edge["']/,
      );
      expect(source, `${label} must export a positive revalidate window`).toMatch(
        /export const revalidate\s*=\s*[1-9][0-9]*/,
      );
      expect(source, `${label} must export 1200x630 dimensions`).toMatch(
        /export const size\s*=\s*\{\s*width:\s*1200,\s*height:\s*630\s*\}/,
      );
    }
  });

  it("does not mix inline OG images with file-based OG images on the same route", () => {
    const pageFiles = walk(appRoot, (filePath) => filePath.endsWith("/page.tsx"));

    for (const pagePath of pageFiles) {
      const routeDir = routeDirForPage(pagePath);
      const hasFileBasedOg = existsSync(join(routeDir, "opengraph-image.tsx"));
      if (!hasFileBasedOg) continue;

      const source = readFileSync(pagePath, "utf8");
      const label = relative(process.cwd(), pagePath);

      expect(source, `${label} must not emit duplicate openGraph.images`).not.toMatch(
        /openGraph:\s*\{[\s\S]*?images\s*:/,
      );
    }
  });
});
