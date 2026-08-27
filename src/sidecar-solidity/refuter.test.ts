import { describe, it, expect } from "vitest";
import {
  applyOffChainGuardrail,
  isOffChainKill,
  refuteFinding,
  type Refutation,
} from "./refuter.js";
import { buildContextPack, EMPTY_CONTEXT_PACK } from "./context-pack.js";

const pack = buildContextPack({
  docs: [
    {
      path: "docs/PufferProtocol.md",
      text: "raveEvidence is checked for validity by the Guardians off-chain before provisioning.",
    },
  ],
});

const finding = {
  title: "underpriced enclave bond",
  severity: "medium",
  reasoning: "raveEvidence.length selects the 1 ETH bond with no on-chain validation",
  evidence: [{ path: "src/PufferProtocol.sol", startLine: 201, endLine: 201 }],
};

describe("isOffChainKill — only explicit off-chain claims count", () => {
  it("is true when off-chain evidence is present", () => {
    expect(isOffChainKill("some reason", true)).toBe(true);
  });
  it("is true when the reason names an off-chain ground label", () => {
    expect(isOffChainKill("OFF-CHAIN-MITIGATED: guardians check it", false)).toBe(true);
    expect(isOffChainKill("DOCUMENTED / KNOWN: intended per docs", false)).toBe(true);
  });
  it("is FALSE for a plain privileged-gated kill that merely mentions a guardian", () => {
    // The critical non-regression: 'guardian' in a PRIVILEGED-GATED reason must
    // NOT be mistaken for an off-chain-mitigation kill.
    expect(isOffChainKill("PRIVILEGED-GATED: only the guardian role can call this", false)).toBe(
      false,
    );
  });
});

describe("applyOffChainGuardrail — ungrounded off-chain kills flip to SURVIVED", () => {
  it("keeps a SURVIVED verdict untouched", () => {
    const r: Refutation = {
      verdict: "SURVIVED",
      reason: "no ground holds",
      offChainEvidence: null,
    };
    expect(applyOffChainGuardrail(r, pack)).toBe(r);
  });

  it("passes an on-chain kill through unchanged (no off-chain evidence, no label)", () => {
    const r: Refutation = {
      verdict: "KILLED",
      reason: "PRIVILEGED-GATED: only the guardian role can call this",
      offChainEvidence: null,
    };
    expect(applyOffChainGuardrail(r, pack).verdict).toBe("KILLED");
  });

  it("KEEPS an off-chain kill whose quote IS grounded in the trust corpus", () => {
    const r: Refutation = {
      verdict: "KILLED",
      reason: "OFF-CHAIN-MITIGATED: guardians validate the evidence",
      offChainEvidence: {
        source: "docs/PufferProtocol.md",
        quote: "raveEvidence is checked for validity by the Guardians off-chain",
      },
    };
    expect(applyOffChainGuardrail(r, pack).verdict).toBe("KILLED");
  });

  it("FLIPS an off-chain kill whose quote is NOT in the corpus (fabricated excuse)", () => {
    const r: Refutation = {
      verdict: "KILLED",
      reason: "OFF-CHAIN-MITIGATED: surely something handles it",
      offChainEvidence: {
        source: "docs/PufferProtocol.md",
        quote: "operators are always honest here",
      },
    };
    const out = applyOffChainGuardrail(r, pack);
    expect(out.verdict).toBe("SURVIVED");
    expect(out.reason).toContain("NOT grounded");
  });

  it("FLIPS an off-chain-labelled kill that omits the required quote (the dodge)", () => {
    const r: Refutation = {
      verdict: "KILLED",
      reason: "OFF-CHAIN-MITIGATED: the guardians handle this, trust me",
      offChainEvidence: null,
    };
    expect(applyOffChainGuardrail(r, pack).verdict).toBe("SURVIVED");
  });

  it("flips an off-chain kill when there is NO pack to ground against", () => {
    const r: Refutation = {
      verdict: "KILLED",
      reason: "OFF-CHAIN-MITIGATED: docs say so",
      offChainEvidence: { source: "x", quote: "a documented off-chain mitigation exists" },
    };
    expect(applyOffChainGuardrail(r, EMPTY_CONTEXT_PACK).verdict).toBe("SURVIVED");
  });
});

// Hoisted (lint: helpers capturing no scope live at module level).
const fakeModelUngrounded = async (): Promise<unknown> => ({
  verdict: "KILLED",
  reason: "OFF-CHAIN-MITIGATED: a keeper fixes it",
  offChainEvidence: { source: "docs", quote: "this exact sentence is nowhere in the docs" },
});
const fakeModelGrounded = async (): Promise<unknown> => ({
  verdict: "KILLED",
  reason: "OFF-CHAIN-MITIGATED",
  offChainEvidence: {
    source: "docs/PufferProtocol.md",
    quote: "raveEvidence is checked for validity by the Guardians off-chain",
  },
});

describe("refuteFinding — guardrail composes end-to-end", () => {
  it("flips a fabricated off-chain kill returned by the model", async () => {
    const out = await refuteFinding(
      { finding, files: [], programRules: "", contextPack: pack },
      fakeModelUngrounded,
    );
    expect(out.verdict).toBe("SURVIVED");
  });

  it("honors a grounded off-chain kill", async () => {
    const out = await refuteFinding(
      { finding, files: [], programRules: "", contextPack: pack },
      fakeModelGrounded,
    );
    expect(out.verdict).toBe("KILLED");
  });

  it("dry-run (no model) still returns the KILLED stub unchanged", async () => {
    const out = await refuteFinding({ finding, files: [], programRules: "" });
    expect(out.verdict).toBe("KILLED");
    expect(out.reason).toContain("dry-run");
  });
});
