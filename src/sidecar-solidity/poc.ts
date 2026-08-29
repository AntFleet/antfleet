// PoC target resolution + AST static gates + promotion
// (§3.3 of specs/SOLIDITY_SIDECAR_POC_SPEC.md). PURE + I/O-free: callers pass a
// parsed closure-AST map + the closure roles graph; this module does no FS access.
//
// The gates operate on a PARSED Solidity AST (@solidity-parser/parser), which is
// string/comment/literal-aware by construction (a regex scan is not). Any fact
// the AST cannot resolve (dynamic dispatch, unknown mutability, unparseable body)
// DECLINES → the finding stays PURSUE. Nothing fails open into a false CONFIRMED.
//
// Phase 1 (this build) ships generation + these static gates; the executor
// (§3.4) and terminal CONFIRMED promotion are Phase 3, gated behind the §7 spike.
// promoteWithPoc is implemented in full so Phase 3 only wires the executor.

import { parse } from "@solidity-parser/parser";
import type { AuditFinding } from "./finding-schema.js";
import type { PromotionDecision } from "./scoring.js";

export const POC_FILE_MAX_BYTES = 24 * 1024;

/** vm.<member> cheats permitted (fabrication-free). vm.deal is additionally
 * recipient-constrained (gate 3). Everything else on `vm` is rejected. */
export const ALLOWED_VM_CHEATS: ReadonlySet<string> = new Set([
  "prank",
  "startPrank",
  "stopPrank",
  "deal",
  "warp",
  "roll",
]);

/** Bare (inherited-from-Test) identifiers that reach a forbidden cheat internally. */
export const FORBIDDEN_BARE_CALLS: ReadonlySet<string> = new Set([
  "deal", // StdCheats deal(token,…) / deal(addr,eth); only vm.deal(addr,uint) is allowed
  "hoax",
  "startHoax",
  "deployCode",
  "deployCodeTo",
  "checked_write",
  "checked_read",
  "makePersistent",
]);

/** Forge-std imports permitted (assertion surface only). */
const ALLOWED_FORGE_STD_IMPORTS = new Set(["forge-std/Test.sol", "forge-std/StdAssertions.sol"]);
const FORBIDDEN_FORGE_STD_SUBSTR = ["StdStorage", "StdCheats", "/Vm.sol"];

/** The HEVM cheatcode address, literal + its keccak derivation string. */
const HEVM_ADDRESS_LOWER = "0x7109709ecfa91a80626ff3989d68f67f5b1dd12d";

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
  /** function name -> stateMutability ("view"|"pure"|"payable"|"nonpayable"|null). */
  functions: Map<string, string | null>;
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
    const bases: string[] = [];
    for (const base of asArray(rec["baseContracts"])) {
      const bn = (base as Record<string, unknown>)["baseName"];
      const bname =
        bn !== null && typeof bn === "object"
          ? (bn as Record<string, unknown>)["namePath"]
          : undefined;
      if (typeof bname === "string") {
        bases.push(bname);
      }
    }
    const functions = new Map<string, string | null>();
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
      functions.set(fname, mut);
    }
    contracts.push({ path, name, kind, bases, functions });
  }
  return { path, source, contracts };
}

/** Minimal roles/edge view the resolver needs (subset of ClosureResult). */
export type ClosureRolesGraph = {
  /** repo-relative entry paths. */
  entries: readonly string[];
};

/**
 * Resolve the concrete deployable target for a finding (§3.3 precedence):
 * (1) the concrete `contract` enclosing the primary grounded evidence line;
 * (2) else the UNIQUE concrete deployable entry that declares/reaches the cited
 *     symbol; (3) else null → decline.
 * Interfaces / libraries / abstract contracts are never the deployed target.
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
    if (enclosing !== null && enclosing.kind === "contract") {
      return {
        path: enclosing.path,
        symbol: enclosing.name,
        kind: "contract",
        derivation: "enclosing concrete contract at primary cited line",
      };
    }
  }
  // (1b) if the primary file has exactly one concrete contract, use it.
  if (primaryAst !== undefined) {
    const concrete = primaryAst.contracts.filter((c) => c.kind === "contract");
    if (concrete.length === 1) {
      return {
        path: concrete[0]!.path,
        symbol: concrete[0]!.name,
        kind: "contract",
        derivation: "sole concrete contract in the primary cited file",
      };
    }
  }
  // (2) unique concrete deployable entry declaring the cited symbol.
  const symbol = primary.symbol;
  if (symbol !== null && symbol.length > 0) {
    const hits: PocTarget[] = [];
    for (const entryPath of graph.entries) {
      const entryAst = closureAstByPath.get(entryPath);
      if (entryAst === undefined) {
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

export type PocStaticGate = { passed: boolean; reasons: string[]; binding?: PocBinding };

type Sym = { kind: "deployed" | "eoa" | "targetRead" | "other" };

/**
 * The eight AST gates (§3.3). Returns `passed:true` + a `PocBinding` only when a
 * straight-line PoC deploys exactly the resolved target, drives it with a
 * non-view call, and asserts a post-drive read of it, with no fabrication /
 * disallowed cheat / out-of-allowlist import / non-target creation. Any
 * unresolvable fact fails the gate (fail-safe → PURSUE).
 */
export function staticGatePoc(
  testContents: string,
  finding: Pick<AuditFinding, "evidence">,
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

  // Gate 1 (shape): exactly one contract; exactly one function `testAuditPoc`
  // (public, no args, no modifiers); no other function/modifier declarations.
  const contracts = childNodes(ast).filter((n) => nodeType(n) === "ContractDefinition");
  if (contracts.length !== 1) {
    return fail(`test must declare exactly one contract (found ${contracts.length})`);
  }
  const testContract = contracts[0] as Record<string, unknown>;
  const subNodes = asArray(testContract["subNodes"]);
  const funcs = subNodes.filter((s) => nodeType(s) === "FunctionDefinition");
  const modifiers = subNodes.filter((s) => nodeType(s) === "ModifierDefinition");
  const otherContracts = childNodes(ast).filter(
    (n) => nodeType(n) === "ContractDefinition" && n !== contracts[0],
  );
  if (otherContracts.length > 0) {
    return fail("test declares more than one contract/library/interface");
  }
  if (modifiers.length > 0) {
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

  // Straight-line: no control flow / assembly / ternary / early return anywhere.
  const CONTROL = new Set([
    "IfStatement",
    "ForStatement",
    "WhileStatement",
    "DoWhileStatement",
    "TryStatement",
    "InlineAssemblyStatement",
    "Conditional",
    "ReturnStatement",
  ]);
  let controlViolation: string | null = null;
  walk(body, (n) => {
    const t = nodeType(n);
    if (CONTROL.has(t)) {
      controlViolation = t === "Conditional" ? "ternary (?:)" : t;
    }
    if (t === "RevertStatement") {
      controlViolation = "revert";
    }
  });
  if (controlViolation !== null) {
    return fail(`testAuditPoc body is not straight-line (contains ${controlViolation})`);
  }

  // Gate 2/3 scan the whole body once for forbidden constructs.
  const forbidden = scanForbiddenConstructs(body);
  if (forbidden !== null) {
    return fail(forbidden);
  }

  // Imports: allowlist (gate 3 forge-std + gate 5/6 closure paths).
  const importErr = checkImports(ast, pocTarget, closureAstByPath);
  if (importErr !== null) {
    return fail(importErr);
  }

  // Straight-line symbol table + the single target instance (gate 5/6).
  const symbols = new Map<string, Sym>();
  let deployedVar: string | null = null;
  let deployCount = 0;
  const closureContractNames = collectClosureContractNames(closureAstByPath);
  for (const stmt of statements) {
    const decl = varDeclInit(stmt);
    if (decl === null) {
      continue;
    }
    const cls = classifyRhs(decl.init, deployedVar, symbols);
    if (cls.kind === "deployed") {
      // Every `new X` must be the target or a real closure contract (gate 6).
      if (cls.newSymbol !== pocTarget.symbol && !closureContractNames.has(cls.newSymbol ?? "")) {
        return fail(`\`new ${cls.newSymbol}\` is not the target or a cited closure contract`);
      }
      if (cls.newSymbol === pocTarget.symbol) {
        deployCount += 1;
        deployedVar = decl.name;
      }
    }
    symbols.set(decl.name, { kind: cls.kind });
  }
  // Also reject any `new X` appearing outside a top-level var decl (defensive).
  const strayNew = findStrayNew(body, pocTarget.symbol, closureContractNames);
  if (strayNew !== null) {
    return fail(strayNew);
  }
  if (deployCount !== 1 || deployedVar === null) {
    return fail(
      `test must deploy exactly one \`new ${pocTarget.symbol}\` instance (found ${deployCount})`,
    );
  }

  // Gate 5: the deployed symbol must be imported from pocTarget.path (canonical).
  if (!importBindsTargetFromPath(ast, pocTarget)) {
    return fail(`${pocTarget.symbol} is not imported from ${pocTarget.path}`);
  }

  // Gate 3 (vm.deal recipient): reject deal to the target / a deployed instance.
  const dealErr = checkVmDealRecipients(body, deployedVar, symbols);
  if (dealErr !== null) {
    return fail(dealErr);
  }

  // Gate 7 (drive): a non-view/non-pure call on the deployed var, before the
  // asserted read. Mutability resolved over the target's inheritance closure.
  const driveIdx = findDriveStatementIndex(statements, deployedVar, pocTarget, closureAstByPath);
  if (driveIdx < 0) {
    return fail("no resolved non-view drive call on the deployed target before the assertion");
  }

  // Gate 8 (assertion-binding): an assert* after the drive whose operand
  // data-depends on a post-drive read of the deployed target.
  if (!hasBoundAssertion(statements, driveIdx, deployedVar)) {
    return fail("no assertion after the drive reads the deployed target's post-drive state");
  }

  return {
    passed: true,
    reasons: [],
    binding: { targetSymbol: pocTarget.symbol, targetPath: pocTarget.path, deployedVar },
  };
}

// --- Promotion (§3.3 promoteWithPoc) -----------------------------------------

export type PocExecution = {
  compiled: boolean;
  passed: boolean;
  drove: boolean;
  deployedTargetPath: string | null;
  reason: string;
};

export type PocRecord = {
  generated: boolean;
  rationale: string | null;
  target: PocTarget | null;
  testPath: string | null;
  testContents: string | null;
  staticGate: { passed: boolean; reasons: string[] };
  executed: boolean;
  execution: PocExecution | null;
  humanGated: boolean;
  runSpecific: boolean;
};

/**
 * THE post-PURSUE promotion gate. CONFIRMED requires a passing, deploy-verified,
 * driving execution; anything else STAYS PURSUE with a reason (never DROP). In
 * Phase 1 no executor runs, so `poc.executed` is false and this always returns
 * PURSUE — CONFIRMED becomes reachable only when Phase 3 wires the executor.
 */
export function promoteWithPoc(args: { base: PromotionDecision; poc: PocRecord }): {
  verdict: "CONFIRMED" | "PURSUE" | "DROP";
  reason: string;
} {
  const { base, poc } = args;
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
  if (!poc.executed || poc.execution === null) {
    return {
      verdict: "PURSUE",
      reason: "PoC generated + statically gated, not executed (executor off)",
    };
  }
  const e = poc.execution;
  if (!e.compiled) {
    return { verdict: "PURSUE", reason: `PoC did not compile: ${e.reason}` };
  }
  if (!e.passed) {
    return { verdict: "PURSUE", reason: `PoC ran but did not hold: ${e.reason}` };
  }
  if (poc.target !== null && e.deployedTargetPath !== poc.target.path) {
    return { verdict: "PURSUE", reason: "PoC target-path mismatch (build-info)" };
  }
  if (!e.drove) {
    return {
      verdict: "PURSUE",
      reason: "PoC did not drive the target (no non-static call in trace)",
    };
  }
  return {
    verdict: "CONFIRMED",
    reason:
      "CONFIRMED (PoC-executed, human-review-required): deployed the real cited contract, drove it, " +
      "an assertion over its post-drive state passed — NOT a proof of the specific exploit",
  };
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

/** Reject fabrication cheats, HEVM-address use, low-level calls, non-`new`
 * creation, forbidden bare StdCheats helpers, and non-allowlisted vm.* members. */
function scanForbiddenConstructs(body: unknown): string | null {
  let problem: string | null = null;
  walk(body, (n) => {
    if (problem !== null) {
      return;
    }
    const t = nodeType(n);
    const rec = n as Record<string, unknown>;

    // Literal HEVM cheatcode address anywhere.
    if (t === "NumberLiteral" || t === "HexLiteral" || t === "StringLiteral") {
      const raw = String(rec["number"] ?? rec["value"] ?? "").toLowerCase();
      if (raw.replace(/_/g, "").includes(HEVM_ADDRESS_LOWER)) {
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

    // `type(X).creationCode` / `.runtimeCode`.
    if (t === "MemberAccess") {
      const m = rec["memberName"];
      if (m === "creationCode" || m === "runtimeCode") {
        problem = "uses type(X).creationCode/runtimeCode (contract creation must be `new X`)";
      }
    }

    if (t === "FunctionCall") {
      const callee = rec["expression"];
      const ct = nodeType(callee);
      // Low-level .call/.delegatecall/.staticcall.
      if (ct === "MemberAccess") {
        const mn = (callee as Record<string, unknown>)["memberName"];
        if (mn === "call" || mn === "delegatecall" || mn === "staticcall") {
          problem = `uses a low-level .${String(mn)}()`;
        }
        // vm.<member> allowlist (also catches Vm-typed aliases named `vm`).
        const obj = (callee as Record<string, unknown>)["expression"];
        if (nodeType(obj) === "Identifier" && (obj as Record<string, unknown>)["name"] === "vm") {
          if (typeof mn === "string" && !ALLOWED_VM_CHEATS.has(mn)) {
            problem = `uses a non-allowlisted cheat vm.${mn}`;
          }
        }
      }
      // Bare StdCheats-style helper calls (deal/hoax/deployCode/…).
      if (ct === "Identifier") {
        const name = (callee as Record<string, unknown>)["name"];
        if (typeof name === "string" && FORBIDDEN_BARE_CALLS.has(name)) {
          problem = `uses a forbidden bare helper ${name}(...) (only vm.deal(address,uint256) is allowed)`;
        }
      }
    }
    // `new X{salt:...}` salted creation.
    if (t === "NewExpression") {
      // handled at construction sites; salted new appears as FunctionCall on a
      // NameValueExpression — conservatively reject any options on `new`.
      // (plain `new X(args)` is a FunctionCall whose expression is NewExpression)
    }
    if (t === "FunctionCallOptions" || t === "NameValueExpression") {
      problem = "uses call/creation options (e.g. `new X{salt:…}` / `{value:…}` on low-level)";
    }
  });
  return problem;
}

function collectClosureContractNames(
  closureAstByPath: ReadonlyMap<string, ClosureAst>,
): Set<string> {
  const names = new Set<string>();
  for (const ast of closureAstByPath.values()) {
    for (const c of ast.contracts) {
      names.add(c.name);
    }
  }
  return names;
}

type ImportInfo = { path: string; symbols: Map<string, string> /* localName -> originalName */ };

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
    out.push({ path, symbols });
  }
  return out;
}

/** Every import must resolve to the allowed forge-std surface or a cited
 * closure path; anything else (non-.sol, out-of-allowlist) fails. */
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
    if (!importResolvesToClosure(p, pocTarget, closureAstByPath)) {
      return `import ${p} does not resolve to a cited closure path`;
    }
  }
  return null;
}

/** Phase-1 best-effort path canonicalization (Phase 3 uses forge build-info as
 * ground truth). An import path canonicalizes to a closure path when it equals,
 * suffix-matches, or basename+dir-tail-matches a known closure path. */
function importResolvesToClosure(
  importPath: string,
  pocTarget: PocTarget,
  closureAstByPath: ReadonlyMap<string, ClosureAst>,
): boolean {
  // Full-path suffix identity only — NEVER basename (gate 5): a same-name stub at
  // a non-cited path must not resolve. (Phase-1 best-effort; Phase-3 build-info is
  // the CONFIRMED authority for target identity.)
  void pocTarget;
  const norm = stripDotSegments(importPath);
  for (const key of closureAstByPath.keys()) {
    if (key === norm || norm.endsWith(`/${key}`) || key.endsWith(`/${norm}`)) {
      return true;
    }
  }
  return false;
}

function importBindsTargetFromPath(ast: unknown, pocTarget: PocTarget): boolean {
  for (const imp of collectImports(ast)) {
    // Full closure-relative path identity only — NEVER basename (gate 5).
    const norm = stripDotSegments(imp.path);
    const resolvesPath = norm === pocTarget.path || norm.endsWith(`/${pocTarget.path}`);
    if (!resolvesPath) {
      continue;
    }
    // whole-file import (no symbol list) OR the target symbol is imported (aliased or not).
    if (imp.symbols.size === 0) {
      return true;
    }
    for (const orig of imp.symbols.values()) {
      if (orig === pocTarget.symbol) {
        return true;
      }
    }
  }
  return false;
}

function stripDotSegments(p: string): string {
  return p.replace(/^\.\//, "").replace(/(^|\/)\.\.\//g, "");
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

/** Classify the RHS of a straight-line assignment. */
function classifyRhs(
  init: unknown,
  deployedVar: string | null,
  symbols: Map<string, Sym>,
): Sym & { newSymbol?: string } {
  // `new X(...)` → FunctionCall whose expression is NewExpression.
  if (nodeType(init) === "FunctionCall") {
    const callee = (init as Record<string, unknown>)["expression"];
    if (nodeType(callee) === "NewExpression") {
      const tn = (callee as Record<string, unknown>)["typeName"];
      const nm =
        tn !== null && typeof tn === "object"
          ? (tn as Record<string, unknown>)["namePath"]
          : undefined;
      return { kind: "deployed", newSymbol: typeof nm === "string" ? nm : "" };
    }
    // `<deployedVar>.method(...)` → target read/call.
    if (nodeType(callee) === "MemberAccess") {
      const obj = (callee as Record<string, unknown>)["expression"];
      if (
        nodeType(obj) === "Identifier" &&
        (obj as Record<string, unknown>)["name"] === deployedVar
      ) {
        return { kind: "targetRead" };
      }
    }
    // makeAddr(...) → EOA.
    if (
      nodeType(callee) === "Identifier" &&
      (callee as Record<string, unknown>)["name"] === "makeAddr"
    ) {
      return { kind: "eoa" };
    }
    // address(uintN(...)) → EOA-ish literal actor.
    if (nodeType(callee) === "ElementaryTypeName" || nodeType(callee) === "Identifier") {
      const nm = (callee as Record<string, unknown>)["name"];
      if (nm === "address") {
        return { kind: "eoa" };
      }
    }
  }
  if (isEoaExpression(init, symbols)) {
    return { kind: "eoa" };
  }
  return { kind: "other" };
}

/** Whether an expression is an EOA-origin actor address (literal / makeAddr /
 * address(uintN) / msg.sender / a var already classified EOA). */
function isEoaExpression(expr: unknown, symbols: Map<string, Sym>): boolean {
  const t = nodeType(expr);
  if (t === "NumberLiteral" || t === "HexLiteral") {
    return true;
  }
  if (t === "MemberAccess") {
    const obj = (expr as Record<string, unknown>)["expression"];
    const mn = (expr as Record<string, unknown>)["memberName"];
    if (
      nodeType(obj) === "Identifier" &&
      (obj as Record<string, unknown>)["name"] === "msg" &&
      mn === "sender"
    ) {
      return true;
    }
  }
  if (t === "Identifier") {
    const nm = (expr as Record<string, unknown>)["name"];
    if (nm === "address") {
      return true;
    }
    if (typeof nm === "string") {
      return symbols.get(nm)?.kind === "eoa";
    }
  }
  if (t === "FunctionCall") {
    const callee = (expr as Record<string, unknown>)["expression"];
    const cn = (callee as Record<string, unknown>)["name"];
    if (cn === "makeAddr" || cn === "address") {
      return true;
    }
  }
  return false;
}

/** vm.deal recipient must be an EOA actor, never the target / a deployed instance. */
function checkVmDealRecipients(
  body: unknown,
  deployedVar: string,
  symbols: Map<string, Sym>,
): string | null {
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
    const recip = argsList[0];
    if (
      recip === undefined ||
      referencesDeployed(recip, deployedVar) ||
      !isEoaExpression(recip, symbols)
    ) {
      problem =
        "vm.deal recipient is not a proven EOA actor (must not be the target / a deployed instance)";
    }
  });
  return problem;
}

/** True when an expression references the deployed target var (directly or via
 * address(...)/payable(...) wrappers). */
function referencesDeployed(expr: unknown, deployedVar: string): boolean {
  let hit = false;
  walk(expr, (n) => {
    if (nodeType(n) === "Identifier" && (n as Record<string, unknown>)["name"] === deployedVar) {
      hit = true;
    }
  });
  // walk skips the root when it is the identifier itself; handle that:
  if (
    nodeType(expr) === "Identifier" &&
    (expr as Record<string, unknown>)["name"] === deployedVar
  ) {
    hit = true;
  }
  return hit;
}

/** Any `new X` (target or closure contract) that is NOT the single top-level
 * deploy — defensive against constructing extra instances mid-expression. */
function findStrayNew(
  body: unknown,
  targetSymbol: string,
  closureNames: Set<string>,
): string | null {
  const news: string[] = [];
  walk(body, (n) => {
    if (nodeType(n) === "NewExpression") {
      const tn = (n as Record<string, unknown>)["typeName"];
      const nm =
        tn !== null && typeof tn === "object"
          ? (tn as Record<string, unknown>)["namePath"]
          : undefined;
      news.push(typeof nm === "string" ? nm : "");
    }
  });
  for (const nm of news) {
    if (nm !== targetSymbol && !closureNames.has(nm)) {
      return `\`new ${nm}\` is not the target or a cited closure contract`;
    }
  }
  if (news.filter((nm) => nm === targetSymbol).length !== 1) {
    return null; // deploy-count enforced by caller
  }
  return null;
}

/** Resolve a function's mutability over the target's inheritance closure. */
function resolveMutability(
  contractName: string,
  fnName: string,
  closureAstByPath: ReadonlyMap<string, ClosureAst>,
  seen = new Set<string>(),
): string | null | undefined {
  if (seen.has(contractName)) {
    return undefined;
  }
  seen.add(contractName);
  for (const ast of closureAstByPath.values()) {
    const decl = ast.contracts.find((c) => c.name === contractName);
    if (decl === undefined) {
      continue;
    }
    if (decl.functions.has(fnName)) {
      return decl.functions.get(fnName) ?? null; // null = nonpayable/mutating
    }
    for (const base of decl.bases) {
      const m = resolveMutability(base, fnName, closureAstByPath, seen);
      if (m !== undefined) {
        return m;
      }
    }
  }
  return undefined; // unresolved
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
        typeof fnName === "string"
      ) {
        const mut = resolveMutability(pocTarget.symbol, fnName, closureAstByPath);
        if (mut === null || mut === "payable") {
          driveHere = true; // nonpayable or payable = state-mutating
        }
      }
    });
    if (driveHere) {
      return i;
    }
  }
  return -1;
}

/** Whether some statement after the drive contains an `assert*` whose argument
 * data-depends on a post-drive read of the deployed target. */
function hasBoundAssertion(statements: unknown[], driveIdx: number, deployedVar: string): boolean {
  // Track locals assigned from a target read at/after the drive.
  const targetDerived = new Set<string>();
  for (let i = driveIdx; i < statements.length; i++) {
    const decl = varDeclInit(statements[i]);
    if (decl !== null && exprReadsTarget(decl.init, deployedVar, targetDerived)) {
      targetDerived.add(decl.name);
    }
    // Assertions in this statement.
    let bound = false;
    walk(statements[i], (n) => {
      if (bound || nodeType(n) !== "FunctionCall") {
        return;
      }
      const callee = (n as Record<string, unknown>)["expression"];
      const name =
        nodeType(callee) === "Identifier" ? (callee as Record<string, unknown>)["name"] : undefined;
      if (typeof name !== "string" || !name.startsWith("assert")) {
        return;
      }
      if (
        name === "assertTrue" &&
        isConstantTrue(asArray((n as Record<string, unknown>)["arguments"])[0])
      ) {
        return; // assertTrue(true) never binds
      }
      for (const arg of asArray((n as Record<string, unknown>)["arguments"])) {
        if (i > driveIdx && exprReadsTarget(arg, deployedVar, targetDerived)) {
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

/** True when an expression reads the deployed target (a `<var>.g(...)` call or a
 * var previously derived from one), excluding deployment-only reads. */
function exprReadsTarget(expr: unknown, deployedVar: string, derived: Set<string>): boolean {
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
          mn !== undefined
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
    // deployment-only reads (address(t) / t.code / balances) do NOT count as
    // reading target *state*; they never set `reads` because they are not
    // `<var>.<method>()` calls.
  };
  check(expr);
  walk(expr, check);
  return reads;
}

function isConstantTrue(arg: unknown): boolean {
  return nodeType(arg) === "BooleanLiteral" && (arg as Record<string, unknown>)["value"] === true;
}
