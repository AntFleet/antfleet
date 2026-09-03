import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  detectForbiddenCheats,
  dockerPocExecutor,
  findTargetDeployment,
  parseForgeSummary,
  targetFrameInTrace,
} from "./poc-executor.js";

// --- Pure parser unit tests (real forge output shapes) ----------------------

const PASS_TRACE = `Compiling 1 files with Solc 0.8.28
Compiler run successful!
Ran 1 test for test/AuditPoc_Poc.t.sol:AuditPoc
[PASS] testAuditPoc() (gas: 152291)
Traces:
  [152291] AuditPoc::testAuditPoc()
    ├─ [92539] → new Vault@0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f
    │   └─ ← [Return] 462 bytes of code
    ├─ [22733] Vault::deposit(100)
    │   └─ ← [Stop]
    ├─ [424] Vault::balance() [staticcall]
    │   └─ ← [Return] 100
    ├─ [0] VM::assertEq(100, 100) [staticcall]
    │   └─ ← [Return]
    └─ ← [Stop]
Suite result: ok. 1 passed; 0 failed; 0 skipped; finished in 241.29µs`;

describe("parseForgeSummary", () => {
  it("parses a passing suite", () => {
    const s = parseForgeSummary(PASS_TRACE);
    expect(s).toMatchObject({
      compiled: true,
      ranTests: 1,
      passedTests: 1,
      failedTests: 0,
      skippedTests: 0,
    });
  });
  it("parses a failing suite", () => {
    const s = parseForgeSummary(
      "Suite result: FAILED. 0 passed; 1 failed; 0 skipped; finished in 1ms",
    );
    expect(s).toMatchObject({ passedTests: 0, failedTests: 1 });
  });
  it("detects a compilation failure (no suite result)", () => {
    const s = parseForgeSummary("Error (2314): Expected identifier\n --> src/Vault.sol:3:5");
    expect(s.compiled).toBe(false);
  });
});

describe("findTargetDeployment", () => {
  it("finds the unique target CREATE address", () => {
    expect(findTargetDeployment(PASS_TRACE, "Vault")).toBe(
      "0x5615deb798bb3e4dfa0139dfa1b3d433cc23b72f",
    );
  });
  it("returns null when the target is not deployed", () => {
    expect(findTargetDeployment(PASS_TRACE, "OtherThing")).toBeNull();
  });
  it("returns null on ambiguous (>1) deployments", () => {
    const t = `new Vault@0x1111111111111111111111111111111111111111\nnew Vault@0x2222222222222222222222222222222222222222`;
    expect(findTargetDeployment(t, "Vault")).toBeNull();
  });
});

describe("targetFrameInTrace", () => {
  const addr = "0x5615deb798bb3e4dfa0139dfa1b3d433cc23b72f";
  it("observes a non-static in-body target frame and marks drove", () => {
    const r = targetFrameInTrace(PASS_TRACE, addr);
    // the deposit() call is a non-static frame at the target
    expect(r.observed).toBe(true);
    expect(r.drove).toBe(true);
  });
  it("does not observe a STATICCALL-only target frame", () => {
    const staticOnly = `  [424] Vault::balance() [staticcall] ${addr}`;
    expect(targetFrameInTrace(staticOnly, addr).observed).toBe(false);
  });
});

describe("detectForbiddenCheats", () => {
  const addr = "0x5615deb798bb3e4dfa0139dfa1b3d433cc23b72f";
  it("passes a clean trace (assertions/state cheats allowed)", () => {
    const t = `VM::assertEq(100, 100)\nVM::prank(0xabc)\nVM::warp(1)\nVM::deal(0xEOA, 1)`;
    expect(detectForbiddenCheats(t, addr)).toBeNull();
  });
  it("rejects a fabrication cheat (vm.store)", () => {
    expect(detectForbiddenCheats("VM::store(0x..., 0x0, 0x1f4)", addr)).toMatch(
      /store|fabrication/,
    );
  });
  it("rejects deal to the deployed target", () => {
    const t = `VM::deal(${addr}, 1000000000000000000)`;
    expect(detectForbiddenCheats(t, addr)).toMatch(/deal|target/);
  });
  it("allows deal to a non-target EOA", () => {
    expect(
      detectForbiddenCheats("VM::deal(0x00000000000000000000000000000000000000aa, 1)", addr),
    ).toBeNull();
  });
});

// --- Docker + forge integration (guarded) -----------------------------------

function toolingAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    execFileSync("docker", ["image", "inspect", "antfleet-poc-exec:local"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const HAVE_TOOLING = toolingAvailable();

describe("dockerPocExecutor — sandboxed integration", () => {
  let fixture = "";
  const H = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {Test} from "forge-std/Test.sol";
import {Vault} from "src/Vault.sol";
`;
  const exec = dockerPocExecutor({ image: "antfleet-poc-exec:local" });
  const runPoc = (body: string) =>
    exec({
      targetRoot: fixture,
      testContents: `${H}contract AuditPoc is Test { function testAuditPoc() public { ${body} } }`,
      pocTarget: { path: "src/Vault.sol", symbol: "Vault" },
      timeoutMs: 180_000,
    });

  beforeAll(() => {
    if (!HAVE_TOOLING) return;
    fixture = mkdtempSync(path.join(tmpdir(), "poc-fixture-"));
    mkdirSync(path.join(fixture, "src"), { recursive: true });
    writeFileSync(
      path.join(fixture, "foundry.toml"),
      `[profile.default]\nsrc = "src"\nout = "out"\nlibs = ["lib"]\n`,
    );
    writeFileSync(
      path.join(fixture, "src", "Vault.sol"),
      `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\ncontract Vault { uint256 public balance; function deposit(uint256 a) external { balance += a; } function drain() external { balance = 0; } }\n`,
    );
  });
  afterAll(() => {
    if (fixture) rmSync(fixture, { recursive: true, force: true });
  });

  it.skipIf(!HAVE_TOOLING)(
    "runs a genuine PoC → executed+passed+drove+targetFrame, deployedTargetPath bound",
    () => {
      const r = runPoc(`Vault t = new Vault(); t.deposit(100); assertEq(t.balance(), 100);`);
      expect(r).toMatchObject({
        executed: true,
        compiled: true,
        passed: true,
        drove: true,
        targetFrameObserved: true,
        deployedTargetPath: "src/Vault.sol",
      });
    },
  );

  it.skipIf(!HAVE_TOOLING)("a failing assertion → executed but not passed", () => {
    const r = runPoc(`Vault t = new Vault(); t.deposit(1); assertEq(t.balance(), 999);`);
    expect(r.executed).toBe(true);
    expect(r.passed).toBe(false);
  });

  it.skipIf(!HAVE_TOOLING)(
    "a vm.store storage-fabrication → rejected by the cheatcode-CALL detector",
    () => {
      const r = runPoc(
        `Vault t = new Vault(); vm.store(address(t), bytes32(0), bytes32(uint256(500))); assertEq(t.balance(), 500);`,
      );
      expect(r.passed).toBe(false);
      expect(r.reason).toMatch(/fabrication|store/);
    },
  );

  it.skipIf(!HAVE_TOOLING)("a deal-to-target balance fabrication → rejected", () => {
    const r = runPoc(
      `Vault t = new Vault(); vm.deal(address(t), 1 ether); assertEq(address(t).balance, 1 ether);`,
    );
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/deal|target/);
  });
});
