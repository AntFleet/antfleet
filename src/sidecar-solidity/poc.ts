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

/** Forge-std imports permitted (assertion surface only). */
const ALLOWED_FORGE_STD_IMPORTS = new Set(["forge-std/Test.sol", "forge-std/StdAssertions.sol"]);
const FORBIDDEN_FORGE_STD_SUBSTR = ["StdStorage", "StdCheats", "/Vm.sol"];

/** Base contracts the single test contract may inherit (forge-std assertion surface). */
const ALLOWED_TEST_BASES = new Set(["Test", "StdAssertions", "DSTest"]);

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
    const isAbstract = rec["abstract"] === true;
    const kind: ClosureContractDecl["kind"] =
      rawKind === "interface"
        ? "interface"
        : rawKind === "library"
          ? "library"
          : isAbstract
            ? "abstract"
            : "contract";
    const bases = baseContractNames(rec);
    const functions = new Map<string, (string | null)[]>();
    for (const sub of asArray(rec["subNodes"])) {
      if (nodeType(sub) !== "FunctionDefinition") {
        continue;
      }
      const f = sub as Record<string, unknown>;
      const fname = typeof f["name"] === "string" ? f["name"] : "";
      if (fname.length === 0 || f["isConstructor"] === true) {
        continue;
      }
      const mut = typeof f["stateMutability"] === "string" ? f["stateMutability"] : null;
      const list = functions.get(fname) ?? [];
      list.push(mut);
      functions.set(fname, list);
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
      const match = entryAst.contracts.find((c) => c.kind === "contract" && c.name === symbol);
      if (match !== undefined) {
        hits.push({
          path: match.path,
          symbol: match.name,
          kind: "contract",
          derivation: "resolved deployable target reaching cited code",
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

export type PocBinding = {
  targetSymbol: string;
  targetPath: string;
  /** The single local variable holding the deployed target instance. */
  deployedVar: string;
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
export function staticGatePoc(
  testContents: string,
  _finding: Pick<AuditFinding, "evidence">,
  pocTarget: PocTarget,
  closureAstByPath: ReadonlyMap<string, ClosureAst>,
): PocStaticGate {
  const reasons: string[] = [];
  const fail = (r: string): PocStaticGate => {
    reasons.push(r);
    return { passed: false, reasons };
  };

  // Gate 4: size.
  if (Buffer.byteLength(testContents, "utf8") > POC_FILE_MAX_BYTES) {
    return fail(`test exceeds POC_FILE_MAX_BYTES (${POC_FILE_MAX_BYTES})`);
  }

  let ast: unknown;
  try {
    ast = parse(testContents, { tolerant: false });
  } catch (err) {
    return fail(`test does not parse: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Gate 1 (shape): NO top-level free functions/modifiers; exactly one contract;
  // exactly one function `testAuditPoc` (public, no args, no modifiers) inside it.
  const topLevel = childNodes(ast);
  if (
    topLevel.some(
      (n) => nodeType(n) === "FunctionDefinition" || nodeType(n) === "ModifierDefinition",
    )
  ) {
    return fail("test declares a file-scope (free) function/modifier (can shadow assertions)");
  }
  const contracts = topLevel.filter((n) => nodeType(n) === "ContractDefinition");
  if (contracts.length !== 1) {
    return fail(`test must declare exactly one contract (found ${contracts.length})`);
  }
  const testContract = contracts[0] as Record<string, unknown>;
  // Gate 5b: the test contract may inherit ONLY the forge-std assertion surface —
  // never a closure/test-authored base that could shadow assert* (§gate 8 soundness).
  for (const base of baseContractNames(testContract)) {
    if (!ALLOWED_TEST_BASES.has(base)) {
      return fail(
        `test contract inherits a non-forge-std base \`${base}\` (could shadow assertions)`,
      );
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

  // Straight-line: no control flow / assembly / ternary / early return|revert anywhere.
  const controlViolation = findControlFlow(body);
  if (controlViolation !== null) {
    return fail(`testAuditPoc body is not straight-line (contains ${controlViolation})`);
  }

  // Import alias map + import allowlist (gate 3 forge-std + gate 5/6 closure paths).
  const aliases = collectImportAliases(ast);
  const importErr = checkImports(ast, pocTarget, closureAstByPath);
  if (importErr !== null) {
    return fail(importErr);
  }

  // Gate 2/3: forbidden constructs (fabrication, HEVM addr, low-level calls, Vm
  // aliases, stdstore chains, non-allowlisted vm.*, non-`new` creation).
  const forbidden = scanForbiddenConstructs(body);
  if (forbidden !== null) {
    return fail(forbidden);
  }

  // Straight-line symbol table (taint) + the single target instance (gate 5/6).
  const taints = new Map<string, Taint>();
  const instantiableNames = collectRealClosureContractNames(closureAstByPath);
  let deployedVar: string | null = null;
  let deployCount = 0;
  for (const stmt of statements) {
    const decl = varDeclInit(stmt);
    if (decl === null) {
      continue;
    }
    const cls = classifyRhs(decl.init, taints);
    if (cls.newSymbol !== undefined) {
      // Gate 6: every `new X` must be the target or a REAL (non-mock) cited
      // closure contract, imported from a real closure path.
      const resolved = resolveNewTarget(cls.newSymbol, aliases);
      const isTarget =
        resolved.original === pocTarget.symbol && pathMatches(resolved.path, pocTarget.path);
      if (isTarget) {
        deployCount += 1;
        deployedVar = decl.name;
      } else if (!instantiableNames.has(resolved.original)) {
        return fail(`\`new ${cls.newSymbol}\` is not the target or a real cited closure contract`);
      }
    }
    taints.set(decl.name, cls.taint);
  }
  if (deployCount !== 1 || deployedVar === null) {
    return fail(
      `test must deploy exactly one \`new ${pocTarget.symbol}\` instance (found ${deployCount})`,
    );
  }

  // Gate 5: the deployed symbol must be imported from pocTarget.path (canonical).
  if (!importBindsTargetFromPath(ast, pocTarget, aliases)) {
    return fail(`${pocTarget.symbol} is not imported from ${pocTarget.path}`);
  }

  // Gate 3 (vm.deal): arity 2 + recipient is a proven EOA actor (never the target
  // / a deployed instance / any deployed-derived value).
  const dealErr = checkVmDealRecipients(body, taints);
  if (dealErr !== null) {
    return fail(dealErr);
  }

  // Gate 7 (drive): a call on the deployed var whose EVERY overload is
  // non-view/non-pure, before the asserted read. Mutability over inheritance.
  const driveIdx = findDriveStatementIndex(statements, deployedVar, pocTarget, closureAstByPath);
  if (driveIdx < 0) {
    return fail("no resolved non-view drive call on the deployed target before the assertion");
  }

  // Gate 8 (assertion-binding): a forge-std assert* after the drive whose CHECKED
  // operand data-depends on a post-drive VIEW read of the deployed target.
  if (!hasBoundAssertion(statements, driveIdx, deployedVar, pocTarget, closureAstByPath)) {
    return fail("no assertion after the drive reads the deployed target's post-drive view state");
  }

  return {
    passed: true,
    reasons: [],
    tier: "static-bound",
    assertionForm: "target-read",
    binding: { targetSymbol: pocTarget.symbol, targetPath: pocTarget.path, deployedVar },
  };
}

// --- Promotion (§3.3 promoteWithPoc) -----------------------------------------

export type PocTier = "static-bound" | "harness-driven";
export type PocAssertionForm = "revert" | "target-read" | "no-revert" | "none";
export type PocDriveKind = "direct-revert" | "callback";

/** The validated Phase-2 GO artifact's per-tier enablement flags (§7). */
export type ActiveGo = { enableStatic: boolean; enableHarness: boolean };

export type PocExecution = {
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
  if (!e.compiled || !e.passed) {
    return null;
  }
  if (poc.target === null || e.deployedTargetPath !== poc.target.path) {
    return null;
  }
  if (poc.tier === "static-bound" && e.drove) {
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
  if (poc.assertionForm === "no-revert") {
    return {
      verdict: "PURSUE",
      reason: "harness ran, no-revert only (not a terminal verdict)",
    };
  }
  if (!poc.executed || execution === null) {
    return {
      verdict: "PURSUE",
      reason:
        poc.tier === "harness-driven"
          ? "harness PoC awaiting execution"
          : "PoC generated + statically gated, not executed (executor off)",
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
function scanForbiddenConstructs(body: unknown): string | null {
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

    if (t === "MemberAccess") {
      const m = rec["memberName"];
      if (m === "creationCode" || m === "runtimeCode") {
        problem = "uses type(X).creationCode/runtimeCode (creation must be `new X`)";
      }
      // stdstore / checked_write / checked_read anywhere in a member chain.
      if (typeof m === "string" && FORBIDDEN_HELPER_NAMES.has(m)) {
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
          if (typeof mn === "string" && !ALLOWED_VM_CHEATS.has(mn)) {
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
      problem = "uses call/creation options (e.g. `new X{salt:…}` / `{value:…}`)";
    }
  });
  return problem;
}

/** True when an expression IS the canonical `vm` identifier. */
function isVmExpression(expr: unknown): boolean {
  return nodeType(expr) === "Identifier" && (expr as Record<string, unknown>)["name"] === "vm";
}

/** Real (non-mock/test/script) closure contract names — the instantiable set (gate 6). */
function collectRealClosureContractNames(
  closureAstByPath: ReadonlyMap<string, ClosureAst>,
): Set<string> {
  const names = new Set<string>();
  for (const ast of closureAstByPath.values()) {
    if (isNonRealDepPath(ast.path)) {
      continue;
    }
    for (const c of ast.contracts) {
      if (c.kind === "contract") {
        names.add(c.name);
      }
    }
  }
  return names;
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

/** Whether some statement after the drive contains a forge-std `assert*` whose
 * CHECKED operand data-depends on a post-drive VIEW read of the deployed target. */
function hasBoundAssertion(
  statements: unknown[],
  driveIdx: number,
  deployedVar: string,
  pocTarget: PocTarget,
  closureAstByPath: ReadonlyMap<string, ClosureAst>,
): boolean {
  const readsTarget = (expr: unknown): boolean =>
    exprReadsViewTarget(expr, deployedVar, pocTarget, closureAstByPath, targetDerived);
  const targetDerived = new Set<string>();
  for (let i = driveIdx; i < statements.length; i++) {
    const decl = varDeclInit(statements[i]);
    if (decl !== null && readsTarget(decl.init)) {
      targetDerived.add(decl.name);
    }
    let bound = false;
    walk(statements[i], (n) => {
      if (bound || nodeType(n) !== "FunctionCall") {
        return;
      }
      const name = calleeIdentifierName(n);
      if (name === null || !name.startsWith("assert")) {
        return;
      }
      // Callee-aware: inspect only the CHECKED operands, never the message arg.
      const argsAll = asArray((n as Record<string, unknown>)["arguments"]);
      const checked = ASSERT_CONDITION_ONLY.has(name) ? argsAll.slice(0, 1) : argsAll.slice(0, 2);
      if (name === "assertTrue" && isBooleanLiteral(argsAll[0])) {
        return; // assertTrue(true) / assertTrue(false) never binds
      }
      for (const arg of checked) {
        if (i > driveIdx && readsTarget(arg)) {
          bound = true;
        }
      }
    });
    if (bound) {
      return true;
    }
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
  let reads = false;
  const check = (n: unknown): void => {
    if (nodeType(n) === "FunctionCall") {
      const callee = (n as Record<string, unknown>)["expression"];
      if (nodeType(callee) === "MemberAccess") {
        const obj = (callee as Record<string, unknown>)["expression"];
        const mn = (callee as Record<string, unknown>)["memberName"];
        if (
          nodeType(obj) === "Identifier" &&
          (obj as Record<string, unknown>)["name"] === deployedVar &&
          typeof mn === "string" &&
          isViewRead(resolveMutabilitySet(pocTarget.symbol, mn, closureAstByPath))
        ) {
          reads = true;
        }
      }
    }
    if (nodeType(n) === "Identifier") {
      const nm = (n as Record<string, unknown>)["name"];
      if (typeof nm === "string" && derived.has(nm)) {
        reads = true;
      }
    }
  };
  check(expr);
  walk(expr, check);
  return reads;
}

function isBooleanLiteral(arg: unknown): boolean {
  return nodeType(arg) === "BooleanLiteral";
}
