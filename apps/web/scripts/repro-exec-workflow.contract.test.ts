import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Structural security contract for .github/workflows/repro-exec-verify.yml.
// The exec job runs the trusted orchestrator on the runner; the untrusted
// commands run in per-command --network none containers (asserted in code by
// repro-container-exec.test.ts). These YAML-level invariants keep the exec job
// itself credential-free and least-privileged. See the 2b decision memo.

const workflowPath = join(
  process.cwd(),
  "..",
  "..",
  ".github",
  "workflows",
  "repro-exec-verify.yml",
);
const rawSource = readFileSync(workflowPath, "utf8");

// Strip full-line and trailing comments so a `#`-comment mentioning e.g.
// "secrets" can't satisfy or break an assertion (a #159 review note).
const source = rawSource
  .split("\n")
  .map((line) => {
    const hashIdx = line.indexOf("#");
    return hashIdx === -1 ? line : line.slice(0, hashIdx);
  })
  .join("\n");

// Slice the (comment-stripped) text of one top-level job up to the next job.
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

  it("triggers only via workflow_dispatch (operator-run)", () => {
    expect(source).toMatch(/\non:\n\s+workflow_dispatch:/);
    expect(source).not.toMatch(/\n\s+(push|pull_request|schedule):/);
  });

  it("pins every action to a 40-hex commit SHA", () => {
    const uses = [...source.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) {
      expect(u, `${u} must be pinned by @<40-hex sha>`).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it("does not interpolate workflow inputs into any run body (script injection)", () => {
    // inputs must reach bash via env: only. A ${{ inputs.* }} inside a run block
    // is the script-injection vector #159 flagged.
    const runBlocks = [
      ...source.matchAll(/run:\s*\|([\s\S]*?)(?=\n {6}[a-z-]+:|\n {4}- |\n {2}[a-z])/g),
    ];
    for (const m of runBlocks) {
      expect(m[1], "run body must not contain ${{ inputs").not.toMatch(/\$\{\{\s*inputs\./);
    }
  });

  describe("exec job — carries no credentials, least privilege", () => {
    const exec = jobBlock("exec");

    it("grants contents:read and nothing more (private-repo checkout needs it)", () => {
      // First live run: permissions:{} left checkout unauthenticated against
      // the private repo ("repository not found"). contents:read is the floor;
      // anything beyond it (write perms, id-token, packages, …) is a regression.
      const perms = exec.match(/permissions:\n((?: {6}[a-z-]+: [a-z-]+\n)+)/);
      expect(perms, "exec must declare a block-style permissions map").not.toBeNull();
      const entries = (perms as RegExpMatchArray)[1]
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      expect(entries).toEqual(["contents: read"]);
    });

    it("references NO secrets", () => {
      expect(exec).not.toContain("secrets.");
    });

    it("checks out without persisting the Actions token", () => {
      expect(exec).toMatch(/persist-credentials:\s*false/);
    });

    it("sets the sandbox marker so --phase exec cannot run on a bare host", () => {
      expect(exec).toMatch(/ANTFLEET_REPRO_SANDBOX:\s*["']?1["']?/);
    });

    it("never mounts the docker socket", () => {
      expect(exec).not.toContain("/var/run/docker.sock");
      expect(exec).not.toContain("docker.sock");
    });

    it("uses no third-party actions (first-party actions/* only)", () => {
      const uses = [...exec.matchAll(/uses:\s*([^@]+)@/g)].map((m) => m[1]);
      for (const u of uses) {
        expect(u.startsWith("actions/"), `${u} is third-party — not allowed in exec`).toBe(true);
      }
    });

    it("builds the exec image from the version-controlled Dockerfile", () => {
      expect(exec).toContain("docker build -t antfleet-repro-exec:local");
      expect(exec).toContain(".github/repro-exec.Dockerfile");
    });
  });

  it("pins the exec image's base by digest in the Dockerfile", () => {
    const dockerfile = readFileSync(
      join(process.cwd(), "..", "..", ".github", "repro-exec.Dockerfile"),
      "utf8",
    );
    expect(dockerfile).toMatch(/^FROM\s+\S+@sha256:[0-9a-f]{64}/m);
  });

  it("fetch and record jobs carry the DB secret; exec never does", () => {
    expect(jobBlock("fetch")).toContain("secrets.DATABASE_URL");
    expect(jobBlock("record")).toContain("secrets.DATABASE_URL");
    expect(jobBlock("exec")).not.toContain("secrets.DATABASE_URL");
  });

  it("builds the exact image tag the code runs (REPRO_EXEC_IMAGE)", async () => {
    const { REPRO_EXEC_IMAGE } = await import("./repro-verify-batch");
    expect(REPRO_EXEC_IMAGE).toBe("antfleet-repro-exec:local");
    expect(rawSource).toContain(`docker build -t ${REPRO_EXEC_IMAGE}`);
  });
});
