// §3 Component A — bidirectional dependency-closure context assembler.
// specs/SOLIDITY_SIDECAR_SPEC.md
//
// FORWARD: transitive `import "X.sol"` resolution (relatives + Foundry/Hardhat
// remappings). REVERSE: files that import an entry file or reference an
// entry-defined contract symbol (new X( / X( casts / is X)) — this is what
// captures factory↔instance pairs where the factory is reachable ONLY backwards
// (SmartAccount.sol never imports SmartAccountFactory.sol).
//
// Budget policy (spec §3-A): deterministic eviction from the END of the keep
// order; entries always kept whole even over budget (flagged + warned); files
// are never truncated mid-content so evidence line numbers survive.

import { readFile as fsReadFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

export const DEFAULT_BUDGET_BYTES = 400_000;

export type ClosureFileRole = "entry" | "forward" | "reverse";

/** Ordered file block handed to the finder. */
export type ClosureBlock = { path: string; contents: string };

export type AssembleClosureArgs = {
  /** Repo-relative entry .sol path(s) — the contracts that custody/move funds. */
  entries: readonly string[];
  /** All .sol paths in the tree (repo-relative, pre-listed by caller or walker). */
  allPaths: readonly string[];
  readFile: (repoRelativePath: string) => Promise<string>;
  /** Char (≈byte) budget for the assembled context. Default DEFAULT_BUDGET_BYTES. */
  budgetBytes?: number;
};

export type ClosureResult = {
  /** Final assembly order (keep-priority order; blocks rendered in this order). */
  blocks: ClosureBlock[];
  /** path -> how it entered the closure. */
  roles: ReadonlyMap<string, ClosureFileRole>;
  externalUnresolved: string[];
  bytes: number;
  truncated: boolean;
  evicted: string[];
  /** Set when entries alone exceed the budget (entries still kept whole). */
  entryOverflow: boolean;
};

type Included = { path: string; role: ClosureFileRole; depth: number; bytes: number };

/**
 * Matches quoted Solidity import specifiers (plain, named `import {A} from`,
 * namespace `import * as X from`). Same shape as context.ts's matcher.
 */
const SOL_IMPORT_SPECIFIER_REGEX = /import\s[^;]*?"([^"]+\.sol)"\s*;/gu;

/** Contract/interface/library declarations -> symbols defined by a file. */
const SOL_DECLARATION_REGEX =
  /\b(?:abstract\s+)?(?:contract|interface|library)\s+([A-Za-z_$][\w$]*)/gu;

/**
 * Usage-position references to a symbol:
 *  - word-bounded: `new X(`, `is X`, cast `X(`
 *  - compound-word embedding: `SmartAccountFactory`, `SmartAccountCreated`
 *    (real factories/events routinely embed the base symbol without typing it)
 */
function referencesSymbol(contents: string, symbol: string): boolean {
  const escaped = symbol.replace(/\$/gu, "\\$");
  return (
    new RegExp(`[\\s.,(){};]${escaped}[\\s(.,;{})]`, "u").test(contents) ||
    new RegExp(`\\b${escaped}(?=[A-Z_])`, "u").test(contents)
  );
}

/** Basename-coupling: `SmartAccountFactory.sol` embeds entry symbol SmartAccount. */
function basenameEmbeds(path: string, symbol: string): boolean {
  const base = path.split("/").pop() ?? "";
  return base.includes(symbol);
}

// --- Remappings --------------------------------------------------------------
// Parsed heuristically (documented): remappings.txt lines "prefix=target",
// and foundry.toml [profile.default] remappings = ["prefix=target", ...].

export function parseRemappingsTxt(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.split("#")[0]?.trim() ?? "";
    if (line.length === 0 || !line.includes("=")) {
      continue;
    }
    const eq = line.indexOf("=");
    const prefix = line.slice(0, eq).trim().replace(/\/$/u, "");
    const target = line
      .slice(eq + 1)
      .trim()
      .replace(/\/$/u, "");
    if (prefix.length > 0 && target.length > 0) {
      out.push([prefix, target]);
    }
  }
  return out.toSorted((a, b) => b[0].length - a[0].length); // longest-prefix first
}

export function parseFoundryTomlRemappings(text: string): [string, string][] {
  const out: [string, string][] = [];
  // Take the LAST [profile...] section containing a remappings array; good
  // enough for the common single-profile case, deterministic either way.
  for (const match of text.matchAll(/remappings\s*=\s*\[([^\]]*)\]/gu)) {
    for (const entry of match[1]?.matchAll(/"([^"]+)"/gu) ?? []) {
      const pair = entry[1] ?? "";
      const eq = pair.indexOf("=");
      if (eq > 0) {
        const prefix = pair.slice(0, eq).trim().replace(/\/$/u, "");
        const target = pair
          .slice(eq + 1)
          .trim()
          .replace(/\/$/u, "");
        if (prefix.length > 0 && target.length > 0) {
          out.push([prefix, target]);
        }
      }
    }
  }
  return out.toSorted((a, b) => b[0].length - a[0].length);
}

function normalizeRel(fromDir: string, spec: string): string {
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

function resolveSpecifier(args: {
  spec: string;
  importerDir: string;
  pathSet: ReadonlySet<string>;
  remappings: readonly (readonly [string, string])[];
}): { resolved?: string; external?: string } {
  const { spec, importerDir, pathSet, remappings } = args;
  if (spec.startsWith("./") || spec.startsWith("../")) {
    const candidate = normalizeRel(importerDir, spec);
    return pathSet.has(candidate) ? { resolved: candidate } : {};
  }
  // Bare/remapped: exact hit, then longest-prefix remap, then unique suffix.
  if (pathSet.has(spec)) {
    return { resolved: spec };
  }
  for (const [prefix, target] of remappings) {
    if (spec === prefix || spec.startsWith(`${prefix}/`)) {
      const rest = spec.slice(prefix.length).replace(/^\//u, "");
      const candidate = rest.length === 0 ? target : `${target}/${rest}`;
      if (pathSet.has(candidate)) {
        return { resolved: candidate };
      }
      // Target may be a lib root whose layout differs: fall back to a UNIQUE
      // file under the mapped target ending with the remainder of the path.
      const tailMatch = [...pathSet].filter((p) => p.startsWith(`${target}/`) && p.endsWith(rest));
      if (tailMatch.length === 1) {
        const resolved = tailMatch[0];
        if (resolved !== undefined) {
          return { resolved };
        }
      }
    }
  }
  const withoutScope = spec.replace(/^@[A-Za-z0-9_-]+\//u, "");
  const suffixMatches = [...pathSet].filter(
    (p) => p.endsWith(`/${spec}`) || p === spec || p.endsWith(`/${withoutScope}`),
  );
  const unique = new Set(suffixMatches);
  if (unique.size === 1) {
    const resolved = suffixMatches[0];
    if (resolved !== undefined) {
      return { resolved };
    }
  }
  return { external: spec };
}

export async function assembleClosure(args: AssembleClosureArgs): Promise<ClosureResult> {
  const budget = args.budgetBytes ?? DEFAULT_BUDGET_BYTES;
  const pathSet = new Set(args.allPaths);
  for (const entry of args.entries) {
    if (!pathSet.has(entry)) {
      throw new Error(`closure entry not in file set: ${entry}`);
    }
  }

  // Remappings are best-effort from conventional locations.
  let remappings: readonly (readonly [string, string])[] = [];
  for (const [name, parser] of [
    ["remappings.txt", parseRemappingsTxt],
    ["foundry.toml", parseFoundryTomlRemappings],
  ] as const) {
    if (!pathSet.has(name)) {
      continue;
    }
    try {
      const text = await args.readFile(name);
      remappings = [...remappings, ...parser(text)];
    } catch {
      // Unreadable config: proceed without it; unresolved externals stay visible.
    }
  }

  const cache = new Map<string, string>();
  const read = async (p: string): Promise<string> => {
    const hit = cache.get(p);
    if (hit !== undefined) {
      return hit;
    }
    const contents = await args.readFile(p);
    cache.set(p, contents);
    return contents;
  };

  const byteLen = (s: string): number => new TextEncoder().encode(s).length;

  // --- Forward BFS from entries ---
  const included = new Map<string, Included>();
  const external = new Set<string>();
  const queue: string[] = [];
  for (const entry of args.entries) {
    included.set(entry, { path: entry, role: "entry", depth: 0, bytes: 0 });
    queue.push(entry);
  }

  const processForward = async (): Promise<void> => {
    let head = 0;
    while (head < queue.length) {
      const current = queue[head];
      head += 1;
      const info = included.get(current ?? "");
      const depth = info?.depth ?? 0;
      const contents = await read(current ?? "");
      included.set(current ?? "", {
        ...(info ?? { path: current ?? "", role: "forward", depth }),
        bytes: byteLen(contents),
        depth,
      });
      const dir = current?.includes("/") ? (current.slice(0, current.lastIndexOf("/")) ?? "") : "";
      for (const match of contents.matchAll(SOL_IMPORT_SPECIFIER_REGEX)) {
        const spec = match[1] ?? "";
        const result = resolveSpecifier({
          spec,
          importerDir: dir,
          pathSet,
          remappings,
        });
        if (result.external !== undefined) {
          external.add(result.external);
          continue;
        }
        const resolved = result.resolved;
        if (resolved !== undefined && !included.has(resolved)) {
          included.set(resolved, { path: resolved, role: "forward", depth: depth + 1, bytes: 0 });
          queue.push(resolved);
        }
      }
    }
  };
  await processForward();

  // --- Reverse pass against ENTRY-defined symbols ---
  const entrySymbols = new Set<string>();
  for (const entry of args.entries) {
    const contents = await read(entry);
    for (const match of contents.matchAll(SOL_DECLARATION_REGEX)) {
      const symbol = match[1];
      if (symbol !== undefined) {
        entrySymbols.add(symbol);
      }
    }
  }
  const reverseHits: string[] = [];
  if (entrySymbols.size > 0) {
    for (const p of args.allPaths) {
      if (included.has(p)) {
        continue;
      }
      const contents = await read(p);
      let hit = false;
      for (const match of contents.matchAll(SOL_IMPORT_SPECIFIER_REGEX)) {
        const spec = match[1] ?? "";
        const base = spec.split("/").pop() ?? "";
        if (args.entries.some((e) => e.endsWith(`/${base}`) || e === base)) {
          hit = true;
          break;
        }
      }
      if (!hit) {
        for (const symbol of entrySymbols) {
          if (referencesSymbol(contents, symbol) || basenameEmbeds(p, symbol)) {
            hit = true;
            break;
          }
        }
      }
      if (hit) {
        reverseHits.push(p);
      }
    }
  }
  // Reverse hits JOIN THE FRONTIER: their forward imports resolve transitively.
  for (const p of reverseHits) {
    if (!included.has(p)) {
      included.set(p, { path: p, role: "reverse", depth: 1_000_000, bytes: 0 });
      queue.push(p);
    }
  }
  await processForward();
  // Files pulled in by reverse hits' forward imports keep role "forward".

  // --- Keep order + budget eviction ---
  const rank = (info: Included): number => {
    if (info.role === "entry") {
      return 0;
    }
    if (info.role === "reverse") {
      return 2;
    }
    return 1; // forward (depth used secondarily below)
  };
  const keepOrdered = [...included.values()].toSorted((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) {
      return r;
    }
    if (rank(a) === 1) {
      const d = a.depth - b.depth;
      if (d !== 0) {
        return d;
      }
    }
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  const blocks: ClosureBlock[] = [];
  const evicted: string[] = [];
  let totalBytes = 0;
  let entryBytes = 0;
  for (const info of keepOrdered) {
    const contents = await read(info.path);
    info.bytes = byteLen(contents);
    totalBytes += info.bytes;
    if (info.role === "entry") {
      entryBytes += info.bytes;
    }
  }
  const entryOverflow = entryBytes > budget;
  if (totalBytes > budget) {
    for (let i = keepOrdered.length - 1; i >= 0 && totalBytes > budget; i -= 1) {
      const info = keepOrdered[i];
      if (info === undefined || info.role === "entry") {
        continue; // entries always kept whole
      }
      totalBytes -= info.bytes;
      evicted.unshift(info.path);
      included.delete(info.path);
    }
  }

  for (const info of keepOrdered) {
    if (!included.has(info.path)) {
      continue; // evicted
    }
    blocks.push({ path: info.path, contents: await read(info.path) });
  }

  const roles = new Map<string, ClosureFileRole>();
  for (const info of keepOrdered) {
    if (included.has(info.path)) {
      roles.set(info.path, info.role);
    }
  }

  return {
    blocks,
    roles,
    externalUnresolved: [...external].toSorted(),
    bytes: totalBytes,
    truncated: evicted.length > 0 || entryOverflow,
    evicted,
    entryOverflow,
  };
}

// --- Filesystem walker (CLI convenience; tests inject readers instead) -------

export async function listSolFiles(root: string): Promise<string[]> {
  const acc: string[] = [];
  // NOTE: "lib" is deliberately NOT skipped — Foundry checks remapped deps out
  // there; they are exactly what the closure needs. Only package-manager and
  // build-output noise is excluded.
  const skipDirs = new Set(["node_modules", "out", "cache", ".git", ".fleet"]);
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || skipDirs.has(entry.name)) {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith(".sol")) {
        acc.push(relative(root, full));
      }
    }
  };
  await walk(root);
  return acc.toSorted();
}

export function fsReadRepoFile(root: string): (p: string) => Promise<string> {
  return (p) => fsReadFile(join(root, p), "utf8");
}
