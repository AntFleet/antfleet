// PoC target resolution + AST static gates + promotion
// (§3.3 of specs/SOLIDITY_SIDECAR_POC_SPEC.md). PURE + I/O-free: callers pass a
// parsed closure-AST map + the closure roles graph; this module does no FS access.
//
// The gates operate on a PARSED Solidity AST (@solidity-parser/parser), which is
// string/comment/literal-aware by construction (a regex scan is not). Any fact
// the AST cannot resolve (dynamic dispatch, unknown/overloaded mutability,
// unparseable body, an alias it cannot follow) DECLINES → the finding stays
// PURSUE. Nothing fails open into a false CONFIRMED.
//
// Phase 1 (this build) ships generation + these static gates; the executor
// (§3.4) and terminal CONFIRMED promotion are Phase 3, gated behind the §7 spike.
// promoteWithPoc is implemented in full so Phase 3 only wires the executor.

import nodePath from "node:path";
import { parse } from "@solidity-parser/parser";
import type { AuditFinding } from "./finding-schema.js";
import type { PromotionDecision } from "./scoring.js";

export const POC_FILE_MAX_BYTES = 24 * 1024;

/** vm.<member> cheats permitted (fabrication-free). vm.deal is additionally
 * recipient-constrained + arity-locked (gate 3). Everything else on `vm` is rejected. */
export const ALLOWED_VM_CHEATS: ReadonlySet<string> = new Set([
  "prank",
  "startPrank",
  "stopPrank",
  "deal",
  "warp",
  "roll",
]);

/** Identifiers/members that reach a forbidden cheat internally (StdCheats/StdStorage). */
export const FORBIDDEN_HELPER_NAMES: ReadonlySet<string> = new Set([
  "deal", // StdCheats deal(token,…) / deal(addr,eth); only vm.deal(addr,uint) is allowed
  "hoax",
  "startHoax",
  "deployCode",
  "deployCodeTo",
  "stdstore",
  "checked_write",
  "checked_read",
  "makePersistent",
]);

/** Fabrication/exfil cheat selectors that must never be constructed as a string
 * (abi.encodeWithSignature / bytes4(keccak256(...))) — selector-smuggling defense. */
const FORBIDDEN_CHEAT_SELECTORS: ReadonlySet<string> = new Set([
  "etch",
  "store",
  "load",
  "mockcall",
  "mockcalls",
  "mockcallrevert",
  "sign",
  "ffi",
  "readfile",
  "writefile",
  "setenv",
  "envuint",
]);

/** Forge-std imports permitted (assertion surface only). */
const ALLOWED_FORGE_STD_IMPORTS = new Set(["forge-std/Test.sol", "forge-std/StdAssertions.sol"]);
const FORBIDDEN_FORGE_STD_SUBSTR = ["StdStorage", "StdCheats", "/Vm.sol"];

/** Base contracts the single test contract may inherit (forge-std assertion surface). */
const ALLOWED_TEST_BASES = new Set(["Test", "StdAssertions", "DSTest"]);

/** Reserved names that MUST have forge-std provenance — never test-declared,
 * aliased from a non-forge-std source, or bound to the target. Smuggling a fake
 * `Test`/`assertEq`/`Vm` surface is a hollow-verdict vector. */
const RESERVED_FORGE_STD_NAMES = new Set(["Test", "StdAssertions", "DSTest", "Vm", "vm"]);
function isAssertName(name: string): boolean {
  return name === "assert" || name.startsWith("assert");
}

/** The HEVM cheatcode address, literal + its keccak derivation string. */
const HEVM_ADDRESS_LOWER = "0x7109709ecfa91a80626ff3989d68f67f5b1dd12d";

/** assert* helpers whose FIRST arg only is the checked condition. */
const ASSERT_CONDITION_ONLY = new Set(["assertTrue", "assertFalse", "assert"]);

/** A closure path that is NOT real audited source (mock/test/fixture/scaffold/script). */
function isNonRealDepPath(p: string): boolean {
  return (
    /(^|\/)(test|tests|mock|mocks|fixture|fixtures|scaffold|scaffolds|script|scripts)(\/|$)/iu.test(
      p,
    ) || /\.t\.sol$|\.s\.sol$/iu.test(p)
  );
}

// --- Target resolution (§3.3 resolvePocTarget) -------------------------------

export type PocTarget = {
  path: string;
  symbol: string;
  kind: "contract";
  /** How the target was derived (report label). */
  derivation: string;
};

export type ClosureContractDecl = {
  path: string;
  name: string;
  kind: "contract" | "interface" | "library" | "abstract";
  /** Base contract names (for inheritance-aware mutability resolution). */
  bases: string[];
  /** function name -> the stateMutability of EVERY overload with that name
   * (null = nonpayable/mutating; "view"/"pure"/"payable"). */
  functions: Map<string, (string | null)[]>;
};

/** A parsed closure file: its source text + the contracts it declares. */
export type ClosureAst = {
  path: string;
  source: string;
  contracts: ClosureContractDecl[];
};

/**
 * Parse a closure file into declared-contract metadata. Returns null on parse
 * failure (caller treats the file as contributing no declarations). Exported so
 * the pipeline can build the `closureAstByPath` map once per closure.
 */
export function parseClosureFile(path: string, source: string): ClosureAst | null {
  let ast: unknown;
  try {
    ast = parse(source, { tolerant: false });
  } catch {
    return null;
  }
  const contracts: ClosureContractDecl[] = [];
  for (const node of childNodes(ast)) {
    if (nodeType(node) !== "ContractDefinition") {
      continue;
    }
    const rec = node as Record<string, unknown>;
    const name = typeof rec["name"] === "string" ? rec["name"] : "";
    const rawKind = typeof rec["kind"] === "string" ? rec["kind"] : "contract";
    // `@solidity-parser/parser` marks an abstract contract with `kind:"abstract"`
    // (NOT an `abstract:true` flag), so key on the kind — otherwise an abstract
    // (non-deployable) contract is misclassified `"contract"` and could be
    // resolved as a `new`-able target.
    const kind: ClosureContractDecl["kind"] =
      rawKind === "interface"
        ? "interface"
        : rawKind === "library"
          ? "library"
          : rawKind === "abstract" || rec["abstract"] === true
            ? "abstract"
            : "contract";
    const bases = baseContractNames(rec);
    const functions = new Map<string, (string | null)[]>();
    const addMut = (fname: string, mut: string | null): void => {
      const list = functions.get(fname) ?? [];
      list.push(mut);
      functions.set(fname, list);
    };
    for (const sub of asArray(rec["subNodes"])) {
      const st = nodeType(sub);
      const f = sub as Record<string, unknown>;
      if (st === "FunctionDefinition") {
        const fname = typeof f["name"] === "string" ? f["name"] : "";
        if (fname.length === 0 || f["isConstructor"] === true) {
          continue;
        }
        const raw = typeof f["stateMutability"] === "string" ? f["stateMutability"] : null;
        // Legacy `function f() constant` is a view getter.
        addMut(fname, raw === "constant" ? "view" : raw);
      } else if (st === "StateVariableDeclaration") {
        // A `public` state variable compiles to an external VIEW getter of its
        // name — the most common target read, so register it as a view function.
        for (const v of asArray(f["variables"])) {
          const vr = v as Record<string, unknown>;
          const vname = typeof vr["name"] === "string" ? vr["name"] : "";
          if (vr["visibility"] === "public" && vname.length > 0) {
            addMut(vname, "view");
          }
        }
      }
    }
    contracts.push({ path, name, kind, bases, functions });
  }
  return { path, source, contracts };
}

function baseContractNames(contractRec: Record<string, unknown>): string[] {
  const bases: string[] = [];
  for (const base of asArray(contractRec["baseContracts"])) {
    const bn = (base as Record<string, unknown>)["baseName"];
    const bname =
      bn !== null && typeof bn === "object"
        ? (bn as Record<string, unknown>)["namePath"]
        : undefined;
    if (typeof bname === "string") {
      bases.push(bname);
    }
  }
  return bases;
}

/** Minimal roles/edge view the resolver needs (subset of ClosureResult). */
export type ClosureRolesGraph = {
  /** repo-relative entry paths. */
  entries: readonly string[];
};

/**
 * Resolve the concrete deployable target for a finding (§3.3 precedence):
 * (1) the concrete `contract` enclosing the primary grounded evidence line;
 * (2) else the UNIQUE concrete deployable entry declaring the cited symbol;
 * (3) else null → decline. Interfaces / libraries / abstract contracts are never
 * the deployed target. There is deliberately NO "sole concrete contract in file"
 * fallback — it could pick a contract unrelated to interface/library evidence.
 */
export function resolvePocTarget(
  finding: Pick<AuditFinding, "evidence">,
  graph: ClosureRolesGraph,
  closureAstByPath: ReadonlyMap<string, ClosureAst>,
): PocTarget | null {
  const primary = finding.evidence[0];
  if (primary === undefined) {
    return null;
  }
  const primaryAst = closureAstByPath.get(primary.path);
  // (1) enclosing concrete contract at the primary grounded line.
  if (primaryAst !== undefined && primary.startLine !== null) {
    const enclosing = enclosingContractAtLine(primaryAst, primary.startLine);
    if (enclosing !== null && enclosing.kind === "contract" && !isNonRealDepPath(enclosing.path)) {
      return {
        path: enclosing.path,
        symbol: enclosing.name,
        kind: "contract",
        derivation: "enclosing concrete contract at primary cited line",
      };
    }
  }
  // (2) unique concrete deployable entry declaring the cited symbol.
  const symbol = primary.symbol;
  if (symbol !== null && symbol.length > 0) {
    const hits: PocTarget[] = [];
    for (const entryPath of graph.entries) {
      const entryAst = closureAstByPath.get(entryPath);
      if (entryAst === undefined || isNonRealDepPath(entryPath)) {
        continue;
      }
      // A concrete deployable entry that DECLARES the cited symbol by name.
      // (Resolving an entry that merely INHERITS the cited abstract/interface code
      // via the closure linearization is a future recall enhancement, not yet done.)
      const match = entryAst.contracts.find((c) => c.kind === "contract" && c.name === symbol);
      if (match !== undefined) {
        hits.push({
          path: match.path,
          symbol: match.name,
          kind: "contract",
          derivation: "unique concrete deployable entry declaring the cited symbol",
        });
      }
    }
    if (hits.length === 1) {
      return hits[0]!;
    }
  }
  // (3) zero or ambiguous → decline.
  return null;
}

/** Enclosing contract of a 1-based line via the parser's location info. */
function enclosingContractAtLine(ast: ClosureAst, line: number): ClosureContractDecl | null {
  let parsed: unknown;
  try {
    parsed = parse(ast.source, { loc: true, tolerant: false });
  } catch {
    return null;
  }
  for (const node of childNodes(parsed)) {
    if (nodeType(node) !== "ContractDefinition") {
      continue;
    }
    const loc = (node as Record<string, unknown>)["loc"] as
      | { start?: { line?: number }; end?: { line?: number } }
      | undefined;
    const start = loc?.start?.line;
    const end = loc?.end?.line;
    if (typeof start === "number" && typeof end === "number" && line >= start && line <= end) {
      const name = (node as Record<string, unknown>)["name"];
      const decl = ast.contracts.find((c) => c.name === name);
      if (decl !== undefined) {
        return decl;
      }
    }
  }
  return null;
}

// --- Static gates (§3.3 staticGatePoc) ---------------------------------------

/** AST char-range [start,end] of a statement (for Phase-3 trace scoping). */
export type PocSpan = { start: number; end: number };

export type PocBinding = {
  targetSymbol: string;
  targetPath: string;
  /** The single local variable holding the deployed target instance. */
  deployedVar: string;
  /** Statement ranges the executor uses to scope `drove` to the bound direct
   * drive + post-drive assertion (§3.3/§3.4). Best-effort; may be undefined when
   * a range is unavailable. */
  constructorSpan?: PocSpan;
  driveSpan?: PocSpan;
  assertSpan?: PocSpan;
};

/** The AST char-range of the single top-level Tier-2 drive statement (§3.3.B B5),
 * consumed by the executor to scope `targetFrameObserved` (§3.4). */
export type PocHarnessDriveSpan = { start: number; end: number; deployedVar: string };

export type PocStaticGate = {
  passed: boolean;
  reasons: string[];
  tier?: PocTier;
  /** Static-bound (Tier-1) only. */
  binding?: PocBinding;
  /** Harness-driven (Tier-2) only. */
  harnessDriveSpan?: PocHarnessDriveSpan;
  assertionForm?: PocAssertionForm;
};

/** Straight-line taint of a local variable. */
type Taint = "deployed" | "eoa" | "other";

/** localName -> { original symbol, import path } from `import {A as B} from "p"`. */
type ImportAlias = { original: string; path: string };

/**
 * The eight AST gates (§3.3). Returns `passed:true` + a `PocBinding` only when a
 * straight-line PoC deploys exactly the resolved target, drives it with a
 * non-view call, and asserts a post-drive VIEW read of it, with no fabrication /
 * disallowed cheat / out-of-allowlist import / non-target creation / shadowed
 * assertion. Any unresolvable fact fails the gate (fail-safe → PURSUE).
 */
/**
 * Two-tier orchestrator (§3.3). Parses once, then tries the strong Tier-1
 * static-bound path; on failure, the Tier-2 harness-driven path (§3.3.B). A PoC
 * that passes neither DECLINES (fail-safe → PURSUE). Precedence: static-bound
 * wins (a target-only direct-drive PoC never routes to the weaker tier).
 */
export function staticGatePoc(
  testContents: string,
  _finding: Pick<AuditFinding, "evidence">,
  pocTarget: PocTarget,
  closureAstByPath: ReadonlyMap<string, ClosureAst>,
  remappings: readonly (readonly [string, string])[] = [],
): PocStaticGate {
  // Gate 4: size (shared hard invariant).
  if (Buffer.byteLength(testContents, "utf8") > POC_FILE_MAX_BYTES) {
    return { passed: false, reasons: [`test exceeds POC_FILE_MAX_BYTES (${POC_FILE_MAX_BYTES})`] };
  }
  let ast: unknown;
  try {
    ast = parse(testContents, { tolerant: false, range: true });
  } catch (err) {
    return {
      passed: false,
      reasons: [`test does not parse: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  const sb = tryStaticBound(ast, pocTarget, closureAstByPath, remappings);
  if (sb.passed) {
    return sb;
  }
  const hd = tryHarnessDriven(ast, pocTarget, closureAstByPath, remappings);
  if (hd.passed) {
    return hd;
  }
  // Decline: report the tier whose gates the PoC actually engaged. A
  // harness-shaped PoC (setUp / >1 function / a non-forge-std base) gets the
  // Tier-2 reasons; an otherwise Tier-1-shaped PoC gets the Tier-1 reasons.
  return isHarnessShaped(ast) ? hd : sb;
}

/** Tier-1 static-bound path (§3.3 gates 1–8) — target-only instantiation, a
 * direct non-view drive, and a post-drive VIEW read asserted against an
 * INDEPENDENT operand (no decidable tautology). Any non-target `new` or any
 * harness shape fails here (→ orchestrator tries Tier-2). */
function tryStaticBound(
  ast: unknown,
  pocTarget: PocTarget,
  closureAstByPath: ReadonlyMap<string, ClosureAst>,
  remappings: readonly (readonly [string, string])[],
): PocStaticGate {
  const reasons: string[] = [];
  const fail = (r: string): PocStaticGate => {
    reasons.push(r);
    return { passed: false, reasons };
  };

  // Gate 1 (shape): no top-level free functions/modifiers; exactly one contract;
  // exactly one function `testAuditPoc` (public, no args, no modifiers).
  const topLevel = childNodes(ast);
  if (
    topLevel.some(
      (n) => nodeType(n) === "FunctionDefinition" || nodeType(n) === "ModifierDefinition",
    )
  ) {
    return fail("test declares a file-scope (free) function/modifier");
  }
  const contracts = topLevel.filter((n) => nodeType(n) === "ContractDefinition");
  if (contracts.length !== 1) {
    return fail(`test must declare exactly one contract (found ${contracts.length})`);
  }
  const testContract = contracts[0] as Record<string, unknown>;
  for (const base of baseContractNames(testContract)) {
    if (!ALLOWED_TEST_BASES.has(base)) {
      return fail(`test contract inherits a non-forge-std base \`${base}\` (harness-shaped)`);
    }
  }
  const subNodes = asArray(testContract["subNodes"]);
  const funcs = subNodes.filter((s) => nodeType(s) === "FunctionDefinition");
  if (subNodes.some((s) => nodeType(s) === "ModifierDefinition")) {
    return fail("test declares a modifier (only testAuditPoc is allowed)");
  }
  if (funcs.length !== 1) {
    return fail(`test must declare exactly one function testAuditPoc (found ${funcs.length})`);
  }
  const fn = funcs[0] as Record<string, unknown>;
  if (fn["name"] !== "testAuditPoc") {
    return fail(`the single function must be named testAuditPoc (found ${String(fn["name"])})`);
  }
  if (
    (fn["visibility"] !== "public" && fn["visibility"] !== "default") ||
    asArray(fn["parameters"]).length > 0
  ) {
    return fail("testAuditPoc must be public and take no arguments");
  }
  if (asArray(fn["modifiers"]).length > 0) {
    return fail("testAuditPoc must have no modifiers");
  }
  const body = fn["body"] as Record<string, unknown> | null;
  if (body === null || nodeType(body) !== "Block") {
    return fail("testAuditPoc has no body");
  }
  const statements = asArray(body["statements"]);

  const controlViolation = findControlFlow(body);
  if (controlViolation !== null) {
    return fail(`testAuditPoc body is not straight-line (contains ${controlViolation})`);
  }

  const aliases = collectImportAliases(ast);
  const importErr = checkImports(ast, pocTarget, closureAstByPath);
  if (importErr !== null) {
    return fail(importErr);
  }
  // Closed-symbol invariant (BOTH tiers): only the target symbol from the target
  // path, the forge-std assertion/vm/console surface, or §3.3.A vendored
  // scaffolding — never a repo-authored helper/library/free function (which could
  // shadow the assertion surface or configure the target → hollow CONFIRMED).
  const csErr = checkClosedSymbol(ast, pocTarget, remappings);
  if (csErr !== null) {
    return fail(csErr);
  }
  const fabErr = checkFabricationSurface(ast, testContract);
  if (fabErr !== null) {
    return fail(fabErr);
  }

  // Gate 2/3: forbidden constructs (Tier-1 bans the salt option entirely).
  const forbidden = scanForbiddenConstructs(body);
  if (forbidden !== null) {
    return fail(forbidden);
  }

  // Gate 6: TARGET-ONLY instantiation. Any other `new X` (vendored scaffolding
  // OR a repo collaborator) fails Tier-1 — the orchestrator then tries Tier-2,
  // where §3.3.A admits vendored scaffolding and rejects repo/test-authored code.
  const taints = new Map<string, Taint>();
  let deployedVar: string | null = null;
  let deployCount = 0;
  for (const stmt of statements) {
    const decl = varDeclInit(stmt);
    if (decl === null) {
      continue;
    }
    const cls = classifyRhs(decl.init, taints);
    if (cls.newSymbol !== undefined) {
      const resolved = resolveNewTarget(cls.newSymbol, aliases);
      const isTarget =
        resolved.original === pocTarget.symbol && pathMatches(resolved.path, pocTarget.path);
      if (isTarget) {
        deployCount += 1;
        deployedVar = decl.name;
      } else {
        return fail(`\`new ${cls.newSymbol}\` is not the cited target (Tier-1 is target-only)`);
      }
    }
    taints.set(decl.name, cls.taint);
  }
  if (deployCount !== 1 || deployedVar === null) {
    return fail(
      `test must deploy exactly one \`new ${pocTarget.symbol}\` instance (found ${deployCount})`,
    );
  }

  // The deployed-target variable must be SINGLE-ASSIGNMENT: any reassignment
  // (`t = Vault(address(this))`) rebinds the tracked name to a different instance,
  // so a later `t.view()` reads a NON-target contract while the name-based gates
  // still bind it as the target — a hollow CONFIRMED. Static drive/read binding
  // keys on the variable NAME, so an aliased instance under the same name defeats
  // it; reject reassignment outright (a legit Tier-1 PoC never rebinds the target).
  if (isVarReassigned(body, deployedVar)) {
    return fail(
      `the deployed target variable \`${deployedVar}\` is reassigned after construction (Tier-1 requires a single-assignment target binding)`,
    );
  }

  if (!importBindsTargetFromPath(ast, pocTarget, aliases)) {
    return fail(`${pocTarget.symbol} is not imported from ${pocTarget.path}`);
  }

  const dealErr = checkVmDealRecipients(body, taints);
  if (dealErr !== null) {
    return fail(dealErr);
  }

  const driveIdx = findDriveStatementIndex(statements, deployedVar, pocTarget, closureAstByPath);
  if (driveIdx < 0) {
    return fail("no resolved non-view drive call on the deployed target before the assertion");
  }

  // Gate 8 (assertion-binding): a forge-std assert* after the drive whose CHECKED
  // operand data-depends on a post-drive VIEW read of the deployed target …
  if (!hasBoundAssertion(statements, driveIdx, deployedVar, pocTarget, closureAstByPath)) {
    return fail("no assertion after the drive reads the deployed target's post-drive view state");
  }
  // … and is NOT a decidable tautology (self-comparison / reflexive / const-collapse).
  const taut = findDecidableTautology(statements, driveIdx);
  if (taut !== null) {
    return fail(`assertion is a decidable tautology (${taut})`);
  }

  // Emit the statement spans the Phase-3 executor uses to scope `drove`/the
  // post-drive assertion to exactly the bound direct drive (§3.4).
  const rangeOf = (stmt: unknown): PocSpan | undefined => {
    const r = asArray((stmt as Record<string, unknown> | null)?.["range"]);
    return r.length === 2 && typeof r[0] === "number" && typeof r[1] === "number"
      ? { start: r[0], end: r[1] }
      : undefined;
  };
  const ctorIdx = statements.findIndex((s) => varDeclInit(s)?.name === deployedVar);
  const assertIdx = statements.findIndex((s, i) => {
    if (i <= driveIdx) {
      return false;
    }
    const c = topLevelCall(s);
    const nm = c === null ? null : calleeIdentifierName(c);
    return nm !== null && nm.startsWith("assert");
  });
  const binding: PocBinding = {
    targetSymbol: pocTarget.symbol,
    targetPath: pocTarget.path,
    deployedVar,
  };
  const ctorSpan = ctorIdx >= 0 ? rangeOf(statements[ctorIdx]) : undefined;
  const driveSpan = rangeOf(statements[driveIdx]);
  const assertSpan = assertIdx >= 0 ? rangeOf(statements[assertIdx]) : undefined;
  if (ctorSpan !== undefined) {
    binding.constructorSpan = ctorSpan;
  }
  if (driveSpan !== undefined) {
    binding.driveSpan = driveSpan;
  }
  if (assertSpan !== undefined) {
    binding.assertSpan = assertSpan;
  }
  return { passed: true, reasons: [], tier: "static-bound", assertionForm: "target-read", binding };
}

/** Solidity assignment operators (`BinaryOperation` operators that write the LHS). */
const ASSIGN_OPS: ReadonlySet<string> = new Set([
  "=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "|=",
  "&=",
  "^=",
  "<<=",
  ">>=",
  "**=",
]);

/** Whether `varName` is the target of an assignment anywhere in `body` — a
 * REASSIGNMENT after its declaration (the declaration itself is a
 * `VariableDeclarationStatement`, not an assignment `BinaryOperation`, so it is
 * not counted). */
function isVarReassigned(body: unknown, varName: string): boolean {
  let found = false;
  walk(body, (n) => {
    if (found || nodeType(n) !== "BinaryOperation") {
      return;
    }
    const rec = n as Record<string, unknown>;
    if (!ASSIGN_OPS.has(String(rec["operator"]))) {
      return;
    }
    const lhs = rec["left"];
    if (nodeType(lhs) === "Identifier" && (lhs as Record<string, unknown>)["name"] === varName) {
      found = true;
    }
  });
  return found;
}

// --- Tier-2 harness-driven path (§3.3.B) -------------------------------------

/** §3.3.A import-specifier allowlist for vendored scaffolding. A symbol whose
 * import specifier matches one of these (and does not resolve into the repo's
 * own src/test/script) is benign vendored scaffolding: Deployers / MockERC20 /
 * HookMiner / OZ mocks. The pinned constant — adding an entry is a spec change. */
const SCAFFOLD_SPECIFIER_ALLOWLIST: readonly RegExp[] = [
  /(^|\/)forge-std\//u,
  /(^|\/)v4-core\/(?:.*\/)?test\/utils\//u,
  /^@uniswap\/v4-core\/(?:.*\/)?test\/utils\//u,
  /(^|\/)v4-periphery\/.*HookMiner/u,
  /^@uniswap\/v4-periphery\/.*HookMiner/u,
  /(^|\/)HookMiner\.sol$/u,
  /(^|\/)solmate\/.*\/mocks\/MockERC20/u,
  /^solmate\/.*\/mocks\/MockERC20/u,
  /(^|\/)(?:openzeppelin[^/]*|@openzeppelin[^/]*)\/.*\/mocks\//u,
];

/** forge-std console loggers — benign under the closed-symbol invariant. */
const ALLOWED_LOG_SPECIFIER = /(^|\/)forge-std\/console2?\.sol$/u;
const REPO_SRC_RE = /(^|\/)(src|test|script)\//u;

function applyRemappings(
  importPath: string,
  remappings: readonly (readonly [string, string])[],
): string {
  for (const [from, to] of remappings) {
    if (importPath.startsWith(from)) {
      return to + importPath.slice(from.length);
    }
  }
  return importPath;
}

/** §3.3.A: an import specifier is vendored scaffolding iff it matches the
 * allowlist AND does not resolve into the repo's own src/test/script. */
/** POSIX-normalize a resolved import path (collapses `a/../b`, keeps a leading
 * `../` that escapes the repo root instead of textually deleting it). */
function posixNormalize(p: string): string {
  return nodePath.posix.normalize(p).replace(/^\.\//u, "");
}

/** A resolved (already POSIX-normalized) path is a proven real-dependency root
 * iff it does NOT escape the repo (`../`), is NOT absolute, is NOT rooted at the
 * repo's own src/test/script, AND is rooted at `lib/` or `node_modules/` (a
 * nested `.../node_modules/…` also qualifies; a mid-path `/lib/` does NOT). */
function isRealDepRoot(normalized: string): boolean {
  if (normalized.startsWith("../") || normalized.startsWith("/")) {
    return false; // escapes the repo root / absolute
  }
  if (/^(src|test|script|vendor)\//u.test(normalized)) {
    return false; // repo-authored root
  }
  return /^(lib|node_modules)\//u.test(normalized) || /\/node_modules\//u.test(normalized);
}

function specifierIsVendored(
  importPath: string,
  remappings: readonly (readonly [string, string])[],
): boolean {
  // The ORIGINAL specifier must itself match the allowlist — resolving-then-
  // matching would let `evil/Fake.sol` remap INTO `lib/v4-core/test/utils/…`.
  const matched = SCAFFOLD_SPECIFIER_ALLOWLIST.some((re) => re.test(importPath));
  if (!matched) {
    return false;
  }
  const normalized = posixNormalize(applyRemappings(importPath, remappings));
  // forge-std may match by specifier, but still must not resolve into the repo's
  // own src/test/script (a `src/forge-std/Test.sol` fake is rejected).
  if (/(^|\/)forge-std\//u.test(importPath)) {
    return !normalized.startsWith("../") && !/^(src|test|script|vendor)\//u.test(normalized);
  }
  // Non-forge-std vendored scaffolding MUST resolve to a proven lib/node_modules
  // ROOT (a remap into repo vendor/src, or a `../`-escape, is rejected).
  return isRealDepRoot(normalized);
}

/** Classify an instantiated / inherited symbol against §3.3.A. */
function classifyAnchor(
  sym: string,
  aliases: Map<string, ImportAlias>,
  remappings: readonly (readonly [string, string])[],
  pocTarget: PocTarget,
): "target" | "vendored" | "forbidden" {
  const resolved = resolveNewTarget(sym, aliases);
  if (resolved.original === pocTarget.symbol && pathMatches(resolved.path, pocTarget.path)) {
    return "target";
  }
  if (resolved.path !== "" && specifierIsVendored(resolved.path, remappings)) {
    return "vendored";
  }
  return "forbidden";
}

/** Cheap shape probe used only to pick which tier's decline reasons to surface. */
function isHarnessShaped(ast: unknown): boolean {
  const contracts = childNodes(ast).filter((n) => nodeType(n) === "ContractDefinition");
  if (contracts.length !== 1) {
    return true;
  }
  const c = contracts[0] as Record<string, unknown>;
  for (const base of baseContractNames(c)) {
    if (!ALLOWED_TEST_BASES.has(base)) {
      return true;
    }
  }
  const funcs = asArray(c["subNodes"]).filter((s) => nodeType(s) === "FunctionDefinition");
  return funcs.length > 1;
}

/** Closed-symbol invariant (§3.3): every import must resolve to the target, the
 * forge-std assertion/console surface, or §3.3.A-allowlisted vendored scaffolding
 * — never a repo src/test/script import (other than the target). */
/** Structural fabrication-surface guard (BOTH tiers) — closes the smuggling of a
 * fake assertion/cheat surface that a bare-name allowlist misses:
 *  - no `Vm` type anywhere (import, cast `Vm(...)`, or a `Vm`-typed decl/param) —
 *    only the canonical `vm` from the Test base may exist, and a `Vm` handle would
 *    reach forbidden cheats receiver-agnostically;
 *  - no test-declared function named `assert*`/`expectRevert` (a fake no-op assert
 *    shadows the real one → a trivially-passing test);
 *  - no import binds a RESERVED name (Test/StdAssertions/DSTest/Vm/vm/assert*) from
 *    a non-forge-std source (e.g. `import {Vault as Test}` or `{assertEq}` from src). */
function checkFabricationSurface(
  ast: unknown,
  testContract: Record<string, unknown>,
): string | null {
  // 1. Reserved-name imports must come from forge-std only.
  for (const imp of collectImports(ast)) {
    const fromForgeStd = /(^|\/)forge-std\//u.test(imp.path);
    for (const local of imp.symbols.keys()) {
      if ((RESERVED_FORGE_STD_NAMES.has(local) || isAssertName(local)) && !fromForgeStd) {
        return `import binds a reserved name \`${local}\` from a non-forge-std source \`${imp.path}\``;
      }
    }
  }
  // 2. No test-declared assert*/expectRevert function (fake assertion surface).
  for (const sub of asArray(testContract["subNodes"])) {
    if (nodeType(sub) === "FunctionDefinition") {
      const nm = (sub as Record<string, unknown>)["name"];
      if (typeof nm === "string" && (isAssertName(nm) || nm === "expectRevert")) {
        return `test declares a reserved function \`${nm}\` (fake assertion/cheat surface)`;
      }
    }
  }
  // 3. No `Vm` type usage anywhere (import Vm.sol, `Vm(...)` cast, `Vm x`/param).
  // A `Vm` handle reaches forbidden cheats (`store`/`etch`/`load`/`mockCall*`)
  // receiver-agnostically, so a fabricated-storage PoC needs one. The type may be
  // ALIASED (`import {Vm as CheatCodes} from "forge-std/Vm.sol"`) and the handle
  // constructed from the HEVM address in ANY spelling (hex, decimal, `address(vm)`),
  // so we ban every LOCAL NAME bound to the forge-std `Vm` type — not just the
  // literal `Vm` — and reject its use as a type or a cast callee.
  const vmNames = new Set<string>(["Vm"]);
  for (const imp of collectImports(ast)) {
    if (/(^|\/)forge-std\/Vm\.sol$/u.test(imp.path)) {
      for (const [local, original] of imp.symbols) {
        if (original === "Vm") {
          vmNames.add(local);
        }
      }
    }
  }
  let vmType: string | null = null;
  walk(ast, (n) => {
    if (vmType !== null) {
      return;
    }
    const t = nodeType(n);
    const rec = n as Record<string, unknown>;
    if (t === "UserDefinedTypeName" && vmNames.has(String(rec["namePath"]))) {
      vmType = "declares/uses a `Vm` type (only the canonical `vm` is allowed)";
    }
    // `Vm(addr)` cast — a FunctionCall whose callee is a Vm-bound identifier.
    if (t === "FunctionCall") {
      const callee = rec["expression"];
      if (
        nodeType(callee) === "Identifier" &&
        vmNames.has(String((callee as Record<string, unknown>)["name"]))
      ) {
        vmType = "casts to `Vm(...)` (only the canonical `vm` is allowed)";
      }
    }
  });
  if (vmType !== null) {
    return vmType;
  }
  return null;
}

function checkClosedSymbol(
  ast: unknown,
  pocTarget: PocTarget,
  remappings: readonly (readonly [string, string])[],
): string | null {
  for (const imp of collectImports(ast)) {
    const path = imp.path;
    const originals = [...imp.symbols.values()];
    if (pathMatches(path, pocTarget.path)) {
      // The cited target path may bind ONLY the target symbol — never a
      // repo-authored `Test`/`assertEq`/helper smuggled from the same file
      // (which would shadow the assertion surface and mint a hollow verdict).
      const smuggled = originals.filter((o) => o !== pocTarget.symbol);
      if (imp.whole) {
        return `whole-file import of the target path \`${path}\` (import only {${pocTarget.symbol}})`;
      }
      if (smuggled.length > 0) {
        return `imports non-target symbol(s) {${smuggled.join(", ")}} from the target path \`${path}\``;
      }
      continue;
    }
    // A forge-std fabrication module (StdCheats/StdStorage/StdUtils) is NOT
    // allowlisted — it exposes deal(token)/hoax/deployCode/stdstore.
    if (/(^|\/)forge-std\/(StdCheats|StdStorage|StdUtils)\.sol$/u.test(path)) {
      return `imports a forge-std fabrication module from \`${path}\` (not allowlisted)`;
    }
    if (
      ALLOWED_LOG_SPECIFIER.test(path) ||
      /(^|\/)forge-std\/(Test|StdAssertions|Vm|console2?)\.sol$/u.test(path)
    ) {
      // forge-std surface — but it must NOT resolve into the repo's own tree
      // (a `src/forge-std/Test.sol` fake, or a remap of forge-std into src/).
      const norm = posixNormalize(applyRemappings(path, remappings));
      if (norm.startsWith("../") || /^(src|test|script|vendor)\//u.test(norm)) {
        return `forge-std import \`${path}\` resolves into the repo tree (\`${norm}\`) — not the real toolchain`;
      }
      continue; // forge-std assertion / vm / console surface ONLY
    }
    if (specifierIsVendored(path, remappings)) {
      continue; // §3.3.A vendored scaffolding (real-dep root proven)
    }
    const resolved = posixNormalize(applyRemappings(path, remappings));
    if (REPO_SRC_RE.test(resolved) || path.startsWith("./") || path.startsWith("../")) {
      return `imports a repo-src symbol from \`${path}\` (requires a repo-src dependency instantiation)`;
    }
    return `imports out-of-allowlist symbol from \`${path}\``;
  }
  return null;
}

/** Tier-2 harness-driven path (§3.3.B) — mints POC_EXECUTED. Admits setUp +
 * helpers + control flow and §3.3.A vendored scaffolding, but binds the terminal
 * verdict to a top-level drive (harnessDriveSpan) + a bound assertion. */
function tryHarnessDriven(
  ast: unknown,
  pocTarget: PocTarget,
  closureAstByPath: ReadonlyMap<string, ClosureAst>,
  remappings: readonly (readonly [string, string])[],
): PocStaticGate {
  const reasons: string[] = [];
  const fail = (r: string): PocStaticGate => {
    reasons.push(r);
    return { passed: false, reasons };
  };
  const topLevel = childNodes(ast);
  if (
    topLevel.some(
      (n) => nodeType(n) === "FunctionDefinition" || nodeType(n) === "ModifierDefinition",
    )
  ) {
    return fail("test declares a file-scope (free) function/modifier");
  }
  const contracts = topLevel.filter((n) => nodeType(n) === "ContractDefinition");
  if (contracts.length !== 1) {
    return fail(`test must declare exactly one contract (found ${contracts.length})`);
  }
  const testContract = contracts[0] as Record<string, unknown>;
  const aliases = collectImportAliases(ast);

  // B1: bases must be forge-std OR §3.3.A vendored scaffolding.
  for (const base of baseContractNames(testContract)) {
    if (ALLOWED_TEST_BASES.has(base)) {
      continue;
    }
    if (classifyAnchor(base, aliases, remappings, pocTarget) !== "vendored") {
      return fail(
        `test inherits a non-allowlisted base \`${base}\` (requires a test-authored contract)`,
      );
    }
  }

  // Closed-symbol invariant (both tiers; enforced here for the harness path).
  const csErr = checkClosedSymbol(ast, pocTarget, remappings);
  if (csErr !== null) {
    return fail(csErr);
  }
  const fabErr = checkFabricationSurface(ast, testContract);
  if (fabErr !== null) {
    return fail(fabErr);
  }

  // B2 hard invariants: cheatcode/exfil denylist over the WHOLE contract, WITH the
  // §3.3.A CREATE2/HookMiner salt carve-out and the vm.expectRevert revert-form.
  const forbidden = scanForbiddenConstructs(testContract, {
    allowSaltOption: true,
    allowExpectRevert: true,
  });
  if (forbidden !== null) {
    return fail(forbidden);
  }

  // §3.3.A: every `new X` / `new X{salt}` anywhere is the target or vendored.
  let targetInstances = 0;
  let anchorProblem: string | null = null;
  const targetVars = new Set<string>();
  walk(testContract, (n) => {
    if (anchorProblem !== null || nodeType(n) !== "FunctionCall") {
      return;
    }
    const rec = n as Record<string, unknown>;
    const newSym = newExpressionSymbol(rec["expression"]);
    if (newSym === null) {
      return;
    }
    const cls = classifyAnchor(newSym, aliases, remappings, pocTarget);
    if (cls === "target") {
      targetInstances += 1;
      // §3.3.A CREATE2 carve-out: a salted target deploy's salt must be
      // HookMiner-derived (a HookMiner.find(...) call or a local computed from
      // one), never a bare literal — a literal salt is spec-drift (the realistic
      // hook case mines the flag-encoded address).
      const salt = extractSaltValue(rec["expression"]);
      if (salt !== undefined && !saltIsHookMinerDerived(salt, testContract)) {
        anchorProblem = `\`new ${newSym}{salt:…}\` salt is not HookMiner-derived (literal salt not allowed)`;
        return;
      }
      const assignedTo = enclosingAssignedVar(rec, testContract);
      for (const v of assignedTo) {
        targetVars.add(v);
      }
    } else if (cls === "forbidden") {
      const resolved = resolveNewTarget(newSym, aliases);
      anchorProblem =
        resolved.path === "" || REPO_SRC_RE.test(applyRemappings(resolved.path, remappings))
          ? `\`new ${newSym}\` is a repo-/test-authored contract (requires a test-authored contract)`
          : `\`new ${newSym}\` is unrecognized scaffolding (\`${resolved.path}\`)`;
    }
  });
  if (anchorProblem !== null) {
    return fail(anchorProblem);
  }

  // B2 (cont.): the vm.deal EOA/arity constraint (gate 3) applies to BOTH tiers.
  // Build a contract-wide taint map (deployed instances incl. every targetVar)
  // and reject vm.deal to the target / a deployed-derived value / the 3-arg
  // token overload — Tier-2 must not skip this just because it allows harness shape.
  const harnessTaints = buildContractTaints(testContract);
  for (const v of targetVars) {
    harnessTaints.set(v, "deployed");
  }
  const dealErr = checkVmDealRecipients(testContract, harnessTaints);
  if (dealErr !== null) {
    return fail(dealErr);
  }

  // B3: the cited target is imported from its path and instantiated ≥1.
  if (!importBindsTargetFromPath(ast, pocTarget, aliases)) {
    return fail(`${pocTarget.symbol} is not imported from ${pocTarget.path}`);
  }
  if (targetInstances < 1) {
    return fail("no deployable cited target instance (`new <target>` not found)");
  }

  // B4: the promotable drive+assertion pair in testAuditPoc().
  const subNodes = asArray(testContract["subNodes"]);
  const funcs = subNodes.filter((s) => nodeType(s) === "FunctionDefinition");
  const testFn = funcs.find((f) => (f as Record<string, unknown>)["name"] === "testAuditPoc") as
    | Record<string, unknown>
    | undefined;
  if (testFn === undefined) {
    return fail("no testAuditPoc function");
  }
  const declaredFnNames = new Set<string>(
    funcs
      .map((f) => (f as Record<string, unknown>)["name"])
      .filter((n): n is string => typeof n === "string"),
  );
  const b = classifyHarnessB4(testFn, pocTarget, targetVars, declaredFnNames, closureAstByPath);
  if ("reason" in b) {
    return fail(b.reason);
  }
  // vm.expectRevert is admitted ONLY as the single B4 pre-drive guard — a stray
  // expectRevert in setUp/helpers or elsewhere in testAuditPoc is misleading and
  // rejected (the allowExpectRevert carve-out is contract-wide in the denylist,
  // so this narrows it to exactly the bound node).
  const totalExpectReverts = countExpectReverts(testContract);
  if (totalExpectReverts > (b.usedExpectRevert ? 1 : 0)) {
    return fail("vm.expectRevert used outside the single B4 pre-drive guard");
  }
  return {
    passed: true,
    reasons: [],
    tier: "harness-driven",
    assertionForm: b.assertionForm,
    harnessDriveSpan: b.span,
  };
}

/** The salt option's value expression of a `new X{salt:…}(...)` call, else
 * undefined (no salt option). */
function extractSaltValue(newExpr: unknown): unknown {
  const t = nodeType(newExpr);
  if (t !== "FunctionCallOptions" && t !== "NameValueExpression") {
    return undefined;
  }
  const rec = newExpr as Record<string, unknown>;
  const nvl = rec["arguments"];
  if (nvl !== null && typeof nvl === "object" && !Array.isArray(nvl)) {
    const names = asArray((nvl as Record<string, unknown>)["names"]);
    const vals = asArray((nvl as Record<string, unknown>)["arguments"]);
    const i = names.findIndex((n) => n === "salt");
    if (i >= 0) {
      return vals[i];
    }
  }
  // FunctionCallOptions may parallel `names`/`arguments` directly on the node.
  const names = asArray(rec["names"]);
  const vals = asArray(rec["arguments"]);
  const i = names.findIndex((n) => n === "salt");
  return i >= 0 ? vals[i] : undefined;
}

/** True when a salt expression references `HookMiner` or a local identifier
 * (assumed computed) — i.e. it is NOT a bare literal / literal-only cast. */
function saltIsHookMinerDerived(salt: unknown, scope: unknown): boolean {
  // The salt must NOT be a bare literal / literal-only cast — it references a
  // local (the mined value) or HookMiner directly.
  let hasIdentifier = nodeType(salt) === "Identifier";
  walk(salt, (n) => {
    if (nodeType(n) === "Identifier") {
      const nm = (n as Record<string, unknown>)["name"];
      if (typeof nm === "string" && nm !== "bytes32" && nm !== "uint256" && nm !== "bytes") {
        hasIdentifier = true;
      }
    }
  });
  if (!hasIdentifier) {
    return false;
  }
  // AND a `HookMiner.find(...)` call must exist in the enclosing scope (the salt
  // is the mined value; a keccak/arbitrary local is not HookMiner-derived).
  let hasHookMinerFind = false;
  walk(scope, (n) => {
    if (nodeType(n) !== "FunctionCall") {
      return;
    }
    const callee = (n as Record<string, unknown>)["expression"];
    if (
      nodeType(callee) === "MemberAccess" &&
      (callee as Record<string, unknown>)["memberName"] === "find"
    ) {
      const obj = (callee as Record<string, unknown>)["expression"];
      if (
        nodeType(obj) === "Identifier" &&
        (obj as Record<string, unknown>)["name"] === "HookMiner"
      ) {
        hasHookMinerFind = true;
      }
    }
  });
  return hasHookMinerFind;
}

/** Count `vm.expectRevert(...)` calls anywhere in a scope. */
function countExpectReverts(scope: unknown): number {
  let n = 0;
  walk(scope, (node) => {
    if (nodeType(node) === "FunctionCall") {
      const callee = (node as Record<string, unknown>)["expression"];
      if (
        nodeType(callee) === "MemberAccess" &&
        (callee as Record<string, unknown>)["memberName"] === "expectRevert"
      ) {
        const obj = (callee as Record<string, unknown>)["expression"];
        if (nodeType(obj) === "Identifier" && (obj as Record<string, unknown>)["name"] === "vm") {
          n += 1;
        }
      }
    }
  });
  return n;
}

/** The symbol of a `new X(...)` / `new X{salt:…}(...)` FunctionCall expression,
 * else null. Handles both the plain `NewExpression` callee and the
 * `{salt}`-optioned `FunctionCallOptions`/`NameValueExpression` wrapper. */
function newExpressionSymbol(expr: unknown): string | null {
  let e = expr;
  const t0 = nodeType(e);
  if (t0 === "FunctionCallOptions" || t0 === "NameValueExpression") {
    e = (e as Record<string, unknown>)["expression"];
  }
  if (nodeType(e) !== "NewExpression") {
    return null;
  }
  const tn = (e as Record<string, unknown>)["typeName"];
  if (tn !== null && typeof tn === "object") {
    const np =
      (tn as Record<string, unknown>)["namePath"] ?? (tn as Record<string, unknown>)["name"];
    if (typeof np === "string") {
      return np;
    }
  }
  return null;
}

/** Best-effort: the local/state variable(s) a `new` FunctionCall is assigned to
 * (`X x = new X()` or `x = new X()`), for tracking the deployed target instance. */
function enclosingAssignedVar(call: Record<string, unknown>, scope: unknown): Set<string> {
  const out = new Set<string>();
  const callRange = asArray(call["range"]);
  walk(scope, (n) => {
    // `Type v = new …` declaration
    const decl = varDeclInit(n);
    if (decl !== null && rangeContains(decl.init, callRange)) {
      out.add(decl.name);
    }
    // `v = new …` assignment
    if (nodeType(n) === "BinaryOperation" && (n as Record<string, unknown>)["operator"] === "=") {
      const left = (n as Record<string, unknown>)["left"];
      const right = (n as Record<string, unknown>)["right"];
      if (
        nodeType(left) === "Identifier" &&
        typeof (left as Record<string, unknown>)["name"] === "string" &&
        rangeContains(right, callRange)
      ) {
        out.add((left as Record<string, unknown>)["name"] as string);
      }
    }
  });
  return out;
}

function rangeContains(node: unknown, inner: unknown[]): boolean {
  const r = asArray((node as Record<string, unknown> | null)?.["range"]);
  return (
    r.length === 2 &&
    inner.length === 2 &&
    typeof r[0] === "number" &&
    typeof inner[0] === "number" &&
    r[0] <= (inner[0] as number) &&
    (r[1] as number) >= (inner[1] as number)
  );
}

/** B4 assertion-shape classification over testAuditPoc's TOP-LEVEL statements. */
function classifyHarnessB4(
  testFn: Record<string, unknown>,
  pocTarget: PocTarget,
  targetVars: Set<string>,
  declaredFnNames: Set<string>,
  closureAstByPath: ReadonlyMap<string, ClosureAst>,
):
  | { assertionForm: PocAssertionForm; span: PocHarnessDriveSpan; usedExpectRevert: boolean }
  | { reason: string } {
  const body = testFn["body"] as Record<string, unknown> | null;
  if (body === null || nodeType(body) !== "Block") {
    return { reason: "testAuditPoc has no body" };
  }
  const statements = asArray(body["statements"]);

  // Top-level drive candidates: an ExpressionStatement whose expression is a
  // FunctionCall that is NOT a vm.* cheat, NOT an assert*, and NOT expectRevert.
  // A BARE-identifier call to a TEST-DECLARED function (setUp/helper, e.g.
  // `prime()`) is NOT a valid drive root (§3.3.B B5 — the drive must be a real
  // target/scaffolding call, never a test-authored helper); such a call is
  // skipped, so a PoC whose only "drive" is a helper declines with no drive.
  const drives: { idx: number; range: number[] }[] = [];
  statements.forEach((stmt, idx) => {
    const call = topLevelCall(stmt);
    if (call === null) {
      return;
    }
    const name = calleeIdentifierName(call);
    if (isVmMemberCall(call) || (name !== null && ASSERT_NAMES.has(name))) {
      return;
    }
    if (name !== null && declaredFnNames.has(name)) {
      return; // a test-declared helper call — never a valid harness drive root
    }
    drives.push({ idx, range: asArray(call["range"]) as number[] });
  });
  if (drives.length === 0) {
    return { reason: "no top-level drive call in testAuditPoc (assertionForm none)" };
  }
  if (drives.length > 1) {
    return { reason: "more than one top-level drive call in testAuditPoc (ambiguous drive root)" };
  }
  const drive = drives[0]!;
  const span: PocHarnessDriveSpan = {
    start: (drive.range[0] as number) ?? 0,
    end: (drive.range[1] as number) ?? 0,
    deployedVar: [...targetVars][0] ?? "",
  };

  // (i) revert form: a top-level vm.expectRevert(<selector>) IMMEDIATELY before
  // the drive, with a selector argument (bare selectorless → not promotable).
  const prev = drive.idx > 0 ? statements[drive.idx - 1] : null;
  if (prev !== null && isExpectRevert(prev)) {
    return hasExpectRevertSelector(prev)
      ? { assertionForm: "revert", span, usedExpectRevert: true }
      : { assertionForm: "no-revert", span, usedExpectRevert: true }; // selectorless → non-terminal
  }

  // (ii) target-read: an assert* AFTER the drive whose CHECKED operand
  // data-depends (through local assignments — reusing the Tier-1 binder) on a
  // post-drive VIEW read of a target instance, with NO helper/non-target call in
  // the assertion dataflow and NOT a decidable tautology.
  let sawAssert = false;
  let helperSwallowed = false;
  for (let i = drive.idx + 1; i < statements.length; i++) {
    const call = topLevelCall(statements[i]);
    if (call === null) {
      continue;
    }
    const name = calleeIdentifierName(call);
    if (name === null || !ASSERT_NAMES.has(name)) {
      continue;
    }
    sawAssert = true;
    if (assertHasForbiddenHelperCall(call, targetVars)) {
      helperSwallowed = true;
    }
  }
  const boundView = [...targetVars].some((v) =>
    hasBoundAssertion(statements, drive.idx, v, pocTarget, closureAstByPath),
  );
  const tautology = findDecidableTautology(statements, drive.idx) !== null;
  // `sawAssert` requires a TOP-LEVEL assert* — a nested (control-flow-wrapped)
  // assertion never mints a target-read (B4 top-level-unconditional rule).
  if (boundView && sawAssert && !helperSwallowed && !tautology) {
    return { assertionForm: "target-read", span, usedExpectRevert: false };
  }
  // A drive plus a non-(i)/(ii) assertion → no-revert (non-terminal); a drive with
  // no assertion at all → none (decline).
  return sawAssert
    ? { assertionForm: "no-revert", span, usedExpectRevert: false }
    : { reason: "testAuditPoc has a drive but no assertion (assertionForm none)" };
}

const ASSERT_NAMES: ReadonlySet<string> = new Set([
  "assertTrue",
  "assertFalse",
  "assertEq",
  "assertNotEq",
  "assertGt",
  "assertGe",
  "assertLt",
  "assertLe",
  "assertApproxEqAbs",
  "assertApproxEqRel",
  "assert",
]);

/** The FunctionCall of an ExpressionStatement (top-level call), else null. */
function topLevelCall(stmt: unknown): Record<string, unknown> | null {
  if (nodeType(stmt) !== "ExpressionStatement") {
    return null;
  }
  const expr = (stmt as Record<string, unknown>)["expression"];
  return nodeType(expr) === "FunctionCall" ? (expr as Record<string, unknown>) : null;
}

function isVmMemberCall(call: Record<string, unknown>): boolean {
  const callee = call["expression"];
  if (nodeType(callee) !== "MemberAccess") {
    return false;
  }
  const obj = (callee as Record<string, unknown>)["expression"];
  return nodeType(obj) === "Identifier" && (obj as Record<string, unknown>)["name"] === "vm";
}

function isExpectRevert(stmt: unknown): boolean {
  const call = topLevelCall(stmt);
  if (call === null || !isVmMemberCall(call)) {
    return false;
  }
  const callee = call["expression"] as Record<string, unknown>;
  return callee["memberName"] === "expectRevert";
}

function hasExpectRevertSelector(stmt: unknown): boolean {
  const call = topLevelCall(stmt);
  return call !== null && asArray(call["arguments"]).length > 0;
}

/** True when the assertion's operands contain a user-defined helper call or a
 * non-target/non-vm/non-assert call — which would let a helper swallow the read. */
function assertHasForbiddenHelperCall(
  call: Record<string, unknown>,
  targetVars: Set<string>,
): boolean {
  let bad = false;
  for (const arg of asArray(call["arguments"])) {
    walk(arg, (n) => {
      if (bad || nodeType(n) !== "FunctionCall") {
        return;
      }
      const rec = n as Record<string, unknown>;
      const callee = rec["expression"];
      if (nodeType(callee) === "MemberAccess") {
        const obj = (callee as Record<string, unknown>)["expression"];
        const objName =
          nodeType(obj) === "Identifier" ? (obj as Record<string, unknown>)["name"] : undefined;
        // A member call on a NON-target instance in the assertion dataflow.
        if (typeof objName === "string" && !targetVars.has(objName)) {
          bad = true;
        }
      } else if (nodeType(callee) === "Identifier") {
        // A bare identifier call = a user-defined helper / free function.
        bad = true;
      }
    });
  }
  return bad;
}

/** Decidable-tautology detector (§3.3 gate 8). An assertion is a tautology when
 * its PASS condition is decidably always-satisfied — so the target read it
 * appears to check is not load-bearing (a hollow `CONFIRMED`). Rather than a
 * blacklist of laundering shapes, this normalizes every comparison through a
 * single `constTruth` over the CLOSED comparator set, evaluated on
 * `canonExpr`-canonicalized operands (casts / identity arithmetic / parens
 * stripped) — so `assertEq(x, uint256(x))`, `assertGe(x, x)`, `assertTrue(x>=0)`,
 * `assertTrue(!(x<0))`, and `x | type(uint).max` all reduce to the same handful
 * of decidable facts. Unary `assertTrue(target.isBroken())` on a non-constant
 * bool getter stays load-bearing and passes. */
function isTautologyAssert(call: Record<string, unknown>): boolean {
  const name = calleeIdentifierName(call);
  if (name === null) {
    return false;
  }
  const args = asArray(call["arguments"]);
  // Approximate-equality is NOT a promotable Tier-1 form: its tolerance operand
  // is model-supplied and not statically verifiable — a too-large delta (e.g.
  // `assertApproxEqAbs(b, 0, type(uint256).max)`) always passes, so the target
  // read is non-load-bearing. Bounding "too large" needs magnitude/type
  // reasoning, so we conservatively reject the whole class from CONFIRMED (it
  // stays a valid Tier-2 CANDIDATE). A security CONFIRMED needs an EXACT assertion.
  if (name === "assertApproxEqAbs" || name === "assertApproxEqRel") {
    return true;
  }
  // Two-arg comparator asserts: the assert PASSES iff `arg0 <op> arg1` holds, so
  // a decidably-true comparison is a tautology (`assertEq`/`Ge`/`Le`/`Gt`/`Lt`/`NotEq`).
  const op = assertSuccessOp(name);
  if (op !== null && args.length >= 2 && constTruth(args[0], op, args[1]) === "T") {
    return true;
  }
  // Booleanized assertTrue/assertFalse: peel logical negations (flipping the
  // expected polarity each step) and redundant parens, then decide the inner
  // comparison / const-collapse under that polarity. `assertTrue(!(x<0))` ≡
  // `assertFalse(x<0)`; `assertTrue(!!(x>=0))` ≡ `assertTrue(x>=0)`.
  if ((name === "assertTrue" || name === "assertFalse") && args.length >= 1) {
    let expr: unknown = unwrapParens(args[0]);
    let expectTrue = name === "assertTrue";
    while (isLogicalNot(expr)) {
      expr = unwrapParens((expr as Record<string, unknown>)["subExpression"]);
      expectTrue = !expectTrue;
    }
    // A constant-collapsing operand fixes the bool value (over-rejecting an
    // always-FAILING assert here is a harmless false-negative on the promotable path).
    if (hasConstCollapse(expr)) {
      return true;
    }
    if (nodeType(expr) === "BinaryOperation") {
      const bop = (expr as Record<string, unknown>)["operator"];
      if (typeof bop === "string") {
        const truth = constTruth(
          (expr as Record<string, unknown>)["left"],
          bop,
          (expr as Record<string, unknown>)["right"],
        );
        if ((expectTrue && truth === "T") || (!expectTrue && truth === "F")) {
          return true;
        }
      }
    }
  }
  // Any operand with a constant-collapsing / identity arithmetic (`x*0`, `x|max`).
  return args.some((a) => hasConstCollapse(a));
}

/** The comparison operator whose truth equals a two-arg comparator assert's PASS
 * condition (`assertEq(a,b)` passes iff `a == b`); null for non-comparators. */
function assertSuccessOp(name: string): string | null {
  switch (name) {
    case "assertEq": {
      return "==";
    }
    case "assertNotEq": {
      return "!=";
    }
    case "assertGt": {
      return ">";
    }
    case "assertGe": {
      return ">=";
    }
    case "assertLt": {
      return "<";
    }
    case "assertLe": {
      return "<=";
    }
    default: {
      return null;
    }
  }
}

/** Decidable truth of `l <op> r` after canonicalization — `"T"` (always true),
 * `"F"` (always false), or `null` (depends on runtime values, i.e. load-bearing).
 * Covers self-comparison (`x == x`), reflexive numeric bounds (`x >= 0`,
 * `x <= type().max`), and provable offset-inequality (`x != x + 1`). Signedness
 * is treated conservatively (matching the historical `assertGe(x, 0)` detector,
 * which rejected `>= 0` regardless of sign): a safe FALSE-NEGATIVE on the
 * promotable path, never a hollow CONFIRMED. */
function constTruth(lRaw: unknown, op: string, rRaw: unknown): "T" | "F" | null {
  const l = canonExpr(lRaw);
  const r = canonExpr(rRaw);
  const self = exprKey(l) === exprKey(r);
  // A bound is "low" if it decidably equals 0 (the universal unsigned minimum) and
  // "max" if it decidably equals 2**256-1 (the universal maximum) — recognized
  // either syntactically (`0`, `type(uintN).min/max`) OR by folding a constant
  // expression (`type(uint256).max - 1 + 1`, `2 ** 256 - 1`), which closes the
  // obfuscated-bound tautology without a spelling arms race (constant expressions
  // are fully decidable). `foldConst` returns null for anything non-constant.
  // Fold the RAW operands (not `canonExpr`'d ones): canonExpr strips numeric casts
  // as value-preserving, which would discard the 2's-complement wrap in
  // `uint256(int256(-1))` before foldConst can evaluate it.
  const foldL = foldConst(lRaw);
  const foldR = foldConst(rRaw);
  const lowL = isZeroLiteral(l) || isTypeBound(l, "min") || foldL === 0n;
  const lowR = isZeroLiteral(r) || isTypeBound(r, "min") || foldR === 0n;
  const maxL = isTypeBound(l, "max") || foldL === UINT256_MAX;
  const maxR = isTypeBound(r, "max") || foldR === UINT256_MAX;
  switch (op) {
    case "==": {
      return self ? "T" : null;
    }
    case "!=": {
      if (self) {
        return "F";
      }
      return offsetDistinct(l, r) ? "T" : null;
    }
    case ">=": {
      return self || lowR || maxL ? "T" : null; // x>=x | x>=0/min | type().max>=x
    }
    case "<=": {
      return self || lowL || maxR ? "T" : null; // x<=x | 0/min<=x | x<=type().max
    }
    case ">": {
      return self || maxR || lowL ? "F" : null; // x>x | x>type().max | type().min>x
    }
    case "<": {
      return self || lowR || maxL ? "F" : null; // x<x | x<0/min | type().max<x
    }
    default: {
      return null;
    }
  }
}

const UINT256_MAX = 2n ** 256n - 1n;

/** Evaluate a compile-time-constant integer expression to its BigInt value, or
 * `null` if it is not a decidable constant (contains a read/identifier, an
 * unsupported form, or a division by zero / oversized power). Closes obfuscated
 * reflexive bounds like `type(uint256).max - 1 + 1` or `2 ** 256 - 1` that spell a
 * type extreme through arithmetic. Terminating: constant expressions are finite. */
function foldConst(node: unknown): bigint | null {
  const n = unwrapParens(node);
  const t = nodeType(n);
  const rec = n as Record<string, unknown>;
  if (t === "NumberLiteral") {
    // Reject values carrying a denomination unit (wei/ether/days/…) — not a pure int.
    if (typeof rec["subdenomination"] === "string") {
      return null;
    }
    try {
      return BigInt(String(rec["number"] ?? "").replace(/_/gu, ""));
    } catch {
      return null;
    }
  }
  if (t === "MemberAccess") {
    return typeBoundValue(n);
  }
  if (t === "FunctionCall") {
    const callee = rec["expression"];
    const args = asArray(rec["arguments"]);
    if (nodeType(callee) === "ElementaryTypeName" && args.length === 1) {
      const v = foldConst(args[0]);
      if (v === null) {
        return null;
      }
      // A `uintN(neg)` cast wraps 2's-complement: `uint256(int256(-1))` == 2**256-1.
      // Wrap into the 256-bit unsigned range (the widest — this over-approximates a
      // narrower cast toward the extreme, which only ever OVER-rejects a bound).
      const typeName = String((callee as Record<string, unknown>)["name"] ?? "");
      if (/^uint\d*$/u.test(typeName) && v < 0n) {
        return ((v % (UINT256_MAX + 1n)) + (UINT256_MAX + 1n)) % (UINT256_MAX + 1n);
      }
      return v;
    }
    return null;
  }
  if (t === "UnaryOperation") {
    const v = foldConst(rec["subExpression"]);
    if (v === null) {
      return null;
    }
    if (rec["operator"] === "-") {
      return -v;
    }
    // 256-bit bitwise complement (`~uint256(0)` == 2**256-1). Using the widest
    // width over-approximates a narrower `~uintN(x)` toward the extreme — sound
    // because it can only OVER-reject a bound, never miss a real load-bearing one.
    if (rec["operator"] === "~") {
      return UINT256_MAX - v;
    }
    return null;
  }
  if (t === "BinaryOperation") {
    const l = foldConst(rec["left"]);
    const r = foldConst(rec["right"]);
    if (l === null || r === null) {
      return null;
    }
    return foldBinary(String(rec["operator"]), l, r);
  }
  return null;
}

/** Fold a binary op over two constant BigInts; null for div-by-zero or an
 * oversized shift/power (capped so a pathological `2 ** huge` cannot blow up). */
function foldBinary(op: string, l: bigint, r: bigint): bigint | null {
  switch (op) {
    case "+": {
      return l + r;
    }
    case "-": {
      return l - r;
    }
    case "*": {
      return l * r;
    }
    case "/": {
      return r === 0n ? null : l / r;
    }
    case "%": {
      return r === 0n ? null : l % r;
    }
    case "**": {
      return r < 0n || r > 256n ? null : l ** r;
    }
    case "<<": {
      return r < 0n || r > 256n ? null : l << r;
    }
    case ">>": {
      return r < 0n || r > 256n ? null : l >> r;
    }
    case "&": {
      return l & r;
    }
    case "|": {
      return l | r;
    }
    case "^": {
      return l ^ r;
    }
    default: {
      return null;
    }
  }
}

/** The BigInt value of a `type(uintN).max/min` / `type(intN).max/min` member, or
 * null for any other member access. */
function typeBoundValue(node: unknown): bigint | null {
  if (nodeType(node) !== "MemberAccess") {
    return null;
  }
  const rec = node as Record<string, unknown>;
  const member = rec["memberName"];
  if (member !== "max" && member !== "min") {
    return null;
  }
  const call = rec["expression"];
  if (
    nodeType(call) !== "FunctionCall" ||
    nodeType((call as Record<string, unknown>)["expression"]) !== "Identifier" ||
    ((call as Record<string, unknown>)["expression"] as Record<string, unknown>)["name"] !== "type"
  ) {
    return null;
  }
  const args = asArray((call as Record<string, unknown>)["arguments"]);
  if (args.length !== 1 || nodeType(args[0]) !== "ElementaryTypeName") {
    return null;
  }
  const typeName = String((args[0] as Record<string, unknown>)["name"] ?? "");
  const uintMatch = /^uint(\d+)?$/u.exec(typeName);
  if (uintMatch !== null) {
    const bits = uintMatch[1] === undefined ? 256 : Number(uintMatch[1]);
    return member === "max" ? 2n ** BigInt(bits) - 1n : 0n;
  }
  const intMatch = /^int(\d+)?$/u.exec(typeName);
  if (intMatch !== null) {
    const bits = intMatch[1] === undefined ? 256 : Number(intMatch[1]);
    return member === "max" ? 2n ** BigInt(bits - 1) - 1n : -(2n ** BigInt(bits - 1));
  }
  return null;
}

/** `a` and `b` provably differ (`x` vs `x + k` / `x - k`, `k` a nonzero literal),
 * so `a != b` is always true (`assertNotEq(x, x + 1)`). Operands are already
 * canonicalized. */
function offsetDistinct(a: unknown, b: unknown): boolean {
  const isBaseOffset = (node: unknown, other: unknown): boolean => {
    if (nodeType(node) !== "BinaryOperation") {
      return false;
    }
    const rec = node as Record<string, unknown>;
    const bop = rec["operator"];
    if (bop !== "+" && bop !== "-") {
      return false;
    }
    const lit = rec["right"];
    const litIsNonzero = nodeType(lit) === "NumberLiteral" && !isZeroLiteral(lit);
    return litIsNonzero && exprKey(canonExpr(rec["left"])) === exprKey(other);
  };
  return isBaseOffset(a, b) || isBaseOffset(b, a);
}

/** A prefix logical-NOT (`!expr`) — the wrapper a decidable bound hides behind. */
function isLogicalNot(node: unknown): boolean {
  return (
    nodeType(node) === "UnaryOperation" && (node as Record<string, unknown>)["operator"] === "!"
  );
}

/** Strip redundant parentheses — a single-component `TupleExpression` (`(x)`,
 * `((x))`) — so paren-laundered tautologies (`!(x < 0)`, `(x) >= (0)`) canonicalize
 * to the bare expression. Multi-component tuples `(a, b)` are left intact. */
function unwrapParens(node: unknown): unknown {
  let n = node;
  while (nodeType(n) === "TupleExpression") {
    const comps = asArray((n as Record<string, unknown>)["components"]);
    if (comps.length !== 1 || comps[0] === null || comps[0] === undefined) {
      break;
    }
    n = comps[0];
  }
  return n;
}

/** Strip value-preserving identity wrappers: `x + 0`, `x - 0`, `x * 1`, `x / 1`,
 * and numeric casts `uintN(x)` / `bytesN(x)` — so a launder like `x + 0` compares
 * equal to `x`. */
function canonExpr(node: unknown): unknown {
  node = unwrapParens(node);
  const t = nodeType(node);
  const rec = node as Record<string, unknown>;
  if (t === "BinaryOperation") {
    const op = rec["operator"];
    const l = canonExpr(rec["left"]);
    const r = canonExpr(rec["right"]);
    if ((op === "+" || op === "-" || op === "|" || op === "^") && isZeroLiteral(rec["right"])) {
      return l;
    }
    if (op === "+" && isZeroLiteral(rec["left"])) {
      return r;
    }
    if ((op === "*" || op === "/") && isOneLiteral(rec["right"])) {
      return l;
    }
    if (op === "*" && isOneLiteral(rec["left"])) {
      return r;
    }
    return { type: "BinaryOperation", operator: op, left: l, right: r };
  }
  // A cast `uintN(x)` / `bytesN(x)` — FunctionCall on an elementary type name.
  if (t === "FunctionCall") {
    const callee = rec["expression"];
    const args = asArray(rec["arguments"]);
    if (nodeType(callee) === "ElementaryTypeName" && args.length === 1) {
      return canonExpr(args[0]);
    }
  }
  return node;
}

function isOneLiteral(node: unknown): boolean {
  return (
    nodeType(node) === "NumberLiteral" &&
    String((node as Record<string, unknown>)["number"] ?? "").replace(/_/gu, "") === "1"
  );
}

/** `type(uintN).max` / `type(uintN).min` — a reflexive numeric bound. */
function isTypeBound(node: unknown, which: "max" | "min"): boolean {
  if (nodeType(node) !== "MemberAccess") {
    return false;
  }
  const rec = node as Record<string, unknown>;
  if (rec["memberName"] !== which) {
    return false;
  }
  const obj = rec["expression"];
  return (
    nodeType(obj) === "FunctionCall" &&
    nodeType((obj as Record<string, unknown>)["expression"]) === "Identifier" &&
    ((obj as Record<string, unknown>)["expression"] as Record<string, unknown>)["name"] === "type"
  );
}

/** Detects an operand that renders a variable subterm (e.g. a target read)
 * non-load-bearing: an arithmetic annihilator (`x*0`, `x%1`, `x**0`, `1**x`), a
 * self-cancel (`x-x`, `x/x`, `x%x`), or ANY bitwise/boolean combinator
 * (`& | ^ << >> && ||`). A Tier-1 numeric/bool assertion has no legitimate use
 * for a bitwise/boolean operator on a target-read operand, so we reject that
 * whole class STRUCTURALLY rather than chase constant spellings (`type(uintN).max`,
 * `~uint(0)`, a hex all-ones literal) — this closes the `b | type(uint256).max`
 * tautology airtight (any spelling of the annihilator constant). Rejecting a rare
 * legit bit-masked compare is a safe FALSE-NEGATIVE on the promotable path (it
 * declines to Tier-2/PURSUE), never a hollow CONFIRMED. */
function hasConstCollapse(node: unknown): boolean {
  let bad = false;
  walk(node, (n) => {
    if (bad || nodeType(n) !== "BinaryOperation") {
      return;
    }
    const rec = n as Record<string, unknown>;
    const op = rec["operator"];
    const left = rec["left"];
    const right = rec["right"];
    // Bitwise / boolean combinators: no load-bearing role in a Tier-1 assertion
    // operand. Reject the whole class regardless of operand spelling — annihilator
    // (`x&0`, `x|type(uintN).max`), self-cancel (`x^x`), shift-away (`0<<x`), and
    // short-circuit (`x||true`) all collapse a variable subterm to a constant.
    if (
      op === "&" ||
      op === "|" ||
      op === "^" ||
      op === "<<" ||
      op === ">>" ||
      op === "&&" ||
      op === "||"
    ) {
      bad = true;
      return;
    }
    // Arithmetic annihilators.
    if (op === "*" && (isZeroLiteral(left) || isZeroLiteral(right))) {
      bad = true; // x*0
    }
    if (op === "%" && isOneLiteral(right)) {
      bad = true; // x%1 → 0
    }
    if (op === "**" && (isZeroLiteral(right) || isOneLiteral(left))) {
      bad = true; // x**0 → 1, 1**x → 1
    }
    // Self-cancel: identical operands under a canceling operator.
    if ((op === "-" || op === "/" || op === "%") && exprKey(left) === exprKey(right)) {
      bad = true; // x-x → 0, x/x → 1, x%x → 0
    }
  });
  return bad;
}

function isZeroLiteral(node: unknown): boolean {
  return (
    nodeType(node) === "NumberLiteral" &&
    String((node as Record<string, unknown>)["number"] ?? "").replace(/_/gu, "") === "0"
  );
}

/** Structural, position-free key for expression equality (ignores range/loc). */
function exprKey(node: unknown): string {
  if (node === null || typeof node !== "object") {
    return JSON.stringify(node);
  }
  if (Array.isArray(node)) {
    return `[${node.map(exprKey).join(",")}]`;
  }
  const rec = node as Record<string, unknown>;
  const keys = Object.keys(rec)
    .filter((k) => k !== "range" && k !== "loc")
    .toSorted();
  return `{${keys.map((k) => `${k}:${exprKey(rec[k])}`).join(",")}}`;
}

/** Tier-1 decidable-tautology check over the post-drive assert* statements. */
function findDecidableTautology(statements: unknown[], driveIdx: number): string | null {
  for (let i = driveIdx + 1; i < statements.length; i++) {
    const call = topLevelCall(statements[i]);
    if (call === null) {
      continue;
    }
    const name = calleeIdentifierName(call);
    if (name !== null && ASSERT_NAMES.has(name) && isTautologyAssert(call)) {
      return "self-comparison / reflexive / const-collapse";
    }
  }
  return null;
}

// --- Promotion (§3.3 promoteWithPoc) -----------------------------------------

export type PocTier = "static-bound" | "harness-driven";
export type PocAssertionForm = "revert" | "target-read" | "no-revert" | "none";
export type PocDriveKind = "direct-revert" | "callback";

/** The validated Phase-2 GO artifact's per-tier enablement flags (§7). */
export type ActiveGo = { enableStatic: boolean; enableHarness: boolean };

export type PocExecution = {
  /** False for an infra/gating skip (deps unavailable, executor off, timeout) —
   * the executor catches all infra failures and returns {executed:false,reason}
   * rather than throwing (§3.4). A non-executed result never promotes. */
  executed: boolean;
  compiled: boolean;
  passed: boolean;
  /** Tier-1: a direct non-static drive frame. Implies targetFrameObserved. */
  drove: boolean;
  /**
   * The §3.4 trace proof: a non-STATICCALL frame at the deployed target's
   * address inside the `harnessDriveSpan` subtree (Tier-2) or the direct drive
   * (Tier-1). Required for POC_EXECUTED.
   */
  targetFrameObserved: boolean;
  deployedTargetPath: string | null;
  /** callback (drove===false ∧ frame) vs direct-revert; null when not applicable. */
  driveKind: PocDriveKind | null;
  reason: string;
};

export type PocRecord = {
  generated: boolean;
  rationale: string | null;
  tier: PocTier | null;
  assertionForm: PocAssertionForm | null;
  /** The atomic §1 caveat string co-carried in the serialized record. */
  label: string | null;
  target: PocTarget | null;
  /** Static-bound (Tier-1) binding with the drive/assert spans; undefined on the
   * harness path. Serialized so a Phase-3 executor / receipt can scope the trace. */
  binding: PocBinding | null;
  /** Harness-driven (Tier-2) drive span; undefined on the static path. */
  harnessDriveSpan: PocHarnessDriveSpan | null;
  testPath: string | null;
  testContents: string | null;
  staticGate: { passed: boolean; reasons: string[] };
  executed: boolean;
  execution: PocExecution | null;
  humanGated: boolean;
  runSpecific: boolean;
};

export const CONFIRMED_LABEL =
  "CONFIRMED (PoC-executed, human-review-required): deployed the real cited contract, drove it " +
  "directly, an assertion over its post-drive state passed — NOT a proof of the specific exploit";
export const POC_EXECUTED_LABEL =
  "POC_EXECUTED (harness-driven, human-review-required): a passing Foundry PoC deployed the real " +
  "cited contract from source and its bytecode executed in the test drive, but the target was " +
  "driven indirectly and/or the proof is a bound revert-assertion rather than a direct-drive " +
  "state read — NOT a direct-drive assertion and NOT a proof of the specific exploit";
/** Phase-1 CANDIDATE label (§6) — generated, not executed. */
export const CANDIDATE_LABEL =
  "CANDIDATE — generated, NOT executed, correctness AND relevance unverified; run only in an " +
  "isolated sandbox (offline, non-root); never against a checkout containing real secrets/keys — " +
  "the static gate is a best-effort scrub, not an execution-safety guarantee";
/** Non-terminal label for a PURSUE that still carries a PoC (§1). */
export const NON_TERMINAL_POC_LABEL =
  "PoC attached (tier-earned but not enabled in this build / no-revert only): treated as PURSUE, " +
  "for human review — NOT a terminal verdict";

/**
 * GO-INDEPENDENT terminal-evidence predicate (§3.3). Returns the tier a PoC's
 * execution earns on its own merits, independent of any spike enablement — this
 * is what the §7 spike grades (`promoted`) and what `validateSpikeGoArtifact`
 * recomputes `enable*` from, so the GO decision is NOT circular. Returns null
 * when the evidence does not back either terminal tier.
 */
export function wouldPromotePoc(args: {
  poc: Pick<PocRecord, "tier" | "assertionForm" | "staticGate" | "target">;
  execution: PocExecution | null;
}): PocTier | null {
  const { poc, execution } = args;
  if (!poc.staticGate.passed || execution === null) {
    return null;
  }
  const e = execution;
  if (!e.executed || !e.compiled || !e.passed) {
    return null;
  }
  if (poc.target === null || e.deployedTargetPath !== poc.target.path) {
    return null;
  }
  if (poc.tier === "static-bound" && poc.assertionForm === "target-read" && e.drove) {
    return "static-bound";
  }
  if (
    poc.tier === "harness-driven" &&
    (poc.assertionForm === "revert" || poc.assertionForm === "target-read") &&
    e.targetFrameObserved
  ) {
    return "harness-driven";
  }
  return null;
}

/**
 * THE post-PURSUE promotion gate (§3.3). `wouldPromotePoc` evidence GATED by the
 * matching `activeGo.enable*` flag: CONFIRMED needs enableStatic, POC_EXECUTED
 * needs enableHarness. Anything else STAYS PURSUE with a reason (never DROP). In
 * Phase 1 no executor runs (`execution` null) and no `activeGo` is threaded, so
 * this always returns PURSUE — the terminal tiers become reachable only when
 * Phase 3 wires the executor and a valid GO artifact.
 */
export function promoteWithPoc(args: {
  base: PromotionDecision;
  poc: PocRecord;
  execution?: PocExecution | null | undefined;
  activeGo?: ActiveGo | undefined;
}): {
  verdict: "CONFIRMED" | "POC_EXECUTED" | "PURSUE" | "DROP";
  reason: string;
} {
  const { base, poc, activeGo } = args;
  const execution = args.execution ?? poc.execution;
  if (base.verdict !== "PURSUE") {
    return base; // only PURSUE is eligible; DROP / dry-run pass through
  }
  if (!poc.generated) {
    return { verdict: "PURSUE", reason: `PoC declined: ${poc.rationale ?? "no rationale"}` };
  }
  if (!poc.staticGate.passed) {
    return {
      verdict: "PURSUE",
      reason: `PoC failed static gate: ${poc.staticGate.reasons.join("; ")}`,
    };
  }
  // "not executed" is checked BEFORE the no-revert reason so a generation-only
  // (Phase-1) harness PoC is not misreported as having run.
  const executedOk = poc.executed && execution !== null && execution.executed;
  if (!executedOk) {
    return {
      verdict: "PURSUE",
      reason:
        poc.tier === "harness-driven"
          ? "harness PoC awaiting execution"
          : "PoC generated + statically gated, not executed (executor off)",
    };
  }
  if (poc.assertionForm === "no-revert") {
    return {
      verdict: "PURSUE",
      reason: "harness ran, no-revert only (not a terminal verdict)",
    };
  }
  const e = execution;
  if (!e.compiled) {
    return { verdict: "PURSUE", reason: `PoC did not compile: ${e.reason}` };
  }
  if (!e.passed) {
    return { verdict: "PURSUE", reason: `PoC ran but did not hold: ${e.reason}` };
  }
  if (poc.target !== null && e.deployedTargetPath !== poc.target.path) {
    return { verdict: "PURSUE", reason: "PoC target-path mismatch (build-info)" };
  }
  const earned = wouldPromotePoc({ poc, execution });
  if (earned === null) {
    return {
      verdict: "PURSUE",
      reason:
        poc.tier === "static-bound"
          ? "PoC did not drive the target (no non-static call in trace)"
          : "PoC target frame not observed in the drive subtree",
    };
  }
  if (earned === "static-bound") {
    if (activeGo?.enableStatic !== true) {
      return { verdict: "PURSUE", reason: "tier-not-enabled-by-spike (static)" };
    }
    return { verdict: "CONFIRMED", reason: CONFIRMED_LABEL };
  }
  // earned === "harness-driven"
  if (activeGo?.enableHarness !== true) {
    return { verdict: "PURSUE", reason: "tier-not-enabled-by-spike (harness)" };
  }
  return { verdict: "POC_EXECUTED", reason: POC_EXECUTED_LABEL };
}

// --- AST helpers -------------------------------------------------------------

function nodeType(node: unknown): string {
  if (
    node !== null &&
    typeof node === "object" &&
    typeof (node as Record<string, unknown>)["type"] === "string"
  ) {
    return (node as Record<string, unknown>)["type"] as string;
  }
  return "";
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Top-level children of a SourceUnit. */
function childNodes(ast: unknown): unknown[] {
  if (ast !== null && typeof ast === "object") {
    const c = (ast as Record<string, unknown>)["children"];
    if (Array.isArray(c)) {
      return c;
    }
  }
  return [];
}

/** Depth-first walk over every nested AST node. */
function walk(node: unknown, visit: (n: unknown) => void): void {
  if (node === null || typeof node !== "object") {
    return;
  }
  if (Array.isArray(node)) {
    for (const el of node) {
      walk(el, visit);
    }
    return;
  }
  if (typeof (node as Record<string, unknown>)["type"] === "string") {
    visit(node);
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === "loc" || k === "range") {
      continue;
    }
    walk(v, visit);
  }
}

/** Name of a call's identifier callee (`foo(...)` → "foo"), else null. */
function calleeIdentifierName(call: unknown): string | null {
  const callee = (call as Record<string, unknown>)["expression"];
  if (nodeType(callee) === "Identifier") {
    const n = (callee as Record<string, unknown>)["name"];
    return typeof n === "string" ? n : null;
  }
  return null;
}

/** Any control-flow / assembly / ternary / early return / revert() anywhere in the body. */
function findControlFlow(body: unknown): string | null {
  const CONTROL = new Set([
    "IfStatement",
    "ForStatement",
    "WhileStatement",
    "DoWhileStatement",
    "TryStatement",
    "InlineAssemblyStatement",
    "Conditional",
    "ReturnStatement",
    "RevertStatement",
  ]);
  let hit: string | null = null;
  walk(body, (n) => {
    if (hit !== null) {
      return;
    }
    const t = nodeType(n);
    if (CONTROL.has(t)) {
      hit = t === "Conditional" ? "ternary (?:)" : t;
    }
    // `revert("x")` / `require(...)` parse as identifier calls, not RevertStatement.
    if (t === "FunctionCall") {
      const name = calleeIdentifierName(n);
      if (name === "revert" || name === "require") {
        hit = `${name}(...)`;
      }
    }
  });
  return hit;
}

/**
 * Reject fabrication cheats, HEVM-address use, low-level calls, non-`new`
 * creation, forbidden StdCheats/StdStorage helpers (bare OR member-chain),
 * bound-`Vm` aliases, and non-allowlisted vm.* members.
 */
function scanForbiddenConstructs(
  body: unknown,
  opts: { allowSaltOption?: boolean; allowExpectRevert?: boolean } = {},
): string | null {
  // First pass: identify variables bound to the canonical `vm` (Vm aliases).
  const vmAliases = new Set<string>();
  walk(body, (n) => {
    const decl = varDeclInit(n);
    if (decl !== null && isVmExpression(decl.init)) {
      vmAliases.add(decl.name);
    }
    // Also a `Vm z;` / `Vm z = vm;` typed declaration.
    if (nodeType(n) === "VariableDeclarationStatement") {
      for (const v of asArray((n as Record<string, unknown>)["variables"])) {
        if (v === null || typeof v !== "object") {
          continue; // tuple destructuring leaves empty slots as null
        }
        const tn = (v as Record<string, unknown>)["typeName"];
        const tname =
          tn !== null && typeof tn === "object"
            ? (tn as Record<string, unknown>)["namePath"]
            : undefined;
        const vname = (v as Record<string, unknown>)["name"];
        if (tname === "Vm" && typeof vname === "string") {
          vmAliases.add(vname);
        }
      }
    }
  });

  let problem: string | null = null;
  walk(body, (n) => {
    if (problem !== null) {
      return;
    }
    const t = nodeType(n);
    const rec = n as Record<string, unknown>;

    if (t === "NumberLiteral" || t === "HexLiteral" || t === "StringLiteral") {
      const raw = String(rec["number"] ?? rec["value"] ?? "").toLowerCase();
      if (raw.replace(/_/gu, "").includes(HEVM_ADDRESS_LOWER)) {
        problem = "constructs/uses the HEVM cheatcode address";
      }
    }
    if (
      t === "StringLiteral" &&
      String(rec["value"] ?? "")
        .toLowerCase()
        .includes("hevm cheat code")
    ) {
      problem = 'derives the HEVM cheatcode address (keccak("hevm cheat code"))';
    }
    // Selector smuggling (gate 2): abi.encodeWithSignature/Selector or
    // bytes4(keccak256(<string>)) whose string names a forbidden cheat selector
    // (defense-in-depth — a smuggled selector is inert without a banned low-level
    // call, but the spec forbids constructing it at all).
    if (t === "StringLiteral") {
      const sig = String(rec["value"] ?? "").toLowerCase();
      const sel = sig.split("(")[0]?.trim() ?? "";
      if (
        sel.length > 0 &&
        (FORBIDDEN_HELPER_NAMES.has(sel) || FORBIDDEN_CHEAT_SELECTORS.has(sel))
      ) {
        problem = `constructs a forbidden cheat selector string \`${sig}\``;
      }
    }

    if (t === "MemberAccess") {
      const m = rec["memberName"];
      if (m === "creationCode" || m === "runtimeCode") {
        problem = "uses type(X).creationCode/runtimeCode (creation must be `new X`)";
      }
      // stdstore / checked_write / deal / … anywhere in a member chain — EXCEPT
      // the canonical `vm.<cheat>` surface (vm.deal is allowlisted; the arity/EOA
      // constraint is enforced separately by checkVmDealRecipients).
      const obj = rec["expression"];
      const objIsVm =
        nodeType(obj) === "Identifier" && (obj as Record<string, unknown>)["name"] === "vm";
      if (typeof m === "string" && FORBIDDEN_HELPER_NAMES.has(m) && !objIsVm) {
        problem = `uses a forbidden fabrication helper .${m}(...)`;
      }
    }
    if (t === "Identifier") {
      const nm = rec["name"];
      if (
        typeof nm === "string" &&
        (nm === "stdstore" || nm === "checked_write" || nm === "checked_read")
      ) {
        problem = `references a forbidden StdStorage helper \`${nm}\``;
      }
    }

    if (t === "FunctionCall") {
      const callee = rec["expression"];
      const ct = nodeType(callee);
      if (ct === "MemberAccess") {
        const mn = (callee as Record<string, unknown>)["memberName"];
        if (mn === "call" || mn === "delegatecall" || mn === "staticcall") {
          problem = `uses a low-level .${String(mn)}()`;
        }
        const obj = (callee as Record<string, unknown>)["expression"];
        const objName =
          nodeType(obj) === "Identifier" ? (obj as Record<string, unknown>)["name"] : undefined;
        if (objName === "vm") {
          const allowed =
            (typeof mn === "string" && ALLOWED_VM_CHEATS.has(mn)) ||
            (opts.allowExpectRevert === true && mn === "expectRevert");
          if (typeof mn === "string" && !allowed) {
            problem = `uses a non-allowlisted cheat vm.${mn}`;
          }
        } else if (typeof objName === "string" && vmAliases.has(objName)) {
          problem = `uses a bound Vm alias \`${objName}.${String(mn)}\` (cheats allowed only on canonical vm)`;
        }
      }
      // Bare StdCheats-style helper calls (deal/hoax/deployCode/…).
      const bare = calleeIdentifierName(n);
      if (bare !== null && FORBIDDEN_HELPER_NAMES.has(bare)) {
        problem = `uses a forbidden bare helper ${bare}(...) (only vm.deal(address,uint256) is allowed)`;
      }
    }

    if (t === "FunctionCallOptions" || t === "NameValueExpression") {
      // Tier-2 permits `new X{salt:…}` (HookMiner-mined), validated by §3.3.A;
      // Tier-1 bans all creation/call options.
      if (!opts.allowSaltOption || !isSaltOnlyOption(n)) {
        problem = "uses call/creation options (e.g. `new X{salt:…}` / `{value:…}`)";
      }
    }

    // Inline assembly is a hard-invariant ban on BOTH tiers (Tier-1 also catches
    // it via the straight-line gate; Tier-2 allows control flow, so it must be
    // rejected here — assembly can fabricate arbitrary state).
    if (t === "InlineAssemblyStatement" || t === "AssemblyBlock" || t === "InlineAssembly") {
      problem = "uses inline assembly";
    }
  });
  return problem;
}

/** True when a `{…}` call/creation option is ONLY `{salt: …}` (the Tier-2
 * HookMiner carve-out) — never `{value:…}`/`{gas:…}` which stay banned. */
function isSaltOnlyOption(node: unknown): boolean {
  const rec = node as Record<string, unknown>;
  // NameValueExpression nests the option names under `arguments` (a NameValueList
  // with a `names: string[]`); FunctionCallOptions exposes `names` directly.
  const direct = asArray(rec["names"]).filter((n): n is string => typeof n === "string");
  if (direct.length > 0) {
    return direct.every((n) => n === "salt");
  }
  const nvl = rec["arguments"];
  if (nvl !== null && typeof nvl === "object" && !Array.isArray(nvl)) {
    const names = asArray((nvl as Record<string, unknown>)["names"]).filter(
      (n): n is string => typeof n === "string",
    );
    return names.length > 0 && names.every((n) => n === "salt");
  }
  return false;
}

/** True when an expression IS the canonical `vm` identifier. */
function isVmExpression(expr: unknown): boolean {
  return nodeType(expr) === "Identifier" && (expr as Record<string, unknown>)["name"] === "vm";
}

type ImportInfo = {
  path: string;
  symbols: Map<string, string> /* localName -> originalName */;
  whole: boolean;
};

function collectImports(ast: unknown): ImportInfo[] {
  const out: ImportInfo[] = [];
  for (const node of childNodes(ast)) {
    if (nodeType(node) !== "ImportDirective") {
      continue;
    }
    const rec = node as Record<string, unknown>;
    const path = typeof rec["path"] === "string" ? rec["path"] : "";
    const symbols = new Map<string, string>();
    const aliases = rec["symbolAliases"];
    if (Array.isArray(aliases)) {
      for (const pair of aliases) {
        if (Array.isArray(pair)) {
          const orig = typeof pair[0] === "string" ? pair[0] : "";
          const local = typeof pair[1] === "string" && pair[1].length > 0 ? pair[1] : orig;
          if (orig.length > 0) {
            symbols.set(local, orig);
          }
        }
      }
    }
    out.push({ path, symbols, whole: !Array.isArray(aliases) || aliases.length === 0 });
  }
  return out;
}

/** localName -> {original, path}. Whole-file imports (no symbol list) map a name
 * to itself at that path — used to resolve `new X` back to its source file. */
function collectImportAliases(ast: unknown): Map<string, ImportAlias> {
  const map = new Map<string, ImportAlias>();
  for (const imp of collectImports(ast)) {
    if (imp.whole) {
      continue; // no local bindings to resolve; handled by whole-file path checks
    }
    for (const [local, original] of imp.symbols) {
      map.set(local, { original, path: imp.path });
    }
  }
  return map;
}

/** Resolve a `new <sym>` type name to its original symbol + import path. */
function resolveNewTarget(sym: string, aliases: Map<string, ImportAlias>): ImportAlias {
  return aliases.get(sym) ?? { original: sym, path: "" };
}

/** Every import must resolve to the allowed forge-std surface or a REAL cited
 * closure path; anything else (non-.sol, out-of-allowlist, mock/test path) fails. */
function checkImports(
  ast: unknown,
  pocTarget: PocTarget,
  closureAstByPath: ReadonlyMap<string, ClosureAst>,
): string | null {
  for (const imp of collectImports(ast)) {
    const p = imp.path;
    if (FORBIDDEN_FORGE_STD_SUBSTR.some((s) => p.includes(s))) {
      return `import ${p} is a forbidden forge-std module (assertion surface only)`;
    }
    if (p.startsWith("forge-std/")) {
      if (!ALLOWED_FORGE_STD_IMPORTS.has(p)) {
        return `import ${p} is not an allowed forge-std module`;
      }
      continue;
    }
    if (!p.endsWith(".sol")) {
      return `import ${p} is not a .sol source`;
    }
    const key = resolveImportToClosureKey(p, closureAstByPath);
    if (key === null) {
      return `import ${p} does not resolve to a cited closure path`;
    }
    if (isNonRealDepPath(key) && !pathMatches(p, pocTarget.path)) {
      return `import ${p} resolves to a mock/test/script path (not a real dependency)`;
    }
  }
  return null;
}

/**
 * Resolve an import path to a closure KEY. Directionality is safe: the real
 * closure key must END WITH the (normalized) import path — never the reverse, so
 * a crafted longer path (`test/mocks/src/Vault.sol`) cannot masquerade as a
 * shorter cited key (`src/Vault.sol`). Phase-1 best-effort; Phase-3 build-info is
 * the CONFIRMED authority for target identity.
 */
function resolveImportToClosureKey(
  importPath: string,
  closureAstByPath: ReadonlyMap<string, ClosureAst>,
): string | null {
  const norm = stripDotSegments(importPath);
  for (const key of closureAstByPath.keys()) {
    if (key === norm || key.endsWith(`/${norm}`)) {
      return key;
    }
  }
  return null;
}

/** True when an import path canonicalizes to the target's closure path (§gate 5;
 * safe directionality — target path ends with the import, never the reverse). */
function pathMatches(importPath: string, targetPath: string): boolean {
  const norm = stripDotSegments(importPath);
  return targetPath === norm || targetPath.endsWith(`/${norm}`);
}

function importBindsTargetFromPath(
  ast: unknown,
  pocTarget: PocTarget,
  aliases: Map<string, ImportAlias>,
): boolean {
  // Resolved via an aliased/named import.
  const viaAlias = [...aliases.values()].some(
    (a) => a.original === pocTarget.symbol && pathMatches(a.path, pocTarget.path),
  );
  if (viaAlias) {
    return true;
  }
  // Or a whole-file import of the target's path.
  for (const imp of collectImports(ast)) {
    if (imp.whole && pathMatches(imp.path, pocTarget.path)) {
      return true;
    }
  }
  return false;
}

function stripDotSegments(p: string): string {
  return p.replace(/^\.\//u, "").replace(/(^|\/)\.\.\//gu, "");
}

/** A `Type x = <init>;` top-level statement → {name, init}. */
function varDeclInit(stmt: unknown): { name: string; init: unknown } | null {
  if (nodeType(stmt) !== "VariableDeclarationStatement") {
    return null;
  }
  const rec = stmt as Record<string, unknown>;
  const vars = asArray(rec["variables"]);
  if (vars.length !== 1) {
    return null;
  }
  const name = (vars[0] as Record<string, unknown>)["name"];
  if (typeof name !== "string") {
    return null;
  }
  return { name, init: rec["initialValue"] ?? null };
}

/** Contract-wide taint map (Tier-2): walk every var decl / `x = …` assignment
 * and classify it, so `checkVmDealRecipients` can tell a deployed instance from
 * an EOA even across setUp + helpers. Not strictly sequential (harness code has
 * control flow), but sound for the deployed-vs-EOA distinction the vm.deal gate
 * needs (a `new`-assigned var is deployed regardless of ordering). */
function buildContractTaints(scope: unknown): Map<string, Taint> {
  const taints = new Map<string, Taint>();
  walk(scope, (n) => {
    const decl = varDeclInit(n);
    if (decl !== null) {
      taints.set(decl.name, classifyRhs(decl.init, taints).taint);
      return;
    }
    if (nodeType(n) === "BinaryOperation" && (n as Record<string, unknown>)["operator"] === "=") {
      const left = (n as Record<string, unknown>)["left"];
      if (nodeType(left) === "Identifier") {
        const nm = (left as Record<string, unknown>)["name"];
        if (typeof nm === "string") {
          taints.set(nm, classifyRhs((n as Record<string, unknown>)["right"], taints).taint);
        }
      }
    }
  });
  return taints;
}

/** Classify the RHS of a straight-line assignment for taint + deploy detection. */
function classifyRhs(
  init: unknown,
  taints: Map<string, Taint>,
): { taint: Taint; newSymbol?: string } {
  // `new X(...)` → FunctionCall whose expression is NewExpression.
  if (nodeType(init) === "FunctionCall") {
    const callee = (init as Record<string, unknown>)["expression"];
    if (nodeType(callee) === "NewExpression") {
      const tn = (callee as Record<string, unknown>)["typeName"];
      const nm =
        tn !== null && typeof tn === "object"
          ? (tn as Record<string, unknown>)["namePath"]
          : undefined;
      return { taint: "deployed", newSymbol: typeof nm === "string" ? nm : "" };
    }
  }
  return { taint: addressTaint(init, taints) };
}

/**
 * Taint of an address-valued expression. `deployed` (a contract instance or any
 * value derived from one, incl. address(...)/payable(...)/uint160(...) wrappers),
 * `eoa` (literal / makeAddr / msg.sender / a proven-EOA local), else `other`
 * (unknown — treated as non-EOA by the vm.deal gate).
 */
function addressTaint(expr: unknown, taints: Map<string, Taint>): Taint {
  const t = nodeType(expr);
  if (t === "NumberLiteral" || t === "HexLiteral") {
    return "eoa";
  }
  if (t === "MemberAccess") {
    const obj = (expr as Record<string, unknown>)["expression"];
    const mn = (expr as Record<string, unknown>)["memberName"];
    if (
      nodeType(obj) === "Identifier" &&
      (obj as Record<string, unknown>)["name"] === "msg" &&
      mn === "sender"
    ) {
      return "eoa";
    }
    return "other";
  }
  if (t === "Identifier") {
    const nm = (expr as Record<string, unknown>)["name"];
    if (nm === "this") {
      return "deployed";
    }
    if (typeof nm === "string") {
      return taints.get(nm) ?? "other";
    }
  }
  if (t === "FunctionCall") {
    const callee = (expr as Record<string, unknown>)["expression"];
    // `new X()` in an address position → deployed.
    if (nodeType(callee) === "NewExpression") {
      return "deployed";
    }
    const cn = calleeIdentifierName(expr);
    if (cn === "makeAddr") {
      return "eoa";
    }
    // Wrapper casts: address(x) / payable(x) / uint160(x) → propagate inner taint.
    if (
      cn === "address" ||
      cn === "payable" ||
      cn === "uint160" ||
      nodeType(callee) === "ElementaryTypeName"
    ) {
      const args = asArray((expr as Record<string, unknown>)["arguments"]);
      if (args.length === 1) {
        return addressTaint(args[0], taints);
      }
      return "other";
    }
  }
  return "other";
}

/** vm.deal must have arity 2 and a proven-EOA recipient (never deployed-derived). */
function checkVmDealRecipients(body: unknown, taints: Map<string, Taint>): string | null {
  let problem: string | null = null;
  walk(body, (n) => {
    if (problem !== null || nodeType(n) !== "FunctionCall") {
      return;
    }
    const callee = (n as Record<string, unknown>)["expression"];
    if (nodeType(callee) !== "MemberAccess") {
      return;
    }
    const obj = (callee as Record<string, unknown>)["expression"];
    const mn = (callee as Record<string, unknown>)["memberName"];
    if (
      !(
        nodeType(obj) === "Identifier" &&
        (obj as Record<string, unknown>)["name"] === "vm" &&
        mn === "deal"
      )
    ) {
      return;
    }
    const argsList = asArray((n as Record<string, unknown>)["arguments"]);
    if (argsList.length !== 2) {
      problem = `vm.deal must take exactly 2 args (ETH funding); found ${argsList.length} (3-arg token deal is forbidden)`;
      return;
    }
    if (addressTaint(argsList[0], taints) !== "eoa") {
      problem =
        "vm.deal recipient is not a proven EOA actor (must not be the target / a deployed-derived value)";
    }
  });
  return problem;
}

/** The set of mutabilities across all overloads of `fnName` over the target's
 * inheritance closure. Empty when the function is unknown. */
function resolveMutabilitySet(
  contractName: string,
  fnName: string,
  closureAstByPath: ReadonlyMap<string, ClosureAst>,
  seen = new Set<string>(),
): Set<string | null> {
  const out = new Set<string | null>();
  if (seen.has(contractName)) {
    return out;
  }
  seen.add(contractName);
  for (const ast of closureAstByPath.values()) {
    const decl = ast.contracts.find((c) => c.name === contractName);
    if (decl === undefined) {
      continue;
    }
    for (const m of decl.functions.get(fnName) ?? []) {
      out.add(m);
    }
    for (const base of decl.bases) {
      for (const m of resolveMutabilitySet(base, fnName, closureAstByPath, seen)) {
        out.add(m);
      }
    }
  }
  return out;
}

/** Drive: EVERY overload of the called name is non-view/non-pure (so whichever
 * one binds at runtime, it mutates). Empty/mixed/unknown → not a safe drive. */
function isDrivingCall(set: Set<string | null>): boolean {
  if (set.size === 0) {
    return false;
  }
  for (const m of set) {
    if (m === "view" || m === "pure") {
      return false;
    }
  }
  return true;
}

/** Read (for assertion binding): EVERY overload is view/pure. Empty/mixed → not a read. */
function isViewRead(set: Set<string | null>): boolean {
  if (set.size === 0) {
    return false;
  }
  for (const m of set) {
    if (m !== "view" && m !== "pure") {
      return false;
    }
  }
  return true;
}

/** Index of the first statement that drives the target with a resolved
 * non-view/non-pure call; -1 if none / unresolved. */
function findDriveStatementIndex(
  statements: unknown[],
  deployedVar: string,
  pocTarget: PocTarget,
  closureAstByPath: ReadonlyMap<string, ClosureAst>,
): number {
  for (let i = 0; i < statements.length; i++) {
    let driveHere = false;
    walk(statements[i], (n) => {
      if (driveHere || nodeType(n) !== "FunctionCall") {
        return;
      }
      const callee = (n as Record<string, unknown>)["expression"];
      if (nodeType(callee) !== "MemberAccess") {
        return;
      }
      const obj = (callee as Record<string, unknown>)["expression"];
      const fnName = (callee as Record<string, unknown>)["memberName"];
      if (
        nodeType(obj) === "Identifier" &&
        (obj as Record<string, unknown>)["name"] === deployedVar &&
        typeof fnName === "string" &&
        isDrivingCall(resolveMutabilitySet(pocTarget.symbol, fnName, closureAstByPath))
      ) {
        driveHere = true;
      }
    });
    if (driveHere) {
      return i;
    }
  }
  return -1;
}

/** Whether some statement after the drive contains a forge-std `assert*` bound to
 * the target under the STRICT structural rule: the assertion must compare a BARE
 * target read (the target view read itself, modulo value-preserving casts/parens
 * and the straight-line local binder) against a TARGET-INDEPENDENT operand — or be
 * a bare target bool getter (`assertTrue(t.isBroken())`). This is the airtight
 * promotable shape: it rejects the entire self-referential tautology family
 * (`assertEq(b, b + 5 - 5)`, `assertGe(b, uint256(b))`) where BOTH sides read the
 * target, without a constant-folding arms race. A legit cross-view invariant
 * (`assertEq(t.a(), t.b())`) is intentionally NOT promotable here (safe
 * false-negative → Tier-2 CANDIDATE); a security `CONFIRMED` asserts a target read
 * against a fixed expectation. Reflexive-against-constant bounds (`b >= 0`) still
 * bind here but are rejected by `findDecidableTautology` (`constTruth`). */
function hasBoundAssertion(
  statements: unknown[],
  driveIdx: number,
  deployedVar: string,
  pocTarget: PocTarget,
  closureAstByPath: ReadonlyMap<string, ClosureAst>,
): boolean {
  const targetDerived = new Set<string>();
  const bareDerived = new Set<string>();
  const readsTarget = (expr: unknown): boolean =>
    exprReadsViewTarget(expr, deployedVar, pocTarget, closureAstByPath, targetDerived);
  const isBare = (expr: unknown): boolean =>
    isBareTargetRead(expr, deployedVar, pocTarget, closureAstByPath, bareDerived);
  // Exactly one side is a BARE target read and the OTHER is target-independent.
  const oneSideBare = (a: unknown, b: unknown): boolean =>
    (isBare(a) && !readsTarget(b)) || (isBare(b) && !readsTarget(a));
  for (let i = driveIdx; i < statements.length; i++) {
    const decl = varDeclInit(statements[i]);
    if (decl !== null) {
      if (readsTarget(decl.init)) {
        targetDerived.add(decl.name);
      }
      if (isBare(decl.init)) {
        bareDerived.add(decl.name);
      }
    }
    // Only a TOP-LEVEL assert* statement can bind — a nested (control-flow-
    // wrapped) assertion never counts (§3.3.B top-level-unconditional rule; also
    // a no-op for Tier-1, whose straight-line gate forbids nesting).
    const n = topLevelCall(statements[i]);
    if (n === null || i <= driveIdx) {
      continue;
    }
    const name = calleeIdentifierName(n);
    if (name === null || !name.startsWith("assert")) {
      continue;
    }
    const argsAll = asArray(n["arguments"]);
    // Condition-only asserts (assertTrue/assertFalse/assert): peel negations/parens,
    // then accept a bare target bool getter OR a comparison with one bare side.
    if (ASSERT_CONDITION_ONLY.has(name)) {
      let expr: unknown = unwrapParens(argsAll[0]);
      while (isLogicalNot(expr)) {
        expr = unwrapParens((expr as Record<string, unknown>)["subExpression"]);
      }
      if (isBare(expr)) {
        return true;
      }
      if (
        nodeType(expr) === "BinaryOperation" &&
        oneSideBare(
          (expr as Record<string, unknown>)["left"],
          (expr as Record<string, unknown>)["right"],
        )
      ) {
        return true;
      }
      continue;
    }
    // Two-arg comparator asserts: exactly one side a bare target read.
    if (
      assertSuccessOp(name) !== null &&
      argsAll.length >= 2 &&
      oneSideBare(argsAll[0], argsAll[1])
    ) {
      return true;
    }
  }
  return false;
}

/** A BARE target read: the expression's value IS a target view read, modulo
 * value-preserving casts / identity arithmetic / parens (`canonExpr`) and the
 * straight-line local binder. A target read combined with anything else
 * (`b | mask`, `b + other`) is NOT bare. */
function isBareTargetRead(
  expr: unknown,
  deployedVar: string,
  pocTarget: PocTarget,
  closureAstByPath: ReadonlyMap<string, ClosureAst>,
  bareDerived: ReadonlySet<string>,
): boolean {
  const c = canonExpr(expr);
  const t = nodeType(c);
  if (t === "FunctionCall") {
    const callee = (c as Record<string, unknown>)["expression"];
    if (nodeType(callee) === "MemberAccess") {
      const obj = (callee as Record<string, unknown>)["expression"];
      const mn = (callee as Record<string, unknown>)["memberName"];
      return (
        nodeType(obj) === "Identifier" &&
        (obj as Record<string, unknown>)["name"] === deployedVar &&
        typeof mn === "string" &&
        isViewRead(resolveMutabilitySet(pocTarget.symbol, mn, closureAstByPath))
      );
    }
    return false;
  }
  if (t === "Identifier") {
    const nm = (c as Record<string, unknown>)["name"];
    return typeof nm === "string" && bareDerived.has(nm);
  }
  return false;
}

/**
 * True when an expression reads the deployed target via a VIEW/pure getter call
 * (`<var>.g(...)` resolving to view/pure over the target closure), or references
 * a local already derived from such a read. A mutating "read" does NOT count.
 */
function exprReadsViewTarget(
  expr: unknown,
  deployedVar: string,
  pocTarget: PocTarget,
  closureAstByPath: ReadonlyMap<string, ClosureAst>,
  derived: Set<string>,
): boolean {
  // DIRECTED, load-bearing traversal: the VALUE of `expr` must depend on a target
  // view read through TRANSPARENT operators only. A helper/non-target call is
  // OPAQUE (its result is not a target read even if a read hides in its args —
  // closes the helper-swallow), and a constant short-circuit (`true || …`,
  // `false && …`) makes the other operand dead (closes the short-circuit launder).
  const t = nodeType(expr);
  const rec = expr as Record<string, unknown>;
  if (t === "FunctionCall") {
    const callee = rec["expression"];
    if (nodeType(callee) === "MemberAccess") {
      const obj = (callee as Record<string, unknown>)["expression"];
      const mn = (callee as Record<string, unknown>)["memberName"];
      if (
        nodeType(obj) === "Identifier" &&
        (obj as Record<string, unknown>)["name"] === deployedVar &&
        typeof mn === "string" &&
        isViewRead(resolveMutabilitySet(pocTarget.symbol, mn, closureAstByPath))
      ) {
        return true; // the target view getter itself
      }
    }
    return false; // any other call (helper / non-target member) is opaque
  }
  const sub = (n: unknown): boolean =>
    exprReadsViewTarget(n, deployedVar, pocTarget, closureAstByPath, derived);
  if (t === "Identifier") {
    const nm = rec["name"];
    return typeof nm === "string" && derived.has(nm);
  }
  if (t === "BinaryOperation") {
    const op = rec["operator"];
    if ((op === "||" || op === "&&") && (isConstBool(rec["left"]) || isConstBool(rec["right"]))) {
      return false; // constant short-circuit → the non-constant operand is dead
    }
    return sub(rec["left"]) || sub(rec["right"]);
  }
  if (t === "UnaryOperation") {
    return sub(rec["subExpression"]) || sub(rec["subExpression"] ?? rec["argument"]);
  }
  if (t === "TupleExpression") {
    return asArray(rec["components"]).some(sub);
  }
  // A ternary launders the read through a branch — not load-bearing.
  return false;
}

function isConstBool(node: unknown): boolean {
  return nodeType(node) === "BooleanLiteral";
}
