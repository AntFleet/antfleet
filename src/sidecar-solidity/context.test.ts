import { describe, it, expect } from "vitest";
import {
  DEFAULT_MAX_SLICE_BYTES,
  packSlices,
  resolveContractClosure,
  type ContextFile,
} from "./context.js";

const file = (path: string, contents: string): ContextFile => ({ path, contents });

describe("packSlices — baseline arm mirrors the PR chunker's ≤150KB cap", () => {
  it("returns an empty array for empty input", () => {
    expect(packSlices([])).toEqual([]);
  });

  it("packs small files together under the cap", () => {
    const slices = packSlices([
      file("a/A.sol", "x".repeat(60_000)),
      file("b/B.sol", "y".repeat(60_000)),
      file("c/C.sol", "z".repeat(60_000)),
    ]);
    expect(slices).toHaveLength(2);
    expect(slices[0]?.files.map((f) => f.path)).toEqual(["a/A.sol", "b/B.sol"]);
    expect(slices[1]?.files.map((f) => f.path)).toEqual(["c/C.sol"]);
  });

  it("never truncates a file larger than the cap (own oversize slice)", () => {
    const big = "q".repeat(DEFAULT_MAX_SLICE_BYTES + 1);
    const slices = packSlices([file("big/Sol.sol", big), file("small/S.sol", "tiny")]);
    expect(slices).toHaveLength(2);
    const oversize = slices.find((s) => s.files[0]?.path === "big/Sol.sol");
    expect(oversize?.bytes).toBe(big.length);
    // Line-number integrity: contents untouched.
    expect(oversize?.files[0]?.contents).toBe(big);
  });

  it("is deterministic (sorted by path regardless of input order)", () => {
    const files = [file("z/Z.sol", "1"), file("a/A.sol", "2")];
    expect(packSlices(files)[0]?.files[0]?.path).toBe("a/A.sol");
    expect(packSlices([...files].toReversed())).toEqual(packSlices(files));
  });

  it("rejects a non-positive cap", () => {
    expect(() => packSlices([file("a.sol", "x")], 0)).toThrow(RangeError);
  });
});

describe("resolveContractClosure — Mode-A whole-contract context", () => {
  const tree = new Map<string, string>([
    [
      "contracts/Vault.sol",
      `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "@openzeppelin/contracts/access/Ownable.sol";
import "./math/Shares.sol";

contract Vault is Ownable {}`,
    ],
    ["contracts/math/Shares.sol", `import {WadRay} from "../lib/WadRay.sol"; library Shares {}`],
    ["contracts/lib/WadRay.sol", `library WadRay {}`],
    ["lib/openzeppelin-contracts/contracts/access/Ownable.sol", `contract Ownable {}`],
  ]);

  const readFile = async (p: string): Promise<string> => {
    const hit = tree.get(p);
    if (hit === undefined) throw new Error(`not found: ${p}`);
    return hit;
  };

  it("walks relative imports transitively and includes the entry first", async () => {
    const result = await resolveContractClosure("contracts/Vault.sol", [...tree.keys()], readFile);
    expect(result.included).toEqual([
      "contracts/Vault.sol",
      "lib/openzeppelin-contracts/contracts/access/Ownable.sol",
      "contracts/math/Shares.sol",
      "contracts/lib/WadRay.sol",
    ]);
    expect(result.external).toEqual([]);
  });

  it("resolves bare/remapped specifiers by unique path suffix", async () => {
    const result = await resolveContractClosure("contracts/Vault.sol", [...tree.keys()], readFile);
    expect(result.included).toContain("lib/openzeppelin-contracts/contracts/access/Ownable.sol");
  });

  it("reports unresolvable specifiers as external instead of dropping silently", async () => {
    const small = new Map([["E.sol", 'import "@chainlink/contracts/AggregatorV3Interface.sol";']]);
    const result = await resolveContractClosure(
      "E.sol",
      ["E.sol"],
      async (p) => small.get(p) ?? "",
    );
    expect(result.included).toEqual(["E.sol"]);
    expect(result.external).toEqual(["@chainlink/contracts/AggregatorV3Interface.sol"]);
  });

  it("handles all three import syntaxes", async () => {
    const m = new Map([
      ["A.sol", `import {B} from "./B.sol"; import * as C from "./C.sol"; import "./D.sol";`],
      ["B.sol", ""],
      ["C.sol", ""],
      ["D.sol", ""],
    ]);
    const result = await resolveContractClosure(
      "A.sol",
      [...m.keys()],
      async (p) => m.get(p) ?? "",
    );
    expect(result.included.toSorted()).toEqual(["A.sol", "B.sol", "C.sol", "D.sol"]);
  });

  it("throws when the entry is not in the file set", async () => {
    await expect(resolveContractClosure("nope.sol", [], async () => "")).rejects.toThrow(
      /not in file set/,
    );
  });
});
