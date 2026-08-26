import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { assembleClosure, parseFoundryTomlRemappings, parseRemappingsTxt } from "./closure.js";

/**
 * Committed inline fixture mirroring the biconomy-counterfactual shape
 * (specs/SOLIDITY_SIDECAR_SPEC.md §5): the wallet imports its base; a separate
 * factory creates the wallet via `new Wallet(...)` WITHOUT importing it — so
 * the factory is reachable ONLY through reverse-reference resolution. This is
 * exactly the edge the PR-diff reviewer structurally cannot see.
 */
const FIXTURE = new Map<string, string>([
  [
    "contracts/Wallet.sol",
    `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\nimport "./Base.sol";\nimport "@oz/token/ERC20.sol";\ncontract Wallet is Base {\n  constructor(address owner_) Base(owner_) {}\n}`,
  ],
  [
    "contracts/Base.sol",
    "contract Base { address public owner; constructor(address o) { owner = o; } }\n",
  ],
  [
    "contracts/WalletFactory.sol",
    // No import of Wallet.sol — symbol usage only.
    "contract WalletFactory {\n  function create(address owner_, uint256 index) external returns (address) {\n    bytes32 salt = keccak256(abi.encode(owner_, index));\n    Wallet wallet = new Wallet{salt: salt}(owner_);\n    return address(wallet);\n  }\n}\n",
  ],
  ["lib/oz/token/ERC20.sol", "contract ERC20 {}\n"],
  ["remappings.txt", "# comment line\n@oz/=lib/oz/\n"],
]);

// The known-bug description for THIS fixture class — must never leak into the
// finder scaffold (anti-contamination test lives in run.test.ts).
export const FIXTURE_HINT_STRINGS = [
  "salt derived from owner",
  "attacker-chosen configuration at an expected address",
] as const;

const readFixture = async (p: string): Promise<string> => {
  const hit = FIXTURE.get(p);
  if (hit === undefined) {
    throw new Error(`not found: ${p}`);
  }
  return hit;
};
const ALL = [...FIXTURE.keys()];
const ENTRY = "contracts/Wallet.sol";

describe("assembleClosure — bidirectional resolution", () => {
  it("pulls BOTH the wallet and its backwards-only factory into one context from the entry", async () => {
    const result = await assembleClosure({
      entries: [ENTRY],
      allPaths: ALL,
      readFile: readFixture,
    });
    const paths = result.blocks.map((b) => b.path);
    expect(paths).toContain("contracts/Wallet.sol");
    expect(paths).toContain("contracts/Base.sol"); // forward import
    expect(paths).toContain("contracts/WalletFactory.sol"); // REVERSE symbol reference
    expect(result.roles.get(ENTRY)).toBe("entry");
    expect(result.roles.get("contracts/WalletFactory.sol")).toBe("reverse");
    expect(result.roles.get("contracts/Base.sol")).toBe("forward");
  });

  it("resolves remapped bare specifiers into lib/ via remappings.txt", async () => {
    const result = await assembleClosure({
      entries: [ENTRY],
      allPaths: ALL,
      readFile: readFixture,
    });
    expect(result.blocks.map((b) => b.path)).toContain("lib/oz/token/ERC20.sol");
    expect(result.externalUnresolved).toEqual([]);
  });

  it("reverse hits JOIN THE FRONTIER — their own forward deps are included transitively", async () => {
    const tree = new Map(FIXTURE);
    tree.set(
      "contracts/WalletFactory.sol",
      `import "./FactoryLib.sol";\n${tree.get("contracts/WalletFactory.sol") ?? ""}`,
    );
    tree.set("contracts/FactoryLib.sol", "library FactoryLib {}\n");
    const result = await assembleClosure({
      entries: [ENTRY],
      allPaths: [...tree.keys()],
      readFile: async (p) => tree.get(p) ?? "",
    });
    const paths = result.blocks.map((b) => b.path);
    expect(paths).toContain("contracts/FactoryLib.sol");
    expect(result.roles.get("contracts/FactoryLib.sol")).toBe("forward");
  });

  it("reports unresolvable externals instead of dropping them silently", async () => {
    const tree = new Map<string, string>([
      ["E.sol", 'import "@chainlink/contracts/AggregatorV3Interface.sol";\ncontract E {}'],
    ]);
    const result = await assembleClosure({
      entries: ["E.sol"],
      allPaths: ["E.sol"],
      readFile: async (p) => tree.get(p) ?? "",
    });
    expect(result.externalUnresolved).toEqual(["@chainlink/contracts/AggregatorV3Interface.sol"]);
  });
});

describe("assembleClosure — budget policy", () => {
  it("evicts from the END of keep order; entries always kept whole; truncated flagged", async () => {
    const bigBase = `contract Base { /* ${"x".repeat(5000)} */ }`;
    const tree = new Map<string, string>([
      ["W.sol", `import "./B1.sol";\ncontract W is B1 {}`],
      ["B1.sol", bigBase],
      [
        "F.sol",
        "contract F {\n  function f() external returns (address) { W w = new W(); return address(w); }\n}\n",
      ],
    ]);
    // W ~35B + B1 ~5.0kB + F ~110B ≈ 5.15kB total; budget fits W+B1, evicts F.
    const result = await assembleClosure({
      entries: ["W.sol"],
      allPaths: [...tree.keys()],
      readFile: async (p) => tree.get(p) ?? "",
      budgetBytes: 5100,
    });
    expect(result.blocks.map((b) => b.path)).toEqual(["W.sol", "B1.sol"]);
    expect(result.evicted).toEqual(["F.sol"]);
    expect(result.truncated).toBe(true);
    expect(result.entryOverflow).toBe(false);
  });

  it("keeps entries whole even when they alone exceed the budget (entryOverflow)", async () => {
    const hugeEntry = `contract Huge { /* ${"y".repeat(5000)} */ }`;
    const result = await assembleClosure({
      entries: ["Huge.sol"],
      allPaths: ["Huge.sol"],
      readFile: async (p) => (p === "Huge.sol" ? hugeEntry : ""),
      budgetBytes: 100,
    });
    expect(result.blocks.map((b) => b.path)).toEqual(["Huge.sol"]);
    expect(result.blocks[0]?.contents).toBe(hugeEntry); // never truncated mid-content
    expect(result.entryOverflow).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it("throws when an entry is missing from the file set", async () => {
    await expect(
      assembleClosure({ entries: ["nope.sol"], allPaths: [], readFile: async () => "" }),
    ).rejects.toThrow(/not in file set/);
  });
});

describe("remapping parsers", () => {
  it("parseRemappingsTxt handles comments and longest-prefix ordering", () => {
    const pairs = parseRemappingsTxt("# c\n@oz/=lib/oz/\nds-test/=lib/ds-test/src/\n");
    expect(pairs[0]).toEqual(["ds-test", "lib/ds-test/src"]); // longer prefix first (trailing / stripped canonically)
  });

  it("parseFoundryTomlRemappings reads profile remappings arrays", () => {
    const toml = `[profile.default]\nsrc = "src"\nremappings = ["@oz/=lib/openzeppelin-contracts/", "foo/=lib/foo/"]\n`;
    expect(parseFoundryTomlRemappings(toml)).toContainEqual(["foo", "lib/foo"]);
  });
});

describe("integration vs real biconomy checkout (skipIf absent)", () => {
  const TARGET = "solidity-killtest/targets/biconomy-counterfactual/scw-contracts";
  const available = existsSync(TARGET);

  it.skipIf(!available)(
    "pulls SmartAccountFactory.sol into one context from the SmartAccount.sol entry",
    async () => {
      const { listSolFiles, fsReadRepoFile } = await import("./closure.js");
      const entries = ["contracts/smart-contract-wallet/SmartAccount.sol"];
      const all = await listSolFiles(TARGET);
      const result = await assembleClosure({
        entries,
        allPaths: all,
        readFile: fsReadRepoFile(TARGET),
      });
      const paths = result.blocks.map((b) => b.path);
      expect(paths).toContain(entries[0]);
      expect(paths).toContain("contracts/smart-contract-wallet/SmartAccountFactory.sol");
    },
  );
});

describe("rework items — closure correctness", () => {
  it("reverse-resolves interface-mediated coupling: file using IVault pulls in from Vault entry", async () => {
    const tree = new Map<string, string>([
      ["contracts/Vault.sol", "contract Vault { function totalAssets() external view returns (uint256) { return 1; } }\n"],
      // Uses IVault — the I-prefixed variant of the entry symbol — never "Vault".
      ["contracts/Strategy.sol", "contract Strategy {\n  function harvest(IVault vault) external { vault.totalAssets(); }\n}\ninterface IVault { function totalAssets() external view returns (uint256); }\n"],
    ]);
    const result = await assembleClosure({
      entries: ["contracts/Vault.sol"],
      allPaths: [...tree.keys()],
      readFile: async (p) => tree.get(p) ?? "",
    });
    expect(result.blocks.map((b) => b.path)).toContain("contracts/Strategy.sol");
  });

  it("common short symbols require a stronger signal than a single name hit", async () => {
    const tree = new Map<string, string>([
      ["contracts/Math.sol", "contract Math {}\n"],
      ["contracts/User.sol", "// mentions Token once\ncontract User {}\n"],
    ]);
    const result = await assembleClosure({
      entries: ["contracts/Math.sol"],
      allPaths: [...tree.keys()],
      readFile: async (p) => tree.get(p) ?? "",
    });
    // Single passing mention of a common-ish symbol must NOT couple User in.
    expect(result.blocks.map((b) => b.path)).not.toContain("contracts/User.sol");
  });

  it("explicit remappings parameter resolves bare specifiers (config files are not .sol)", async () => {
    const tree = new Map<string, string>([
      ["W.sol", 'import "@oz/token/ERC20.sol";\ncontract W {}'],
      ["lib/openzeppelin-contracts/token/ERC20.sol", "contract ERC20 {}"],
    ]);
    const result = await assembleClosure({
      entries: ["W.sol"],
      allPaths: [...tree.keys()],
      readFile: async (p) => tree.get(p) ?? "",
      remappings: [["@oz/", "lib/openzeppelin-contracts/"]],
    });
    expect(result.blocks.map((b) => b.path)).toContain("lib/openzeppelin-contracts/token/ERC20.sol");
  });

  it("deep forward-transitive nodes do not evict reverse differentiators first (item 6c)", async () => {
    const filler = `contract Deep { /* ${"z".repeat(3000)} */ }\n`;
    const tree = new Map<string, string>([
      // Long symbol names so the common-short-symbol guard doesn't suppress coupling.
      ["VaultMain.sol", 'import "./BaseA.sol";\nimport "./BaseB.sol";\ncontract VaultMain is BaseA, BaseB {}'],
      ["BaseA.sol", "contract BaseA {}"],
      ["BaseB.sol", 'import "./DeepFiller.sol";\ncontract BaseB is DeepFiller {}'],
      ["DeepFiller.sol", filler],
      ["Harvester.sol", "contract Harvester { function harvest(VaultMain v) external {} }\n"], // reverse hit
    ]);
    const result = await assembleClosure({
      entries: ["VaultMain.sol"],
      allPaths: [...tree.keys()],
      readFile: async (p) => tree.get(p) ?? "",
      budgetBytes: 400,
    });
    const kept = result.blocks.map((b) => b.path);
    expect(kept).toContain("VaultMain.sol"); // entry always kept
    expect(kept).toContain("Harvester.sol"); // differentiator survives over deep transitive padding
    expect(kept).not.toContain("DeepFiller.sol"); // deep padding evicted instead
  });
});

describe("symlink escape guards (item 6)", () => {
  it("listSolFiles skips symlinks; fsReadRepoFile rejects escapes", async () => {
    const { mkdtemp, mkdir, symlink, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const root = await mkdtemp(join(tmpdir(), "sidecar-sym-"));
    try {
      await mkdir(join(root, "contracts"), { recursive: true });
      await writeFile(join(root, "contracts", "Real.sol"), "contract Real {}\n");
      // Symlinked .sol pointing OUTSIDE the target root must never be walked.
      const outsideDir = await mkdtemp(join(tmpdir(), "sidecar-out-"));
      await writeFile(join(outsideDir, "Secret.sol"), "contract Secret {}\n");
      await symlink(join(outsideDir, "Secret.sol"), join(root, "contracts", "Leak.sol"));
      const { listSolFiles: ls, fsReadRepoFile: reader } = await import("./closure.js");
      const files = await ls(root);
      expect(files).toEqual(["contracts/Real.sol"]);
      // And the reader enforces containment independently of the walker:
      await expect(reader(root)("contracts/Leak.sol")).rejects.toThrow(/escapes target root/);
      await expect((await reader(root)("contracts/Real.sol"))).toContain("contract Real");
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
