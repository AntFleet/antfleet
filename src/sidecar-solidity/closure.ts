// §3 Component A — bidirectional dependency-closure context assembler.
// specs/SOLIDITY_SIDECAR_SPEC.md
//
// CLOSURE_UPGRADE_PROMPT.md item 1 — the closure follows REAL EDGES, not a
// name dragnet:
//   - FORWARD: transitive `import "X.sol"` resolution (relatives + Foundry/
//     Hardhat remappings).
//   - INHERITANCE: the entire `is A, B` chain of every included contract,
//     resolving each base to its IMPLEMENTATION source file (not just an
//     interface with the same name) — a base in the chain is never optional.
//   - INTERFACE→IMPL: interface-typed state vars / immutables / params hold
//     runtime addresses imports cannot see through; the sole in-repo
//     implementer (or an explicit `is <I>` implementer) of each referenced
//     interface is pulled in, tagged `impl-of-interface <I>`. Unresolvable
//     edges surface loudly in `unresolvedEdges`.
//   - REVERSE (LAST RESORT ONLY): factory/symbol name coupling. Never ranked
//     ahead of a real-edge file; evicted FIRST under budget pressure.
//
// Test/mock/PoC paths are excluded by default (upgrade item 1.3) so answer
// keys never leak into eval arms or production prompts; `--include-tests`
// opts back in.
//
// Budget policy (spec §3-A): deterministic eviction from the END of the keep
// order; entries always kept whole even over budget (flagged + warned); files
// are never truncated mid-content so evidence line numbers survive.

import { readFile as fsReadFile, readdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";

export const DEFAULT_BUDGET_BYTES = 400_000;

/**
 * Ordered most→least essential. `reverse` (name-heuristic coupling) is the
 * LAST RESORT tier: it never outranks a real-edge file (CLOSURE_UPGRADE 1.4).
 */
export type ClosureFileRole = "entry" | "forward" | "inherited" | "impl" | "reverse";

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
  /**
   * Upgrade item 1.3: test/mock/PoC/script paths are EXCLUDED by default —
   * in evals they leak the answer key; in production they are pure noise.
   * Opt-in only.
   */
  includeTests?: boolean;
};

export type ClosureResult = {
  /** Final assembly order (keep-priority order; blocks rendered in this order). */
  blocks: ClosureBlock[];
  /** path -> how it entered the closure. */
  roles: ReadonlyMap<string, ClosureFileRole>;
  /** For `impl` roles: path -> which interface it implements. */
  implOf: ReadonlyMap<string, string>;
  externalUnresolved: string[];
  /**
   * Upgrade item 1.2: interface-typed address edges that could NOT be resolved
   * to an in-repo implementation. Surfaced loudly — never silently claim a
   * complete closure.
   */
  unresolvedEdges: string[];
  bytes: number;
  truncated: boolean;
  evicted: string[];
  /** Set when entries alone exceed the budget (entries still kept whole). */
  entryOverflow: boolean;
};

type Included = {
  path: string;
  role: ClosureFileRole;
  depth: number;
  bytes: number;
};

// --- Lexical helpers ----------------------------------------------------------

/**
 * Matches quoted Solidity import specifiers (plain, named `import {A} from`,
 * namespace `import * as X from`). Double- OR single-quoted (item 6: single
 * quotes are rare but legal).
 */
const SOL_IMPORT_SPECIFIER_REGEX = /import\s[^;]*?["']([^"']+\.sol)["']\s*;/gu;

/**
 * Declarations WITH inheritance lists: captures kind, name, and the raw base
 * list (`contract X is A(1), B.C {`). The base list ends at the body brace or
 * a stray semicolon; call args on bases stay inside the captured text.
 */
const SOL_DECLARATION_FULL_REGEX =
  /\b(abstract\s+)?(contract|interface|library)\s+([A-Za-z_$][\w$]*)\s*(?:is\s+([^{;]+?)\s*)?[;{]/gu;

/** First identifier of one inheritance specifier: `Base(arg)` -> `Base`. */
const BASE_NAME_REGEX = /^\s*([A-Za-z_$][\w$]*)/u;

type DeclInfo = {
  path: string;
  kind: "contract" | "interface" | "library";
  /** Resolved inheritance base symbol names (call args stripped). */
  bases: string[];
};

function parseDeclarations(contents: string): Map<string, Omit<DeclInfo, "path">> {
  const out = new Map<string, Omit<DeclInfo, "path">>();
  for (const match of contents.matchAll(SOL_DECLARATION_FULL_REGEX)) {
    const kind = match[2] as DeclInfo["kind"];
    const name = match[3];
    if (name === undefined) continue;
    const rawBases = match[4] ?? "";
    const bases: string[] = [];
    for (const segment of rawBases.split(",")) {
      const baseName = segment.match(BASE_NAME_REGEX)?.[1];
      if (baseName !== undefined) {
        bases.push(baseName);
      }
    }
    out.set(name, { kind, bases });
  }
  return out;
}

/**
 * Upgrade item 1.3: default-excluded paths. Under `test/`, `tests/`, `mock/`,
 * `mocks/`, `script(s)/` anywhere in the path, or Foundry-style `*.t.sol` /
 * `*.PoC.sol` suffixes. These leak answers into eval arms and inject noise
 * into production prompts.
 */
const TEST_PATH_REGEX =
  /(?:^|\/)(?:test|tests|mock|mocks|script|scripts)(?:\/|$)|\.t\.sol$|\.PoC\.sol$/iu;

export function isTestOrMockPath(path: string): boolean {
  return TEST_PATH_REGEX.test(path);
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

const byteLen = (s: string): number => new TextEncoder().encode(s).length;

/**
 * Keep-priority rank — REAL EDGES FIRST (CLOSURE_UPGRADE 1.4):
 *   0 entries
 *   1 direct forward deps + inherited bases + resolved impls — the carriers of
 *     cross-file bug mechanisms; inherited bases are NEVER optional
 *   2 deep forward-transitive padding
 *   3 name-heuristic reverse hits — LAST RESORT, evicted FIRST; a lexical
 *     coincidence must never consume budget ahead of a real edge.
 */
function keepRank(info: Included): number {
  if (info.role === "entry") {
    return 0;
  }
  if (info.role === "inherited" || info.role === "impl") {
    return 1;
  }
  if (info.role === "forward") {
    return info.depth <= 1 ? 1 : 2;
  }
  return 3; // reverse: name-heuristic last resort
}

// --- Symbol usage (reverse LAST-RESORT pass only) -----------------------------

/**
 * Usage-position references to a symbol:
 *  - word-bounded: `new X(`, `is X`, cast `X(`
 *  - compound-word embedding: `SmartAccountFactory` (factories embed base names)
 *  - interface-mediated: `IVault` references resolve against entry symbol `Vault`
 *    and vice versa (strip/add the Solidity `I` prefix — item 6c).
 *
 * ONLY used by the last-resort reverse pass; never a primary include.
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
  return (
    symbol.length <= 4 ||
    ["token", "math", "safe", "context", "ownable"].includes(symbol.toLowerCase())
  );
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
      if (!isCommonName(variant)) {
        return true; // compound embedding: strong for long symbols (SmartAccountFactory)
      }
    }
  }
  return false;
}

/** Basename-coupling: `SmartAccountFactory.sol` embeds entry symbol SmartAccount. */
function basenameEmbeds(path: string, symbol: string): boolean {
  const base = path.split("/").pop() ?? "";
  return base.includes(symbol);
}

export async function assembleClosure(args: AssembleClosureArgs): Promise<ClosureResult> {
  const budget = args.budgetBytes ?? DEFAULT_BUDGET_BYTES;
  const includeTests = args.includeTests ?? false;

  // Upgrade 1.3: exclude test/mock/PoC/script paths unless explicitly opted in.
  const visiblePaths = includeTests
    ? args.allPaths
    : args.allPaths.filter((p) => !isTestOrMockPath(p));
  const pathSet = new Set(visiblePaths);
  for (const entry of args.entries) {
    if (!pathSet.has(entry)) {
      throw new Error(
        `closure entry not in file set${includeTests ? "" : " (note: test/mock paths are excluded by default; pass includeTests to override)"}: ${entry}`,
      );
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

  // --- Declaration index over the whole visible tree -------------------------
  // Needed for inheritance-base and interface→impl resolution (upgrades 1.1 +
  // 1.2): both ask "WHERE does this symbol live?" across the repo, which
  // import-following alone cannot answer.
  const declIndex = new Map<string, DeclInfo>(); // first declaration wins; later duplicates ignored
  const fileDecls = new Map<string, Map<string, Omit<DeclInfo, "path">>>();
  for (const p of visiblePaths) {
    const decls = parseDeclarations(await read(p));
    fileDecls.set(p, decls);
    for (const [symbol, info] of decls) {
      if (!declIndex.has(symbol)) {
        declIndex.set(symbol, { ...info, path: p });
      }
    }
  }

  const included = new Map<string, Included>();
  const external = new Set<string>();
  const unresolvedEdges = new Set<string>();
  const implOf = new Map<string, string>();
  const queue: string[] = [];
  for (const entry of args.entries) {
    included.set(entry, { path: entry, role: "entry", depth: 0, bytes: 0 });
    queue.push(entry);
  }

  const enqueue = (path: string, role: ClosureFileRole, depth: number): void => {
    const existing = included.get(path);
    if (existing !== undefined) {
      // Real edges UPGRADE a lexical reverse hit; never downgrade a real edge.
      // At the same rank tier, the more specific real-edge label wins:
      // inherited/impl describe WHAT the edge is, forward only HOW it was first
      // reached. A forward-imported inheritance base is still a base.
      const newRank = rankOf(role);
      const oldRank = rankOf(existing.role);
      const moreSpecific = newRank === oldRank && role !== "forward" && existing.role === "forward";
      if (newRank < oldRank || moreSpecific) {
        existing.role = role;
        existing.depth = Math.min(existing.depth, depth);
      }
      return;
    }
    included.set(path, { path, role, depth, bytes: 0 });
    queue.push(path);
  };

  const rankOf = (role: ClosureFileRole): number =>
    keepRank({ path: "", role, depth: 0, bytes: 0 });

  const processForwardImports = async (): Promise<void> => {
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
        if (resolved !== undefined) {
          enqueue(resolved, "forward", depth + 1);
        }
      }
    }
  };
  await processForwardImports();

  // --- Inheritance + interface→impl fixpoint (upgrades 1.1 + 1.2) ------------
  // Each round inspects every included file; expansions can cascade (a base
  // pulls ITS bases, an impl references further interfaces), so iterate until
  // nothing new is included.
  const resolveInheritanceAndImpls = async (): Promise<boolean> => {
    let grew = false;
    for (const path of included.keys()) {
      const contents = await read(path);
      const decls = fileDecls.get(path) ?? parseDeclarations(contents);

      // 1.1 — full inheritance chain: pull the IMPLEMENTATION source of every
      // base (contract/library/abstract), preferring the non-interface
      // declaration when both share a name. A base is never optional.
      for (const [, info] of decls) {
        for (const base of info.bases) {
          const decl = declIndex.get(base);
          if (decl === undefined || decl.path === path) {
            continue;
          }
          // enqueue handles the role upgrade: a forward-imported base is still a
          // base → relabel "inherited". Never downgrade a real edge.
          const before = included.has(decl.path);
          enqueue(decl.path, "inherited", 1);
          if (!before) {
            grew = true;
          }
        }
      }

      // 1.2 — interface-typed references resolve to their concrete impls.
      // Imports cannot see through `ICoreEmissionsController(addr)`; only an
      // implementer lookup can.
      for (const [symbol, info] of declIndex) {
        if (info.kind !== "interface") {
          continue;
        }
        if (included.has(info.path) && !referencesSymbol(contents, symbol)) {
          continue; // interface file rides along anyway; nothing to resolve
        }
        if (!referencesSymbol(contents, symbol)) {
          continue;
        }
        // Find the concrete implementer: explicit `is <I>` first, then the
        // sole in-repo contract bearing the de-I'd name.
        let implPath: string | undefined;
        for (const [, cInfo] of declIndex) {
          if (cInfo.kind === "contract" && cInfo.bases.includes(symbol)) {
            implPath = cInfo.path;
            break;
          }
        }
        if (implPath === undefined) {
          const bare = symbol.startsWith("I") && symbol.length > 1 ? symbol.slice(1) : symbol;
          const nameMatches = [...declIndex.entries()].filter(
            ([s, d]) => s === bare && d.kind === "contract",
          );
          if (nameMatches.length === 1) {
            implPath = nameMatches[0]?.[1].path;
          }
        }
        if (implPath === undefined || implPath === path) {
          if (implPath === undefined) {
            unresolvedEdges.add(
              `${symbol}: interface-typed reference in ${path} has NO resolvable in-repo implementation`,
            );
          }
          continue;
        }
        if (!included.has(implPath)) {
          enqueue(implPath, "impl", 1);
          implOf.set(implPath, symbol);
          grew = true;
        }
      }
    }
    return grew;
  };

  let guard = 0;
  while (await resolveInheritanceAndImpls()) {
    await processForwardImports(); // new files' own imports join transitively
    guard += 1;
    if (guard > 16) {
      throw new Error("closure fixpoint did not converge — cyclic inheritance graph?");
    }
  }

  // --- Reverse pass — LAST RESORT ONLY (upgrade 1.4) --------------------------
  // Name/basename coupling against ENTRY symbols. This is the only surviving
  // heuristic include: it captures factory↔instance pairs reachable solely
  // backwards (SmartAccount.sol never imports SmartAccountFactory.sol), but it
  // must never outrank or displace a real-edge file under budget.
  const entrySymbols = new Set<string>();
  for (const entry of args.entries) {
    const contents = await read(entry);
    for (const match of contents.matchAll(SOL_DECLARATION_FULL_REGEX)) {
      const symbol = match[3];
      if (symbol !== undefined) {
        entrySymbols.add(symbol);
      }
    }
  }
  const reverseHits: string[] = [];
  if (entrySymbols.size > 0) {
    for (const p of visiblePaths) {
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
    enqueue(p, "reverse", 1_000_000);
  }
  await processForwardImports();
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
    implOf,
    externalUnresolved: [...external].toSorted(),
    unresolvedEdges: [...unresolvedEdges].toSorted(),
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
  // build-output noise is excluded. Test dirs are NOT skipped here either:
  // exclusion happens in assembleClosure (visiblePaths) so callers can opt in
  // via --include-tests; the walker stays a dumb listing.
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
