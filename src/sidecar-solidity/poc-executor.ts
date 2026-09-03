// Phase-2 executor — the `PocExecutor` interface + `dockerPocExecutor` that runs a
// generated PoC in a locked-down Docker sandbox and returns the runtime evidence
// `wouldPromotePoc`/`promoteWithPoc` consume (SOLIDITY_SIDECAR_POC_SPEC.md §3.4).
//
// Security model: the audited repo is UNTRUSTED. Every run is `docker run
// --network none --user <non-root> --read-only` with `ffi=false`, a fixed
// non-model argv (the model supplies only the test body), resource + timeout
// caps, and the assertion/cheat framework sourced ONLY from the pinned image
// (never the repo). The executor CATCHES all infra failures and returns
// `{executed:false, reason}` — it never throws.
//
// This module splits into PURE parsers (summary / trace / cheatcode analysis,
// unit-tested against captured real forge output) and the thin Docker wrapper.

import { spawnSync } from "node:child_process";
import {
  type Dirent,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { PocDriveKind, PocExecution } from "./poc.js";
import type { ExecutePocCallback } from "./run.js";

// --- Types ------------------------------------------------------------------

/** The full execution result surfaced by the executor (superset of `PocExecution`
 * with the raw forge counts + a bounded, redacted summary). */
export type PocExecResult = PocExecution & {
  ranTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  exitCode: number;
  summary: string;
};

export type PocExecArgs = {
  /** The audited repo root (untrusted). */
  targetRoot: string;
  /** The generated PoC test source. */
  testContents: string;
  /** The resolved cited target (its repo-relative `path` is the identity comparand). */
  pocTarget: { path: string; symbol: string };
  /** The single top-level drive span for a harness PoC (§3.3.B B5); undefined on the
   * static path. Present-and-used to scope `targetFrameObserved`. */
  harnessDriveSpan?: { start: number; end: number } | undefined;
  /** Milliseconds; the executor kills the container on expiry. */
  timeoutMs: number;
};

export type PocExecutor = (args: PocExecArgs) => PocExecution;

/** The HEVM cheatcode precompile address (lowercased). */
const HEVM_ADDRESS = "0x7109709ecfa91a80626ff3989d68f67f5b1dd12d";

/** The FABRICATION cheat denylist (§3.4 cheatcode-CALL detector). forge renders EVERY
 * forge-std assertion + helper as a `VM::<cheat>` call in the trace (assertEq, label,
 * …), so a bare allowlist of state cheats would reject legitimate assertions; the
 * security-meaningful check is to reject the fabrication family — storage/bytecode/mock
 * seeding, host escape, and `deal`-to-target (handled separately). `deal` to an EOA and
 * the prank/warp/roll state cheats + the whole `assert*` family stay allowed. */
const FABRICATION_CHEATS = new Set([
  "store",
  "load",
  "etch",
  "mockCall",
  "mockCallRevert",
  "mockFunction",
  "deployCode",
  "getCode",
  "getDeployedCode",
  "ffi",
  "sign",
  "signP256",
  "readFile",
  "writeFile",
  "readLine",
  "writeLine",
  "closeFile",
  "removeFile",
  "setEnv",
]);

const NON_EXEC = (reason: string): PocExecution => ({
  executed: false,
  compiled: false,
  passed: false,
  drove: false,
  targetFrameObserved: false,
  deployedTargetPath: null,
  driveKind: null,
  reason,
});

// --- Pure parsers (unit-tested against real forge output) -------------------

/** Parse forge's `Suite result` / `Test result` summary line(s) into counts. */
export function parseForgeSummary(stdout: string): {
  compiled: boolean;
  ranTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
} {
  // Compilation failure: forge prints a solc error and no suite result.
  const compileFailed =
    /Compiler run failed|Error \(\d+\):|Discovered incompatible solidity versions/i.test(stdout) &&
    !/Suite result:/i.test(stdout);
  let ran = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  // "Suite result: ok. 1 passed; 0 failed; 0 skipped; finished in ..."
  const re = /Suite result:.*?(\d+)\s+passed;\s*(\d+)\s+failed;\s*(\d+)\s+skipped/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout)) !== null) {
    passed += Number(m[1]);
    failed += Number(m[2]);
    skipped += Number(m[3]);
  }
  ran = passed + failed + skipped;
  return {
    compiled: !compileFailed,
    ranTests: ran,
    passedTests: passed,
    failedTests: failed,
    skippedTests: skipped,
  };
}

/** A cheatcode-CALL detector verdict: `null` = clean; else the rejection reason. */
export function detectForbiddenCheats(trace: string, targetAddress: string | null): string | null {
  // Scan every call INTO the HEVM precompile for a non-allowlisted selector. forge
  // -vvvv renders cheats as `VM::<cheat>(...)`; we also catch a raw call to the
  // precompile address as belt-and-braces.
  const vmCall = /VM::(\w+)\(/g;
  let m: RegExpExecArray | null;
  while ((m = vmCall.exec(trace)) !== null) {
    const cheat = m[1] ?? "";
    if (FABRICATION_CHEATS.has(cheat)) {
      return `fabrication cheat VM::${cheat} (cheatcode-fabrication)`;
    }
    // `deal` recipient re-validation: reject deal to the deployed target — a doctored
    // scaffold's `vm.deal(address(target), …)` fabricates the target's ETH balance (§3.4).
    if (cheat === "deal" && targetAddress !== null) {
      const close = trace.indexOf(")", m.index);
      const callText = trace.slice(m.index, close === -1 ? m.index : close + 1).toLowerCase();
      if (callText.includes(targetAddress.toLowerCase())) {
        return "deal recipient resolves to the deployed target (balance fabrication)";
      }
    }
  }
  if (targetAddress !== null && new RegExp(HEVM_ADDRESS, "i").test(trace)) {
    // A raw precompile call not rendered as VM:: — conservative reject.
    return "raw call into the HEVM cheatcode precompile";
  }
  return null;
}

/** Locate the target contract's deployment (CREATE/CREATE2) in the `-vvvv` trace and
 * return its deployed address. forge renders a deploy as `→ new <Symbol>@0x…` or
 * `[…] → new <Symbol>@0x…`. Ambiguity (0 or >1) → null (fail closed). */
export function findTargetDeployment(trace: string, targetSymbol: string): string | null {
  const re = new RegExp(`new\\s+${escapeRe(targetSymbol)}@(0x[0-9a-fA-F]{40})`, "g");
  const addrs = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(trace)) !== null) {
    if (m[1]) addrs.add(m[1].toLowerCase());
  }
  return addrs.size === 1 ? [...addrs][0]! : null;
}

/** Whether a non-STATICCALL frame at `targetAddress` appears anywhere in the trace
 * (the coarse `targetFrameObserved`; the exact-span scoping is a §3.4 refinement).
 * A STATICCALL-only appearance does not count. */
export function targetFrameInTrace(
  trace: string,
  targetAddress: string,
): {
  observed: boolean;
  drove: boolean;
} {
  if (targetAddress === "") {
    return { observed: false, drove: false };
  }
  const lower = trace.toLowerCase();
  const addr = targetAddress.toLowerCase();
  let observed = false;
  let drove = false;
  for (const line of lower.split("\n")) {
    if (!line.includes(addr)) {
      continue;
    }
    const isStatic = line.includes("[staticcall]") || line.includes("::staticcall");
    if (!isStatic) {
      observed = true;
      // A direct call rendered with the target address as the callee root (a
      // top-level `Target::method` in the test body) implies `drove`.
      if (/\b(call|new)\b/.test(line) || line.includes("::")) {
        drove = true;
      }
    }
  }
  return { observed, drove };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

// --- Build-info identity ----------------------------------------------------

/** Map the deployed target to its artifact source path via forge's build output
 * (`out/<File>.sol/<Symbol>.json` records `ast.absolutePath` / metadata). Returns a
 * repo-relative POSIX path or null (fail closed on ambiguity). §3.4 build-info identity.
 * A first-cut name+artifact match; the metadata-stripped bytecode compare that
 * defeats same-name collisions is a documented refinement. */
export function resolveDeployedTargetPath(
  scratchRoot: string,
  targetSymbol: string,
): string | null {
  const outDir = path.join(scratchRoot, "out");
  if (!existsSync(outDir)) {
    return null;
  }
  const hits: string[] = [];
  walkJson(outDir, (file) => {
    if (path.basename(file) !== `${targetSymbol}.json`) {
      return;
    }
    try {
      const art = JSON.parse(readFileSync(file, "utf8")) as {
        ast?: { absolutePath?: string };
        metadata?: { settings?: { compilationTarget?: Record<string, string> } };
      };
      const abs = art.ast?.absolutePath;
      const ct = art.metadata?.settings?.compilationTarget;
      const fromMeta = ct ? Object.keys(ct)[0] : undefined;
      const src = abs ?? fromMeta;
      if (src) {
        hits.push(toPosixRepoRel(src));
      }
    } catch {
      /* skip unreadable artifact */
    }
  });
  const uniq = [...new Set(hits)];
  return uniq.length === 1 ? uniq[0]! : null;
}

function toPosixRepoRel(p: string): string {
  return p.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function walkJson(dir: string, visit: (file: string) => void): void {
  for (const entry of safeReaddir(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJson(full, visit);
    } else if (entry.isFile() && full.endsWith(".json")) {
      visit(full);
    }
  }
}

function safeReaddir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// --- Scratch assembly -------------------------------------------------------

/** The fixed test-file slug. Per-finding slugging (a distinct file per PoC) is a
 * §3.4 refinement; a single fixed name is correct because each run gets its own
 * throwaway scratch. */
function pocSlug(): string {
  return "Poc";
}

/** Copy only `.sol` sources + `foundry.toml`/`remappings.txt` from the untrusted repo
 * into a throwaway scratch dir. Non-`.sol` files (`.env*`, keys, `*.json`, `.git`) are
 * NEVER copied — a compiler diagnostic cannot echo their contents (§3.4). */
export function assembleScratch(targetRoot: string, testContents: string): string {
  const scratch = mkdtempSync(path.join(tmpdir(), "poc-exec-"));
  cpSync(targetRoot, scratch, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      if (base === ".git" || base === "node_modules" || base === "out" || base === "cache") {
        return false;
      }
      // directories: allow (so we can descend); files: only .sol + foundry config.
      let isDir = false;
      try {
        isDir = statSync(src).isDirectory();
      } catch {
        return false;
      }
      if (isDir) {
        return true;
      }
      return base.endsWith(".sol") || base === "foundry.toml" || base === "remappings.txt";
    },
  });
  const testDir = path.join(scratch, "test");
  mkdirSync(testDir, { recursive: true });
  writeFileSync(path.join(testDir, `AuditPoc_${pocSlug()}.t.sol`), testContents, "utf8");
  return scratch;
}

// --- The Docker executor ----------------------------------------------------

export type DockerPocExecutorOptions = {
  /** The pinned image (`antfleet-poc-exec@sha256:…` in prod; `:local` in dev/CI). */
  image: string;
  /** Override the docker binary (tests may inject a stub). */
  dockerBin?: string;
};

/** Build a `PocExecutor` that runs the PoC in the locked-down sandbox and returns the
 * §3.4 runtime evidence. Catches ALL infra failures → `{executed:false}`; never throws. */
export function dockerPocExecutor(opts: DockerPocExecutorOptions): PocExecutor {
  const docker = opts.dockerBin ?? "docker";
  return (args: PocExecArgs): PocExecution => {
    let scratch: string | null = null;
    try {
      scratch = assembleScratch(args.targetRoot, args.testContents);
      // Force-safe foundry config: ffi off, no fs perms, forge-std from the image.
      writeFoundryOverride(scratch);
      // The container runs as a non-root uid that does not own the host-created scratch;
      // make the throwaway tree writable so forge can emit out/cache. Safe: the scratch
      // holds only copied .sol (no secrets — assembleScratch filtered) and is isolated
      // (`--network none`, removed in `finally`).
      spawnSync("chmod", ["-R", "0777", scratch], { timeout: 30_000 });
      const testGlob = `test/AuditPoc_${pocSlug()}.t.sol`;
      const run = spawnSync(
        docker,
        [
          "run",
          "--rm",
          "--network",
          "none",
          "--user",
          "10001",
          "--cpus=2",
          "--memory=2g",
          "--pids-limit=256",
          "--read-only",
          "--tmpfs",
          "/tmp",
          "-v",
          `${scratch}:/work:rw`,
          "-w",
          "/work",
          "--env-file",
          "/dev/null",
          // Force-safe foundry settings via env overrides (clean — no TOML surgery):
          // ffi off and no fs access regardless of what the untrusted repo config says.
          "-e",
          "FOUNDRY_FFI=false",
          "-e",
          "FOUNDRY_FS_PERMISSIONS=[]",
          // HOME points at the image's world-readable solc cache (`/opt/svmhome/.svm`)
          // so offline runs resolve solc under a read-only root; forge's writable cache
          // goes to the tmpfs. The audited repo's compile output lands under /work.
          "-e",
          "HOME=/opt/svmhome",
          "-e",
          "FOUNDRY_CACHE_DIR=/tmp/fc",
          "--entrypoint",
          "forge",
          opts.image,
          "test",
          "--match-path",
          testGlob,
          // forge matches --match-test against the full signature `testAuditPoc()`,
          // so anchor to that exact form (a bare `^testAuditPoc$` finds nothing).
          "--match-test",
          "^testAuditPoc\\(\\)$",
          "-vvvv",
        ],
        { encoding: "utf8", timeout: args.timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      );
      if (run.error) {
        return NON_EXEC(`executor error: ${redact(String(run.error.message ?? run.error))}`);
      }
      const stdout = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
      const summary = parseForgeSummary(stdout);
      if (!summary.compiled) {
        return {
          ...NON_EXEC("deps unavailable / did not compile"),
          executed: true,
          compiled: false,
        };
      }
      const targetAddr = findTargetDeployment(stdout, args.pocTarget.symbol);
      const cheatReason = detectForbiddenCheats(stdout, targetAddr);
      if (cheatReason !== null) {
        return { ...NON_EXEC(cheatReason), executed: true, compiled: true };
      }
      const deployedTargetPath = resolveDeployedTargetPath(scratch, args.pocTarget.symbol);
      const frame =
        targetAddr === null
          ? { observed: false, drove: false }
          : targetFrameInTrace(stdout, targetAddr);
      const passed =
        summary.passedTests === 1 && summary.failedTests === 0 && summary.skippedTests === 0;
      const driveKind: PocDriveKind | null = frame.observed
        ? frame.drove
          ? "direct-revert"
          : "callback"
        : null;
      return {
        executed: true,
        compiled: true,
        passed,
        drove: frame.drove,
        targetFrameObserved: frame.observed,
        deployedTargetPath,
        driveKind,
        reason: passed
          ? ""
          : `forge: ${redact(summary.ranTests === 0 ? "no tests ran" : "assertion did not hold")}`,
      };
    } catch (err) {
      return NON_EXEC(
        `executor error: ${redact(err instanceof Error ? err.message : String(err))}`,
      );
    } finally {
      if (scratch !== null) {
        try {
          rmSync(scratch, { recursive: true, force: true });
        } catch {
          /* best-effort scratch cleanup */
        }
      }
    }
  };
}

/** Pin forge-std to the image's TRUSTED copy: drop any repo remapping of `forge-std/`
 * and point it at `/opt/forge-std/src/` in the image, so a repo that remaps
 * `forge-std/` to a no-op `assertEq` cannot mint a hollow verdict (§3.4). ffi /
 * fs_permissions are forced off via env overrides at the docker layer (no TOML
 * surgery — a duplicated `[profile.default]` breaks forge). */
function writeFoundryOverride(scratch: string): void {
  const remPath = path.join(scratch, "remappings.txt");
  const rem = existsSync(remPath)
    ? readFileSync(remPath, "utf8")
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("forge-std/"))
        .join("\n")
    : "";
  writeFileSync(remPath, `${rem}\nforge-std/=/opt/forge-std/src/\n`, "utf8");
}

/** Bound + strip a forge/exec message for safe surfacing (no secrets/keys). */
function redact(s: string): string {
  return s
    .replace(/0x[0-9a-fA-F]{40,}/g, "0x…")
    .replace(/(key|secret|token|password)\S*/gi, "$1…")
    .slice(0, 400);
}

/** Adapt `dockerPocExecutor` to the `ExecutePocCallback` contract (§4 wiring): bind
 * the audited repo root + image + timeout; map the finder's `PocTarget`/
 * `harnessDriveSpan` onto the executor's args. The callback is async by contract;
 * the underlying run is synchronous (`spawnSync`) and never throws. */
export function makeDockerExecutePoc(opts: {
  image: string;
  targetRoot: string;
  timeoutMs?: number;
  dockerBin?: string;
}): ExecutePocCallback {
  const exec = dockerPocExecutor(
    opts.dockerBin === undefined
      ? { image: opts.image }
      : { image: opts.image, dockerBin: opts.dockerBin },
  );
  return (args) =>
    Promise.resolve(
      exec({
        targetRoot: opts.targetRoot,
        testContents: args.testContents,
        pocTarget: { path: args.pocTarget.path, symbol: args.pocTarget.symbol },
        harnessDriveSpan:
          args.harnessDriveSpan === undefined
            ? undefined
            : { start: args.harnessDriveSpan.start, end: args.harnessDriveSpan.end },
        timeoutMs: opts.timeoutMs ?? 900_000,
      }),
    );
}
