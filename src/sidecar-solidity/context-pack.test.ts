import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildContextPack,
  EMPTY_CONTEXT_PACK,
  extractKnownIssues,
  extractNatSpecTrustHints,
  groundOffChainClaim,
  isEmptyPack,
  listMarkdownDocs,
  renderSystemBrief,
  renderTrustCorpus,
  type ContextPack,
} from "./context-pack.js";

describe("extractNatSpecTrustHints — off-chain actor NatSpec (finder hints)", () => {
  it("pulls comment lines mentioning off-chain actors, skips code and unrelated comments", () => {
    const files = [
      {
        path: "src/GuardianModule.sol",
        contents:
          "// SPDX\n" +
          "/// @notice validation of guardian's EOA/Enclave signatures\n" +
          "contract GuardianModule {\n" +
          "    uint256 public totalSupply; // a plain state var, no actor\n" +
          "    // just a normal comment about math\n" +
          "    function f() external {}\n" +
          "}\n",
      },
    ];
    const hints = extractNatSpecTrustHints(files);
    expect(hints.length).toBe(1);
    expect(hints[0]?.text).toContain("guardian");
    expect(hints[0]?.path).toBe("src/GuardianModule.sol");
  });

  it("returns nothing for files with no off-chain-actor comments", () => {
    expect(
      extractNatSpecTrustHints([{ path: "A.sol", contents: "contract A { uint x; }" }]),
    ).toEqual([]);
  });
});

describe("extractKnownIssues — audit-report finding headers (DUPLICATE corpus)", () => {
  it("extracts severity-tagged and numbered finding headers", () => {
    const audits = [
      {
        name: "BlockSec.pdf",
        text:
          "6.1 [High] Potential front-running provisionNode\nsome body text\n" +
          "Finding 3: Ignored return value of transfer\n" +
          "[Medium] Hash collision between guardian messages\n",
      },
    ];
    const issues = extractKnownIssues(audits);
    expect(issues.some((i) => i.includes("[High] Potential front-running"))).toBe(true);
    expect(issues.some((i) => i.toLowerCase().includes("finding 3"))).toBe(true);
    expect(issues.every((i) => i.startsWith("BlockSec.pdf:"))).toBe(true);
  });
});

describe("buildContextPack — asymmetric assembly + budgets", () => {
  const docs = [
    { path: "docs/Protocol.md", text: "Guardians verify the RAVE evidence off-chain." },
  ];
  const audits = [{ name: "NM.pdf", text: "[High] provisionNode front-running. Fixed." }];

  it("systemBrief carries docs+trust-model; trustCorpus additionally carries audits; knownIssues populated", () => {
    const pack = buildContextPack({
      docs,
      auditTexts: audits,
      trustModelText: "Paymaster is trusted to call provisionNode.",
    });
    expect(pack.systemBrief).toContain("Guardians verify the RAVE evidence off-chain");
    expect(pack.systemBrief).toContain("Paymaster is trusted");
    expect(pack.systemBrief).not.toContain("front-running"); // audits are refuter-only
    expect(pack.trustCorpus).toContain("Guardians verify the RAVE evidence off-chain");
    expect(pack.trustCorpus).toContain("front-running"); // audit text present for the refuter
    expect(pack.knownIssues.length).toBeGreaterThan(0);
    expect(pack.sources.length).toBeGreaterThan(0);
  });

  it("empty inputs → empty pack (Phase 0 disabled = unchanged pipeline)", () => {
    const pack = buildContextPack({});
    expect(isEmptyPack(pack)).toBe(true);
    expect(isEmptyPack(EMPTY_CONTEXT_PACK)).toBe(true);
  });

  it("honors the corpus byte budget (truncates, never unbounded)", () => {
    const big = { path: "docs/Big.md", text: "x".repeat(100_000) };
    const pack = buildContextPack({ docs: [big], corpusBudgetBytes: 5_000 });
    expect(pack.trustCorpus.length).toBeLessThan(6_000);
    expect(pack.trustCorpus).toContain("context truncated");
  });
});

describe("groundOffChainClaim — THE guardrail", () => {
  const pack: ContextPack = buildContextPack({
    docs: [
      { path: "docs/Protocol.md", text: "Guardians verify the RAVE evidence off-chain by design." },
    ],
  });

  it("grounds a verbatim quote present in the trust corpus", () => {
    expect(groundOffChainClaim("Guardians verify the RAVE evidence off-chain", pack)).toBe(true);
  });

  it("rejects a quote absent from the corpus (fabricated off-chain excuse)", () => {
    expect(groundOffChainClaim("Anyone may bypass the guardians freely", pack)).toBe(false);
  });

  it("rejects too-short and empty/null quotes (too weak to anchor)", () => {
    expect(groundOffChainClaim("off-chain", pack)).toBe(false);
    expect(groundOffChainClaim("", pack)).toBe(false);
    expect(groundOffChainClaim(null, pack)).toBe(false);
  });

  it("nothing grounds against an empty pack", () => {
    expect(
      groundOffChainClaim("Guardians verify the RAVE evidence off-chain", EMPTY_CONTEXT_PACK),
    ).toBe(false);
  });
});

describe("renderSystemBrief / renderTrustCorpus — bodies only (framing lives in prompt.ts)", () => {
  const pack = buildContextPack({ docs: [{ path: "docs/D.md", text: "System overview text." }] });

  it("renderSystemBrief appends per-entry NatSpec hints", () => {
    const body = renderSystemBrief(pack, [
      { path: "src/G.sol", text: "guardian signs provisioning" },
    ]);
    expect(body).toContain("System overview text");
    expect(body).toContain("guardian signs provisioning");
  });

  it("renderSystemBrief is empty when pack empty and no hints", () => {
    expect(renderSystemBrief(EMPTY_CONTEXT_PACK, [])).toBe("");
  });

  it("renderTrustCorpus returns the adjudicative body", () => {
    expect(renderTrustCorpus(pack)).toContain("System overview text");
    expect(renderTrustCorpus(EMPTY_CONTEXT_PACK)).toBe("");
  });
});

describe("listMarkdownDocs — FS discovery (README + docs/, skips deps)", () => {
  it("finds README* and docs/** markdown, skips node_modules", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "sidecar-docs-"));
    try {
      await writeFile(join(root, "README.md"), "# readme\n");
      await mkdir(join(root, "docs"), { recursive: true });
      await writeFile(join(root, "docs", "Protocol.md"), "# protocol\n");
      await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
      await writeFile(join(root, "node_modules", "pkg", "README.md"), "# dep readme\n");
      await writeFile(join(root, "src.sol"), "contract X {}\n"); // not markdown
      const docs = await listMarkdownDocs(root);
      expect(docs).toContain("README.md");
      expect(docs).toContain("docs/Protocol.md");
      expect(docs.some((d) => d.includes("node_modules"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
