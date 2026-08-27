// Sidecar context assembly for the Solidity full-contract audit KILL-TEST
// (specs/SOLIDITY_AUDIT_MODE_SPEC.md §2).
//
// LOAD-BEARING SEPARATION (spec §0): nothing here may be imported by
// review-worker / review-pipeline / chunk-repo-for-bench, and nothing here
// reaches into them. This module exists only for the kill-test harness:
//
//   - packSlices()            -> BASELINE arm. Mirrors the PR-reviewer's
//                                ~150KB size-capped chunking so the baseline
//                                faithfully represents what the current
//                                slice/diff finding phase would see.
//   - resolveContractClosure()-> NEW-MODE arm. Whole-contract dependency
//                                closure (import/inheritance graph), with NO
//                                size cap — the sidecar's own Mode-A context.
//
// Pure functions (or injected-reader) throughout so they unit-test without
// touching the network or the filesystem.

/** Default byte cap mirroring chunk-repo-for-bench's ≤150KB PR chunks. */
export const DEFAULT_MAX_SLICE_BYTES = 150_000;

export type ContextFile = { path: string; contents: string };

/** One size-capped bundle handed to a single baseline-mode review call. */
export type Slice = {
  index: number;
  files: ContextFile[];
  bytes: number;
};

/**
 * Greedy-pack files into ≤maxByte slices (sorted by path for determinism).
 * A single file larger than the cap gets its own oversize slice rather than
 * being truncated — truncation would corrupt line numbers in evidence.
 */
export function packSlices(
  files: readonly ContextFile[],
  maxBytes: number = DEFAULT_MAX_SLICE_BYTES,
): Slice[] {
  if (maxBytes <= 0) {
    throw new RangeError(`maxBytes must be positive (got: ${maxBytes})`);
  }
  const slices: Slice[] = [];
  let current: ContextFile[] = [];
  let currentBytes = 0;

  const flush = (): void => {
    if (current.length === 0) {
      return;
    }
    slices.push({ index: slices.length, files: current, bytes: currentBytes });
    current = [];
    currentBytes = 0;
  };

  const sorted = [...files].toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of sorted) {
    const size = byteLength(file.contents);
    if (size > maxBytes) {
      flush();
      slices.push({ index: slices.length, files: [file], bytes: size });
      continue;
    }
    if (currentBytes + size > maxBytes) {
      flush();
    }
    current.push(file);
    currentBytes += size;
  }
  flush();
  return slices;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Matches the quoted specifier of any Solidity import form:
 *   import "./Ownable.sol";
 *   import {A, B} from "./math/SafeMath.sol";
 *   import * as X from "@openzeppelin/contracts/access/Ownable.sol";
 */
const SOL_IMPORT_SPECIFIER_REGEX = /import\s[^;]*?"([^"]+\.sol)"\s*;/gu;

export type ClosureResult = {
  /** Repo-relative paths in the closure, BFS order from the entry file. */
  included: string[];
  /**
   * Specifiers that could not be resolved to a file in `allPaths` (remapped /
   * external deps like @openzeppelin). Reported, not silently dropped — the
   * operator needs to know the closure is incomplete.
   */
  external: string[];
};

function normalizeRelPath(fromDir: string, spec: string): string {
  const parts = [...fromDir.split("/"), ...spec.split("/")];
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

/**
 * Resolve the transitive import/inheritance closure of one entry .sol file
 * against the available file set. Relative imports resolve within the set;
 * bare/remapped specifiers (npm-style, e.g. "@openzeppelin/...") are matched
 * by path-suffix against the set and otherwise reported as external.
 *
 * `readFile` is injected so tests need no filesystem.
 */
export async function resolveContractClosure(
  entryPath: string,
  allPaths: readonly string[],
  readFile: (path: string) => Promise<string>,
): Promise<ClosureResult> {
  const pathSet = new Set(allPaths);
  const included: string[] = [];
  const external: string[] = [];
  const seen = new Set<string>([entryPath]);
  const queue: string[] = [entryPath];

  if (!pathSet.has(entryPath)) {
    throw new Error(`closure entry not in file set: ${entryPath}`);
  }

  while (queue.length > 0) {
    const current = queue.shift() as string;
    included.push(current);
    const contents = await readFile(current);
    const dir = current.includes("/") ? current.slice(0, current.lastIndexOf("/")) : "";
    for (const match of contents.matchAll(SOL_IMPORT_SPECIFIER_REGEX)) {
      const rawSpec = match[1] ?? "";
      let resolved: string | undefined;
      if (rawSpec.startsWith("./") || rawSpec.startsWith("../")) {
        const candidate = normalizeRelPath(dir, rawSpec);
        resolved = pathSet.has(candidate) ? candidate : undefined;
      } else if (rawSpec.startsWith("@") || !rawSpec.startsWith(".")) {
        // Remapped/bare specifier: try exact hit, then unique suffix match
        // (e.g. "@openzeppelin/contracts/token/ERC20/ERC20.sol" matches
        // "lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol").
        if (pathSet.has(rawSpec)) {
          resolved = rawSpec;
        } else {
          // Foundry-style remap heuristic: "@scope/pkg/path/File.sol" often maps
          // to "lib/<something>/path/File.sol". Try full-suffix, then the spec
          // with its leading @scope dropped ("path/File.sol"). Require UNIQUE.
          const withoutScope = rawSpec.replace(/^@[A-Za-z0-9_-]+\//u, "");
          const suffixMatches = [
            ...allPaths.filter((p) => p.endsWith(`/${rawSpec}`)),
            ...allPaths.filter((p) => p.endsWith(`/${withoutScope}`)),
          ];
          const unique = new Set(suffixMatches);
          if (unique.size === 1) {
            resolved = suffixMatches[0];
          }
        }
        if (resolved === undefined && !external.includes(rawSpec)) {
          external.push(rawSpec);
        }
      }
      if (resolved !== undefined && !seen.has(resolved)) {
        seen.add(resolved);
        queue.push(resolved);
      }
    }
  }

  return { included, external };
}
