import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Structural security contract for .github/workflows/repro-exec-verify.yml.
// The exec job runs model-generated (hostile) code; these invariants are the
// isolation boundary and must not regress silently. This test parses the YAML
// as text (no yaml dep) and asserts the load-bearing properties. See the 2b
// decision memo (2026-07-21) for the rationale behind each.

const workflowPath = join(
  process.cwd(),
  "..",
  "..",
  ".github",
  "workflows",
  "repro-exec-verify.yml",
);
const source = readFileSync(workflowPath, "utf8");

// Slice the text of one top-level job (2-space indented under `jobs:`) up to
// the next job header or EOF.
function jobBlock(name: string): string {
  const re = new RegExp(`\\n  ${name}:\\n`);
  const start = source.search(re);
  if (start === -1) throw new Error(`job '${name}' not found`);
  const rest = source.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z][a-z0-9_-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("repro-exec-verify workflow security contract", () => {
  it("declares least-privilege permissions at the top level", () => {
    expect(source).toMatch(/\npermissions:\s*\{\}\n/);
  });

  it("triggers only via workflow_dispatch (operator-run, no automatic hostile exec)", () => {
    expect(source).toMatch(/\non:\n\s+workflow_dispatch:/);
    expect(source).not.toMatch(/\n\s+(push|pull_request):/);
  });

  it("pins every action to a 40-hex commit SHA", () => {
    const uses = [...source.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) {
      expect(u, `${u} must be pinned by @<40-hex sha>`).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  describe("exec job — the hostile-code isolation boundary", () => {
    const exec = jobBlock("exec");

    it("has zero privileges", () => {
      expect(exec).toMatch(/permissions:\s*\{\}/);
    });

    it("references NO secrets (no credential may reach the hostile path)", () => {
      expect(exec).not.toContain("secrets.");
    });

    it("runs the repro inside a --network none container", () => {
      expect(exec).toContain("docker run");
      expect(exec).toContain("--network none");
    });

    it("pins the exec container image by digest", () => {
      expect(exec).toMatch(/node:[^\s@]+@sha256:[0-9a-f]{64}/);
    });

    it("passes only the sandbox marker into the container env, no secret env", () => {
      // The only -e passed is ANTFLEET_REPRO_SANDBOX; --env-file /dev/null
      // clears inherited env. Any other -e <NAME> would be a leak vector.
      const eFlags = [...exec.matchAll(/-e\s+([A-Z0-9_]+)/g)].map((m) => m[1]);
      expect(eFlags).toEqual(["ANTFLEET_REPRO_SANDBOX"]);
      expect(exec).toContain("--env-file /dev/null");
    });

    it("uses no third-party actions (first-party actions/* only)", () => {
      const uses = [...exec.matchAll(/uses:\s*([^@]+)@/g)].map((m) => m[1]);
      for (const u of uses) {
        expect(u.startsWith("actions/"), `${u} is third-party — not allowed in exec`).toBe(true);
      }
    });
  });

  it("fetch and record jobs carry the DB secret; exec never does", () => {
    expect(jobBlock("fetch")).toContain("secrets.DATABASE_URL");
    expect(jobBlock("record")).toContain("secrets.DATABASE_URL");
    expect(jobBlock("exec")).not.toContain("secrets.DATABASE_URL");
  });
});
