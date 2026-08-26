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

import { readFile as fsReadFile, readdir, realpath } from "node:fs/promises";
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
  /**
   * Operator-loaded remappings (prefix→target, longest-prefix applied first).
   * Item 6 fix: remappings.txt / foundry.toml are NOT .sol files so they never
   * appeared in `allPaths` — the CALLER now loads them and passes them here.
   * See loadRemappings() for the fs helper.
   */
  remappings?: readonly (readonly [string, string])[];
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
// Matches double- OR single-quoted specifiers (item 6: single quotes are rare but legal).
const SOL_IMPORT_SPECIFIER_REGEX = /import\s[^;]*?["']([^"']+\.sol)["']\s*;/gu;

/** Contract/interface/library declarations -> symbols defined by a file. */
const SOL_DECLARATION_REGEX =
  /\b(?:abstract\s+)?(?:contract|interface|library)\s+([A-Za-z_$][\w$]*)/gu;

/**
 * Usage-position references to a symbol:
 *  - word-bounded: `new X(`, `is X`, cast `X(`
 *  - compound-word embedding: `SmartAccountFactory`, `SmartAccountCreated`
 *    (real factories/events routinely embed the base symbol without typing it)
 */
/**
 * Usage-position references to a symbol:
 *  - word-bounded: `new X(`, `is X`, cast `X(`
 *  - compound-word embedding: `SmartAccountFactory` (factories embed base names)
 *  - interface-mediated: `IVault` references resolve against entry symbol `Vault`
 *    and vice versa (strip/add the Solidity `I` prefix — item 6c).
 */
function symbolVariants(symbol: string): string[] {
  const variants = new Set<string>([symbol]);
  if (symbol.startsWith("I") && symbol.length > 1 && /[A-Z]/u.test(symbol[1] ?? "")) {
    variants.add(symbol.slice(1));
  } else {
    variants.add(`I${symbol}`);
  }
  return [...variants];
}

/** Short/common symbols need a stronger signal than a bare name hit. */
function isCommonName(symbol: string): boolean {
  return symbol.length <= 4 || ["token", "math", "safe", "context", "ownable"].includes(symbol.toLowerCase());
}

function referencesSymbol(contents: string, symbol: string): boolean {
  for (const variant of symbolVariants(symbol)) {
    const escaped = variant.replace(/\$/gu, "\\$");
    if (new RegExp(`[\\s.,(){};]${escaped}[\\s(.,;{})]`, "u").test(contents)) {
      if (!isCommonName(variant)) {
        return true;
      }
      // Common-name guard: require TWO usage hits (declaration + call site)
      // before a bare common token counts as coupling.
      const hits = contents.match(new RegExp(`[\\s.,(){};]${escaped}[\\s(.,;{})]`, "gu"));
      if (hits !== null && hits.length >= 2) {
        return true;
      }
    }
    if (new RegExp(`\\b${escaped}(?=[A-Z_])`, "u").test(contents)) {
      return true; // compound embedding is already a strong signal
    }
  }
  return false;
}

const byteLen = (s: string): number => new TextEncoder().encode(s).length;

/**
 * Keep-priority rank for budget eviction ordering — REWORKED (item 6c):
 * the reverse/differentiator content is exactly what the diff-reviewer cannot
 * see, so it must NOT be first out. Deep forward-transitive padding goes first:
 *   0 entries | 1 shallow forward (direct deps, depth<=1) | 2 reverse hits
 *   | 3 deep forward transitive (depth>1, pure padding).
 */
function keepRank(info: Included): number {
  if (info.role === "entry") {
    return 0;
  }
  if (info.role === "forward") {
    return info.depth <= 1 ? 1 : 3;
  }
  return 2; // reverse differentiator
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

  // Caller-loaded remappings only — config files aren't .sol so they never
  // appeared in allPaths (item 6 fix). Use loadRemappings() from the CLI side.
  let remappings: readonly (readonly [string, string])[] = args.remappings ?? [];
  remappings = [...remappings].toSorted((a, b) => b[0].length - a[0].length);

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
  const keepOrdered = [...included.values()].toSorted((a, b) => {
    const r = keepRank(a) - keepRank(b);
    if (r !== 0) {
      return r;
    }
    const ra = keepRank(a);
    const rb = keepRank(b);
    if ((ra === 1 || ra === 2) && ra === rb) {
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
  const realRoot = await realpath(root);
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || skipDirs.has(entry.name)) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        continue; // symlink escape guard (item 6): never follow links out of root
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith(".sol")) {
        acc.push(relative(realRoot, full));
      }
    }
  };
  // Canonicalize root first (item 6): if `root` itself is a symlink, walk and
  // report paths against its real target so containment checks agree.
  await walk(realRoot);
  return acc.toSorted();
}

/** Reader that enforces the containment invariant at READ time, not just walk time. */
export function fsReadRepoFile(root: string): (p: string) => Promise<string> {
  return async (p) => {
    const realRoot = await realpath(root);
    const resolved = await realpath(join(realRoot, p));
    if (!resolved.startsWith(`${realRoot}/`)) {
      throw new Error(`path escapes target root (symlink?): ${p}`);
    }
    return fsReadFile(resolved, "utf8");
  };
}

/** Load remappings from conventional locations (caller passes them into assembleClosure). */
export async function loadRemappings(root: string): Promise<[string, string][]> {
  const pairs: [string, string][] = [];
  for (const [name, parser] of [
    ["remappings.txt", parseRemappingsTxt],
    ["foundry.toml", parseFoundryTomlRemappings],
  ] as const) {
    try {
      const text = await fsReadFile(join(await realpath(root), name), "utf8");
      pairs.push(...parser(text));
    } catch {
      // Missing/unreadable config is fine; unresolved externals stay visible.
    }
  }
  return pairs.toSorted((a, b) => b[0].length - a[0].length);
}
