import { describe, expect, it, vi } from "vitest";
import type { ChangedFile } from "./github-files";
import {
  generateRepoThreatModel,
  getRepoThreatModelFilesWith,
  publicAccessForThreatModel,
  publicThreatModelView,
  threatModelSectionsTouched,
  toReachabilityThreatModel,
  updateRepoThreatModel,
} from "./repo-threat-model";

function file(filename: string, contents: string): ChangedFile {
  return {
    filename,
    contents,
    status: "modified",
    sha: "abc",
    patch: contents,
  };
}

describe("repo threat model", () => {
  it("generates the five threat-model sections from repo files", () => {
    const model = generateRepoThreatModel({
      owner: "AntFleet",
      repo: "bench-agent",
      repoHash: "hash",
      sha: "sha-1",
      now: new Date("2026-06-23T00:00:00Z"),
      files: [
        file(
          "src/api/webhook.ts",
          "export async function POST(req) { requireAuth(req); const token = process.env.API_KEY; await db.insert(); }",
        ),
        file("src/payments/wallet.ts", "export function withdraw(balance) { transfer(balance); }"),
      ],
    });

    expect(model.sections.entryPoints.items.some((i) => i.kind === "webhook")).toBe(true);
    expect(model.sections.trustBoundaries.items.length).toBeGreaterThan(0);
    expect(model.sections.sinks.items.length).toBeGreaterThan(0);
    expect(model.sections.secretsSurface.items.length).toBeGreaterThan(0);
    expect(model.sections.criticalAssets.items.length).toBeGreaterThan(0);
  });

  it("exports only public-safe sections for the agent page", () => {
    const model = generateRepoThreatModel({
      owner: "AntFleet",
      repo: "bench-agent",
      repoHash: "hash",
      sha: "sha-1",
      files: [file("src/api.ts", "export function handler() { process.env.SECRET; }")],
    });
    const view = publicThreatModelView({ document: model, access: "public" });

    expect("sections" in view).toBe(true);
    if (!("sections" in view)) throw new Error("missing public sections");
    expect(view.sections.entryPoints).toBeDefined();
    expect(view.sections.trustBoundaries).toBeDefined();
    expect(view.sections.sinks).toBeDefined();
    expect("secretsSurface" in view.sections).toBe(false);
    expect("criticalAssets" in view.sections).toBe(false);
  });

  it("keeps private and live-protocol models off the public surface", () => {
    const oldAllowlist = process.env["ANTFLEET_PUBLIC_THREAT_MODEL_REPOS"];
    delete process.env["ANTFLEET_PUBLIC_THREAT_MODEL_REPOS"];
    try {
      expect(
        publicAccessForThreatModel({
          owner: "AntFleet",
          repo: "private-agent",
          publicReceipt: false,
        }),
      ).toBe("private");
      expect(
        publicAccessForThreatModel({
          owner: "AntFleet",
          repo: "uniswap-bench",
          publicReceipt: true,
        }),
      ).toBe("live_protocol_review_required");
      expect(
        publicAccessForThreatModel({
          owner: "Balancer",
          repo: "balancer-v3-monorepo",
          publicReceipt: true,
        }),
      ).toBe("live_protocol_review_required");
      expect(
        publicAccessForThreatModel({
          owner: "AntFleet",
          repo: "bench-agent",
          publicReceipt: true,
        }),
      ).toBe("public");
      expect(
        publicAccessForThreatModel({
          owner: "customer",
          repo: "contest-agent",
          publicReceipt: true,
        }),
      ).toBe("live_protocol_review_required");
      expect(
        publicAccessForThreatModel({
          owner: "customer",
          repo: "testnet-agent",
          publicReceipt: true,
        }),
      ).toBe("live_protocol_review_required");
    } finally {
      if (oldAllowlist === undefined) delete process.env["ANTFLEET_PUBLIC_THREAT_MODEL_REPOS"];
      else process.env["ANTFLEET_PUBLIC_THREAT_MODEL_REPOS"] = oldAllowlist;
    }
  });

  it("cyber tier hides the threat model regardless of publicReceipt or allowlist", () => {
    const oldAllowlist = process.env["ANTFLEET_PUBLIC_THREAT_MODEL_REPOS"];
    process.env["ANTFLEET_PUBLIC_THREAT_MODEL_REPOS"] = "antfleet/bench-cyber";
    try {
      expect(
        publicAccessForThreatModel({
          owner: "AntFleet",
          repo: "bench-cyber",
          publicReceipt: true,
          cyberTier: "cyber",
        }),
      ).toBe("private");
      // Defense in depth: even an operator-approved repo on the
      // allowlist hides the model when classified cyber.
      expect(
        publicAccessForThreatModel({
          owner: "AntFleet",
          repo: "bench-cyber",
          publicReceipt: true,
          cyberTier: "default",
        }),
      ).toBe("public");
    } finally {
      if (oldAllowlist === undefined) delete process.env["ANTFLEET_PUBLIC_THREAT_MODEL_REPOS"];
      else process.env["ANTFLEET_PUBLIC_THREAT_MODEL_REPOS"] = oldAllowlist;
    }
  });

  it("allows explicit operator approval for public threat-model disclosure", () => {
    const oldAllowlist = process.env["ANTFLEET_PUBLIC_THREAT_MODEL_REPOS"];
    process.env["ANTFLEET_PUBLIC_THREAT_MODEL_REPOS"] = "balancer/balancer-v3-monorepo";
    try {
      expect(
        publicAccessForThreatModel({
          owner: "Balancer",
          repo: "balancer-v3-monorepo",
          publicReceipt: true,
        }),
      ).toBe("public");
    } finally {
      if (oldAllowlist === undefined) delete process.env["ANTFLEET_PUBLIC_THREAT_MODEL_REPOS"];
      else process.env["ANTFLEET_PUBLIC_THREAT_MODEL_REPOS"] = oldAllowlist;
    }
  });

  it("refreshes only sections touched by the changed files", () => {
    const model = generateRepoThreatModel({
      owner: "AntFleet",
      repo: "bench-agent",
      repoHash: "hash",
      sha: "sha-1",
      files: [
        file("app/api/route.ts", "export async function GET() { return Response.json({}); }"),
      ],
    });

    const touched = threatModelSectionsTouched([
      file("src/security/auth.ts", "const boundary = checkPermission();"),
    ]);
    expect(touched).toContain("trustBoundaries");

    const updated = updateRepoThreatModel({
      existing: model,
      sha: "sha-2",
      changedFiles: [file("src/security/auth.ts", "const boundary = checkPermission();")],
    });
    expect(updated.changed).toBe(true);
    expect(updated.refreshedSections).toContain("trustBoundaries");
    expect(updated.document.sections.trustBoundaries.provenance.lastRefreshedSha).toBe("sha-2");
    expect(updated.document.sections.entryPoints.provenance.lastRefreshedSha).toBe("sha-1");
  });

  it("removes stale items for changed files that no longer define a refreshed section", () => {
    const model = generateRepoThreatModel({
      owner: "AntFleet",
      repo: "bench-agent",
      repoHash: "hash",
      sha: "sha-1",
      files: [
        file("app/api/route.ts", "export async function GET() { return Response.json({}); }"),
      ],
    });
    expect(model.sections.entryPoints.items.some((item) => item.path === "app/api/route.ts")).toBe(
      true,
    );

    const updated = updateRepoThreatModel({
      existing: model,
      sha: "sha-2",
      changedFiles: [file("app/api/route.ts", "const removed = true;")],
    });

    expect(updated.changed).toBe(true);
    expect(
      updated.document.sections.entryPoints.items.some((item) => item.path === "app/api/route.ts"),
    ).toBe(false);
  });

  it("removes stale items even when the new file contents no longer trigger refresh rules", () => {
    const model = generateRepoThreatModel({
      owner: "AntFleet",
      repo: "bench-agent",
      repoHash: "hash",
      sha: "sha-1",
      files: [file("scripts/audit.ts", "if (process.argv.includes('--run')) startAudit();")],
    });
    expect(model.sections.entryPoints.items.some((item) => item.path === "scripts/audit.ts")).toBe(
      true,
    );

    const updated = updateRepoThreatModel({
      existing: model,
      sha: "sha-2",
      changedFiles: [file("scripts/audit.ts", "const library = true;")],
    });

    expect(updated.changed).toBe(true);
    expect(
      updated.document.sections.entryPoints.items.some((item) => item.path === "scripts/audit.ts"),
    ).toBe(false);
  });

  it("removes stale items for files absent from the current repo snapshot", () => {
    const model = generateRepoThreatModel({
      owner: "AntFleet",
      repo: "bench-agent",
      repoHash: "hash",
      sha: "sha-1",
      files: [
        file("app/api/route.ts", "export async function GET() { return Response.json({}); }"),
        file("app/api/kept.ts", "export async function POST() { return Response.json({}); }"),
      ],
    });

    const updated = updateRepoThreatModel({
      existing: model,
      sha: "sha-2",
      changedFiles: [],
      repoPaths: ["app/api/kept.ts"],
    });

    expect(updated.changed).toBe(true);
    expect(
      updated.document.sections.entryPoints.items.some((item) => item.path === "app/api/route.ts"),
    ).toBe(false);
    expect(
      updated.document.sections.entryPoints.items.some((item) => item.path === "app/api/kept.ts"),
    ).toBe(true);
  });

  it("keeps items for paths present in the full repo snapshot even when contents are not fetched", () => {
    const model = generateRepoThreatModel({
      owner: "AntFleet",
      repo: "bench-agent",
      repoHash: "hash",
      sha: "sha-1",
      files: [
        file("app/api/route.ts", "export async function GET() { return Response.json({}); }"),
        file("app/api/kept.ts", "export async function POST() { return Response.json({}); }"),
      ],
    });

    const updated = updateRepoThreatModel({
      existing: model,
      sha: "sha-2",
      changedFiles: [],
      repoPaths: ["app/api/route.ts", "app/api/kept.ts"],
    });

    expect(updated.changed).toBe(false);
    expect(
      updated.document.sections.entryPoints.items.some((item) => item.path === "app/api/route.ts"),
    ).toBe(true);
  });

  it("exposes entry points as the reachability input", () => {
    const model = generateRepoThreatModel({
      owner: "AntFleet",
      repo: "bench-agent",
      repoHash: "hash",
      sha: "sha-1",
      files: [
        file("app/api/route.ts", "export async function GET() { return Response.json({}); }"),
      ],
    });
    expect(toReachabilityThreatModel(model)?.entryPoints.items.length).toBeGreaterThan(0);
  });

  it("fails closed when GitHub truncates the recursive repo tree", async () => {
    const getContent = vi.fn();
    await expect(
      getRepoThreatModelFilesWith(
        {
          rest: {
            git: {
              getCommit: async () => ({
                data: { tree: { sha: "tree-sha" } },
              }),
              getTree: async () => ({
                data: {
                  truncated: true,
                  tree: [{ path: "app/api/route.ts", type: "blob", size: 64, sha: "sha" }],
                },
              }),
            },
            repos: {
              getContent,
            },
          },
        },
        { owner: "AntFleet", repo: "bench-agent", sha: "sha-1" },
      ),
    ).rejects.toThrow(/truncated/u);
    expect(getContent).not.toHaveBeenCalled();
  });
});
