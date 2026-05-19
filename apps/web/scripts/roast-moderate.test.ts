import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
  id: string;
  source: string;
  repo_full_name: string;
  submitter_handle: string | null;
  created_at: Date;
  status: string;
  rejection_reason: string | null;
};

const state = vi.hoisted(() => ({
  rows: [] as Row[],
}));

vi.mock("@neondatabase/serverless", () => ({
  Pool: class FakePool {
    query<T>(sql: string, params: unknown[] = []) {
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      if (normalized.startsWith("select id, source")) {
        return Promise.resolve({
          rows: state.rows
            .filter((row) => row.status === params[0])
            .toSorted((a, b) => a.created_at.getTime() - b.created_at.getTime()),
        } as { rows: T[] });
      }
      if (normalized.startsWith("select id, repo_full_name")) {
        return Promise.resolve({
          rows: state.rows
            .filter((row) => row.id === params[0] && row.status === params[1])
            .map(({ id, repo_full_name }) => ({ id, repo_full_name })),
        } as { rows: T[] });
      }
      if (normalized.includes("set status = $2, rejection_reason = $3")) {
        return Promise.resolve(
          updateRow(params[0], params[3], params[1], params[2]) as {
            rows: T[];
          },
        );
      }
      if (normalized.includes("set status = $2")) {
        return Promise.resolve(
          updateRow(params[0], params[2], params[1], null) as {
            rows: T[];
          },
        );
      }
      throw new Error(`unexpected query: ${sql}`);
    }

    end() {
      return Promise.resolve();
    }
  },
}));

function updateRow(id: unknown, fromStatus: unknown, toStatus: unknown, reason: unknown) {
  const row = state.rows.find(
    (candidate) => candidate.id === id && candidate.status === fromStatus,
  );
  if (row === undefined) return { rows: [] };
  row.status = String(toStatus);
  if (reason !== null) row.rejection_reason = String(reason);
  return { rows: [{ id: row.id, repo_full_name: row.repo_full_name }] };
}

async function makePool() {
  const { Pool } = await import("@neondatabase/serverless");
  return new Pool({ connectionString: "postgres://example" });
}

describe("roast-moderate", () => {
  beforeEach(() => {
    vi.resetModules();
    state.rows = [
      {
        id: "awaiting-1",
        source: "public",
        repo_full_name: "owner/repo",
        submitter_handle: "operator",
        created_at: new Date("2026-05-19T10:00:00.000Z"),
        status: "awaiting_approval",
        rejection_reason: null,
      },
      {
        id: "queued-1",
        source: "factory_watcher",
        repo_full_name: "other/repo",
        submitter_handle: null,
        created_at: new Date("2026-05-19T11:00:00.000Z"),
        status: "queued",
        rejection_reason: null,
      },
    ];
    process.env["DATABASE_URL"] = "postgres://user:pass@db.example/antfleet";
    process.exitCode = undefined;
  });

  it("promotes an awaiting_approval row", async () => {
    const { moderateRoastSubmissions } = await import("./roast-moderate");
    const result = await moderateRoastSubmissions(
      ["promote", "awaiting-1", "--apply"],
      await makePool(),
      {
        log: vi.fn(),
      },
    );

    expect(result.rows).toEqual([{ id: "awaiting-1", repo_full_name: "owner/repo" }]);
    expect(state.rows[0]?.status).toBe("queued");
  });

  it("skips promote when the row is not awaiting_approval", async () => {
    const log = vi.fn();
    const { moderateRoastSubmissions } = await import("./roast-moderate");
    const result = await moderateRoastSubmissions(
      ["promote", "queued-1", "--apply"],
      await makePool(),
      {
        log,
      },
    );

    expect(result.rows).toEqual([]);
    expect(process.exitCode).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("skipped"));
  });

  it("reject requires --reason and does not mutate", async () => {
    const { runRoastModerateCli } = await import("./roast-moderate");
    const before = structuredClone(state.rows);

    await runRoastModerateCli(["reject", "awaiting-1", "--apply"]);

    expect(process.exitCode).toBe(1);
    expect(state.rows).toEqual(before);
  });

  it("rejects an awaiting row with a reason", async () => {
    const { moderateRoastSubmissions } = await import("./roast-moderate");
    const result = await moderateRoastSubmissions(
      ["reject", "awaiting-1", "--reason", "false positive", "--apply"],
      await makePool(),
      { log: vi.fn() },
    );

    expect(result.rows).toEqual([{ id: "awaiting-1", repo_full_name: "owner/repo" }]);
    expect(state.rows[0]?.status).toBe("rejected");
    expect(state.rows[0]?.rejection_reason).toBe("false positive");
  });

  it("lists awaiting rows in the expected shape", async () => {
    const { moderateRoastSubmissions } = await import("./roast-moderate");
    const result = await moderateRoastSubmissions(["list"], await makePool(), { log: vi.fn() });

    expect(result.rows).toEqual([
      expect.objectContaining({
        id: "awaiting-1",
        source: "public",
        repo_full_name: "owner/repo",
        submitter_handle: "operator",
        created_at: new Date("2026-05-19T10:00:00.000Z"),
      }),
    ]);
  });
});
