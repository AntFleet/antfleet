import { describe, it, expect } from "vitest";
import {
  parseClosureFile,
  resolvePocTarget,
  staticGatePoc,
  promoteWithPoc,
  type ClosureAst,
  type PocTarget,
  type PocRecord,
} from "./poc.js";
import type { PromotionDecision } from "./scoring.js";

const TARGET_SRC = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
contract Vault {
    uint256 public total;
    function deposit(uint256 amt) external { total += amt; }
    function drain() external { total = 0; }
    function resetAndReturn() external returns (uint256) { total = 0; return total; }
    function balance() external view returns (uint256) { return total; }
}
`;

const VAULT_PATH = "src/Vault.sol";

function closure(extra: Record<string, string> = {}): Map<string, ClosureAst> {
  const map = new Map<string, ClosureAst>();
  for (const [path, src] of [[VAULT_PATH, TARGET_SRC], ...Object.entries(extra)] as [
    string,
    string,
  ][]) {
    const ast = parseClosureFile(path, src);
    if (ast !== null) {
      map.set(path, ast);
    }
  }
  return map;
}

const TARGET: PocTarget = {
  path: VAULT_PATH,
  symbol: "Vault",
  kind: "contract",
  derivation: "test",
};

const HEADER = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
import {Test} from "forge-std/Test.sol";
import {Vault} from "src/Vault.sol";
`;

/** Wrap a straight-line testAuditPoc body into a full valid-shape file. */
function poc(body: string): string {
  return `${HEADER}contract AuditPoc is Test {
    function testAuditPoc() public {
${body}
    }
}
`;
}

const VALID = poc(`        Vault t = new Vault();
        t.deposit(100);
        uint256 b = t.balance();
        assertEq(b, 0);`);

function gate(src: string) {
  return staticGatePoc(src, { evidence: [] }, TARGET, closure());
}

describe("resolvePocTarget", () => {
  it("resolves the enclosing concrete contract at the cited line", () => {
    const t = resolvePocTarget(
      { evidence: [{ path: VAULT_PATH, startLine: 4, endLine: 4, symbol: "Vault", quote: null }] },
      { entries: [VAULT_PATH] },
      closure(),
    );
    expect(t?.symbol).toBe("Vault");
    expect(t?.path).toBe(VAULT_PATH);
  });

  it("declines interface-only evidence (no concrete deployable target)", () => {
    const IFACE = `pragma solidity ^0.8.0;\ninterface IThing { function f() external; }\n`;
    const t = resolvePocTarget(
      {
        evidence: [
          { path: "src/IThing.sol", startLine: 2, endLine: 2, symbol: "IThing", quote: null },
        ],
      },
      { entries: ["src/IThing.sol"] },
      closure({ "src/IThing.sol": IFACE }),
    );
    expect(t).toBeNull();
  });

  it("declines when two entries declare the same concrete symbol (ambiguous)", () => {
    const A = `pragma solidity ^0.8.0;\ncontract Dup { function f() external {} }\n`;
    const B = `pragma solidity ^0.8.0;\ncontract Dup { function g() external {} }\n`;
    const t = resolvePocTarget(
      { evidence: [{ path: "x", startLine: null, endLine: null, symbol: "Dup", quote: null }] },
      { entries: ["a/Dup.sol", "b/Dup.sol"] },
      closure({ "a/Dup.sol": A, "b/Dup.sol": B }),
    );
    expect(t).toBeNull();
  });
});

describe("staticGatePoc — a valid local-deploy PoC passes", () => {
  it("passes and yields a PocBinding", () => {
    const r = gate(VALID);
    expect(r.passed, r.reasons.join(" | ")).toBe(true);
    expect(r.binding?.deployedVar).toBe("t");
    expect(r.binding?.targetSymbol).toBe("Vault");
  });
});

describe("staticGatePoc — rejections", () => {
  const reject = (label: string, src: string) =>
    it(label, () => {
      const r = gate(src);
      expect(r.passed, `expected reject; reasons: ${r.reasons.join(" | ")}`).toBe(false);
    });

  reject(
    "vm.store fabrication",
    poc(`        Vault t = new Vault();
        vm.store(address(t), bytes32(0), bytes32(uint256(1)));
        t.deposit(1);
        uint256 b = t.balance();
        assertEq(b, 0);`),
  );

  reject(
    "vm.etch fabrication",
    poc(`        Vault t = new Vault();
        vm.etch(address(t), hex"00");
        t.deposit(1);
        uint256 b = t.balance();
        assertEq(b, 0);`),
  );

  reject(
    "bare StdCheats deal(token,...)",
    poc(`        Vault t = new Vault();
        deal(address(1), address(2), 100);
        t.deposit(1);
        uint256 b = t.balance();
        assertEq(b, 0);`),
  );

  reject(
    "vm.deal to the target instance",
    poc(`        Vault t = new Vault();
        vm.deal(address(t), 1 ether);
        t.deposit(1);
        uint256 b = t.balance();
        assertEq(b, 0);`),
  );

  reject(
    "inline assembly",
    poc(`        Vault t = new Vault();
        assembly { pop(0) }
        t.deposit(1);
        uint256 b = t.balance();
        assertEq(b, 0);`),
  );

  reject(
    "low-level call",
    poc(`        Vault t = new Vault();
        (bool ok, ) = address(t).call("");
        ok;
        uint256 b = t.balance();
        assertEq(b, 0);`),
  );

  reject(
    "type(X).creationCode",
    poc(`        Vault t = new Vault();
        bytes memory c = type(Vault).creationCode;
        c;
        uint256 b = t.balance();
        assertEq(b, 0);`),
  );

  reject(
    "HEVM cheatcode address literal",
    poc(`        Vault t = new Vault();
        address h = 0x7109709ECfa91a80626fF3989D68f67F5b1DD12D;
        h;
        uint256 b = t.balance();
        assertEq(b, 0);`),
  );

  reject(
    "a bespoke test-authored contract",
    `${HEADER}contract Fake { function price() external pure returns (uint256){ return 1; } }
contract AuditPoc is Test {
    function testAuditPoc() public {
        Vault t = new Vault();
        Fake f = new Fake();
        f;
        t.deposit(1);
        uint256 b = t.balance();
        assertEq(b, 0);
    }
}
`,
  );

  reject(
    "a helper function declaration",
    `${HEADER}contract AuditPoc is Test {
    function helper() internal pure returns (uint256){ return 1; }
    function testAuditPoc() public {
        Vault t = new Vault();
        t.deposit(1);
        uint256 b = t.balance();
        assertEq(b, 0);
    }
}
`,
  );

  reject(
    "an if statement (not straight-line)",
    poc(`        Vault t = new Vault();
        t.deposit(1);
        uint256 b = t.balance();
        if (b == 0) { assertEq(b, 0); }`),
  );

  reject(
    "a for loop",
    poc(`        Vault t = new Vault();
        for (uint256 i; i < 2; i++) { t.deposit(1); }
        uint256 b = t.balance();
        assertEq(b, 0);`),
  );

  reject(
    "a ternary",
    poc(`        Vault t = new Vault();
        t.deposit(1);
        uint256 b = t.balance();
        uint256 c = b == 0 ? 1 : 2;
        assertEq(c, 1);`),
  );

  reject(
    "an early return",
    poc(`        Vault t = new Vault();
        t.deposit(1);
        return;`),
  );

  reject(
    "a forbidden forge-std import (StdCheats)",
    `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
import {Test} from "forge-std/Test.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {Vault} from "src/Vault.sol";
contract AuditPoc is Test {
    function testAuditPoc() public {
        Vault t = new Vault();
        t.deposit(1);
        uint256 b = t.balance();
        assertEq(b, 0);
    }
}
`,
  );

  reject(
    "an out-of-allowlist import",
    `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
import {Test} from "forge-std/Test.sol";
import {Vault} from "src/Vault.sol";
import {Other} from "src/Other.sol";
contract AuditPoc is Test {
    function testAuditPoc() public {
        Vault t = new Vault();
        t.deposit(1);
        uint256 b = t.balance();
        assertEq(b, 0);
    }
}
`,
  );

  reject(
    "a same-name stub imported from another path",
    `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
import {Test} from "forge-std/Test.sol";
import {Vault} from "test/mocks/Vault.sol";
contract AuditPoc is Test {
    function testAuditPoc() public {
        Vault t = new Vault();
        t.deposit(1);
        uint256 b = t.balance();
        assertEq(b, 0);
    }
}
`,
  );

  reject(
    "a view-only 'drive'",
    poc(`        Vault t = new Vault();
        uint256 b = t.balance();
        assertEq(b, 0);`),
  );

  reject(
    "a deployment-only assertion",
    poc(`        Vault t = new Vault();
        t.deposit(1);
        assertTrue(address(t) != address(0));`),
  );

  reject(
    "assertTrue(true)",
    poc(`        Vault t = new Vault();
        t.deposit(1);
        assertTrue(true);`),
  );

  reject(
    "no deploy of the target",
    poc(`        uint256 b = uint256(1);
        assertEq(b, 1);`),
  );

  // --- audit round: adversarial bypasses (3-lane codex impl audit) ---
  reject(
    "vm.deal to a target-derived local",
    poc(`        Vault t = new Vault();
        address a = address(t);
        vm.deal(a, 1 ether);
        t.deposit(1);
        uint256 b = t.balance();
        assertEq(b, 0);`),
  );

  reject(
    "vm.deal transitively target-derived",
    poc(`        Vault t = new Vault();
        address a = address(uint160(address(t)));
        vm.deal(a, 1 ether);
        t.deposit(1);
        uint256 b = t.balance();
        assertEq(b, 0);`),
  );

  reject(
    "vm.deal 3-arg token-balance overload",
    poc(`        Vault t = new Vault();
        vm.deal(address(2), address(3), 100);
        t.deposit(1);
        uint256 b = t.balance();
        assertEq(b, 0);`),
  );

  reject(
    "bound Vm alias .store()",
    poc(`        Vault t = new Vault();
        Vm z = vm;
        z.store(address(t), bytes32(0), bytes32(uint256(1)));
        t.deposit(1);
        uint256 b = t.balance();
        assertEq(b, 0);`),
  );

  reject(
    "stdstore.checked_write member chain",
    poc(`        Vault t = new Vault();
        stdstore.target(address(t)).sig("total()").checked_write(0);
        t.deposit(1);
        uint256 b = t.balance();
        assertEq(b, 0);`),
  );

  reject(
    "file-scope free assertEq shadow",
    `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
import {Test} from "forge-std/Test.sol";
import {Vault} from "src/Vault.sol";
function assertEq(uint256, uint256) pure {}
contract AuditPoc is Test {
    function testAuditPoc() public {
        Vault t = new Vault();
        t.deposit(1);
        uint256 b = t.balance();
        assertEq(b, 0);
    }
}
`,
  );

  reject(
    "test contract inherits a closure contract",
    `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
import {Test} from "forge-std/Test.sol";
import {Vault} from "src/Vault.sol";
contract AuditPoc is Vault, Test {
    function testAuditPoc() public {
        Vault t = new Vault();
        t.deposit(1);
        uint256 b = t.balance();
        assertEq(b, 0);
    }
}
`,
  );

  reject(
    "assertion binds only via the message arg",
    poc(`        Vault t = new Vault();
        t.deposit(1);
        assertEq(uint256(0), uint256(0), string(abi.encodePacked(t.balance())));`),
  );

  reject(
    "assertion read is a mutating call",
    poc(`        Vault t = new Vault();
        t.deposit(1);
        assertEq(t.resetAndReturn(), 0);`),
  );

  reject(
    "revert() early-exit call",
    poc(`        Vault t = new Vault();
        revert("x");
        t.deposit(1);
        uint256 b = t.balance();
        assertEq(b, 0);`),
  );

  reject(
    "require() guard call",
    poc(`        Vault t = new Vault();
        require(true, "x");
        t.deposit(1);
        uint256 b = t.balance();
        assertEq(b, 0);`),
  );

  reject("unparseable solidity", "this is not solidity {");

  reject(
    "oversized file",
    poc(`        Vault t = new Vault();
        t.deposit(1);
        uint256 b = t.balance();
        assertEq(b, 0);
        // ${"x".repeat(25000)}`),
  );
});

describe("staticGatePoc — audit fixtures", () => {
  it("accepts an aliased target import (import {Vault as V})", () => {
    const src = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
import {Test} from "forge-std/Test.sol";
import {Vault as V} from "src/Vault.sol";
contract AuditPoc is Test {
    function testAuditPoc() public {
        V t = new V();
        t.deposit(100);
        uint256 b = t.balance();
        assertEq(b, 0);
    }
}
`;
    const r = gate(src);
    expect(r.passed, r.reasons.join(" | ")).toBe(true);
  });

  it("rejects an overloaded name where the zero-arg call is a view (ambiguous drive/read)", () => {
    const OVL = `pragma solidity ^0.8.0;
contract Ovl {
    uint256 public total;
    function balance() external view returns (uint256) { return total; }
    function balance(uint256 x) external { total += x; }
}
`;
    const target = {
      path: "src/Ovl.sol",
      symbol: "Ovl",
      kind: "contract" as const,
      derivation: "t",
    };
    const src = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
import {Test} from "forge-std/Test.sol";
import {Ovl} from "src/Ovl.sol";
contract AuditPoc is Test {
    function testAuditPoc() public {
        Ovl t = new Ovl();
        uint256 b = t.balance();
        assertEq(b, 0);
    }
}
`;
    const r = staticGatePoc(src, { evidence: [] }, target, closure({ "src/Ovl.sol": OVL }));
    expect(r.passed).toBe(false);
  });

  it("rejects a closure mock used as a target dependency", () => {
    const MOCK = `pragma solidity ^0.8.0;\ncontract MockOracle { function price() external pure returns (uint256){ return 1; } }\n`;
    const src = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
import {Test} from "forge-std/Test.sol";
import {Vault} from "src/Vault.sol";
import {MockOracle} from "test/mocks/MockOracle.sol";
contract AuditPoc is Test {
    function testAuditPoc() public {
        MockOracle o = new MockOracle();
        o;
        Vault t = new Vault();
        t.deposit(1);
        uint256 b = t.balance();
        assertEq(b, 0);
    }
}
`;
    const r = staticGatePoc(
      src,
      { evidence: [] },
      TARGET,
      closure({ "test/mocks/MockOracle.sol": MOCK }),
    );
    expect(r.passed).toBe(false);
  });
});

describe("resolvePocTarget — interface evidence must not fall through to an unrelated contract", () => {
  it("declines when the cited file mixes an interface (cited) with an unrelated concrete contract", () => {
    const SRC = `pragma solidity ^0.8.0;
interface IFoo { function bad() external; }
contract Unrelated { function ping() external {} }
`;
    const t = resolvePocTarget(
      {
        evidence: [
          { path: "src/Mixed.sol", startLine: 2, endLine: 2, symbol: "IFoo", quote: null },
        ],
      },
      { entries: ["src/Mixed.sol"] },
      closure({ "src/Mixed.sol": SRC }),
    );
    expect(t).toBeNull();
  });
});

describe("promoteWithPoc truth table", () => {
  const pursue: PromotionDecision = { verdict: "PURSUE", reason: "survived" };
  const drop: PromotionDecision = { verdict: "DROP", reason: "killed" };

  const rec = (over: Partial<PocRecord>): PocRecord => ({
    generated: true,
    rationale: null,
    target: TARGET,
    testPath: "test/AuditPoc_x.t.sol",
    testContents: VALID,
    staticGate: { passed: true, reasons: [] },
    executed: false,
    execution: null,
    humanGated: true,
    runSpecific: true,
    ...over,
  });

  it("DROP base is unchanged (never touched)", () => {
    expect(promoteWithPoc({ base: drop, poc: rec({}) }).verdict).toBe("DROP");
  });

  it("generation-only (not executed) stays PURSUE", () => {
    expect(promoteWithPoc({ base: pursue, poc: rec({ executed: false }) }).verdict).toBe("PURSUE");
  });

  it("declined PoC stays PURSUE", () => {
    expect(
      promoteWithPoc({ base: pursue, poc: rec({ generated: false, rationale: "needs fork" }) })
        .verdict,
    ).toBe("PURSUE");
  });

  it("static-gate failure stays PURSUE", () => {
    expect(
      promoteWithPoc({
        base: pursue,
        poc: rec({ staticGate: { passed: false, reasons: ["x"] } }),
      }).verdict,
    ).toBe("PURSUE");
  });

  it("executed + compiled + passed + drove + path-match → CONFIRMED", () => {
    const v = promoteWithPoc({
      base: pursue,
      poc: rec({
        executed: true,
        execution: {
          compiled: true,
          passed: true,
          drove: true,
          deployedTargetPath: VAULT_PATH,
          reason: "ok",
        },
      }),
    });
    expect(v.verdict).toBe("CONFIRMED");
  });

  it("passed but no drive stays PURSUE", () => {
    expect(
      promoteWithPoc({
        base: pursue,
        poc: rec({
          executed: true,
          execution: {
            compiled: true,
            passed: true,
            drove: false,
            deployedTargetPath: VAULT_PATH,
            reason: "ok",
          },
        }),
      }).verdict,
    ).toBe("PURSUE");
  });

  it("target-path mismatch stays PURSUE", () => {
    expect(
      promoteWithPoc({
        base: pursue,
        poc: rec({
          executed: true,
          execution: {
            compiled: true,
            passed: true,
            drove: true,
            deployedTargetPath: "other/Vault.sol",
            reason: "ok",
          },
        }),
      }).verdict,
    ).toBe("PURSUE");
  });

  it("assertion did not hold stays PURSUE", () => {
    expect(
      promoteWithPoc({
        base: pursue,
        poc: rec({
          executed: true,
          execution: {
            compiled: true,
            passed: false,
            drove: true,
            deployedTargetPath: VAULT_PATH,
            reason: "fail",
          },
        }),
      }).verdict,
    ).toBe("PURSUE");
  });
});
