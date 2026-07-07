// Win 2 — persistence/coupling tests for the single-model shadow tier.
//
// Verifies:
//   • makeShadowFindingId uses the distinct `-s` namespace (never collides
//     with the consensus `${reviewId}-${index}` id).
//   • recordSingleModelFindingStatuses tags every row source='single_model'
//     and uses the shadow id namespace, so it can never be reconciled against
//     the consensus agreed[] index space.
//
// Pattern: mock ./index (+@/db) only — the real Drizzle schema objects are
// used so the column references resolve. A transaction-capable stub captures
// the INSERT .values() payload.

import { beforeEach, describe, expect, it, vi } from "vitest";

const insertValuesCalls = vi.hoisted(() => ({ rows: [] as unknown[][] }));
let selectQueue: unknown[][] = [];

vi.mock("./index", () => {
  const resolveSelect = (): Promise<unknown[]> => Promise.resolve(selectQueue.shift() ?? []);
  const makeWhere = (..._a: unknown[]) =>
    Object.assign(resolveSelect(), { orderBy: (..._b: unknown[]) => resolveSelect() });
  const tx = {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: makeWhere })) })),
    insert: vi.fn(() => ({
      values: vi.fn((rows: unknown[]) => {
        insertValuesCalls.rows.push(rows);
        return { onConflictDoUpdate: vi.fn(() => Promise.resolve()) };
      }),
    })),
    delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
  };
  return {
    db: {
      transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
});

import { makeShadowFindingId, recordSingleModelFindingStatuses } from "./queries";

const REVIEW_ID = "aaaa1111-0000-0000-0000-000000000001";

beforeEach(() => {
  insertValuesCalls.rows.length = 0;
  selectQueue = [];
});

describe("makeShadowFindingId", () => {
  it("uses the `-s` namespace, distinct from the consensus id format", () => {
    expect(makeShadowFindingId(REVIEW_ID, 0)).toBe(`${REVIEW_ID}-s0`);
    expect(makeShadowFindingId(REVIEW_ID, 3)).toBe(`${REVIEW_ID}-s3`);
    // The consensus id at the SAME index is `${reviewId}-0` — never equal.
    expect(makeShadowFindingId(REVIEW_ID, 0)).not.toBe(`${REVIEW_ID}-0`);
  });
});

describe("recordSingleModelFindingStatuses", () => {
  it("tags every row source='single_model' with `-s` finding ids", async () => {
    // preselect existing (empty), then re-select returns the persisted ids.
    selectQueue = [[], [], [{ findingId: `${REVIEW_ID}-s0` }, { findingId: `${REVIEW_ID}-s1` }]];
    const ids = await recordSingleModelFindingStatuses(REVIEW_ID, [
      { title: "A", severity: "high", category: "security" },
      { title: "B", severity: "critical", category: "bug" },
    ]);

    expect(insertValuesCalls.rows).toHaveLength(1);
    const rows = insertValuesCalls.rows[0] as Array<{
      findingId: string;
      source: string;
      findingIndex: number;
    }>;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.source).toBe("single_model");
      expect(r.findingId).toBe(`${REVIEW_ID}-s${r.findingIndex}`);
    }
    expect(ids).toEqual([`${REVIEW_ID}-s0`, `${REVIEW_ID}-s1`]);
  });

  it("returns [] and inserts nothing for an empty shadow set", async () => {
    selectQueue = [[]]; // only the preselect runs
    const ids = await recordSingleModelFindingStatuses(REVIEW_ID, []);
    expect(ids).toEqual([]);
    expect(insertValuesCalls.rows).toHaveLength(0);
  });
});
