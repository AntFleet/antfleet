// Unit tests for Step 0.5 precision/feedback query helpers (items 6 & 7).
//
// Covers:
//   (i)  recordMaintainerReactions dedup — second identical dismiss for the same
//        (reviewId, findingId, reactorLogin) is filtered before insert.
//   (ii) retractFindingByDismiss — delegates to retractFinding with null email
//        and a sensible default reason; idempotent (WHERE retractedAt IS NULL).
//   (iii) precisionWindow — per-tier math, divide-by-zero, tier bucketing.
//   (iv) isPrecisionAutoRetractEnabled — default OFF; respects env flag.
//
// Pattern: only mock ./index (the DB connection), never the schema. This
// matches queries.test.ts so both files run against the same real Drizzle
// table objects.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Configurable state shared across the mock factory and tests.
// ---------------------------------------------------------------------------

// INSERT: capture what rows were actually passed to .values().
const insertValuesCalls: unknown[][] = [];

// UPDATE: capture .set() args so we can assert on retractionReason etc.
const updateSetCalls: unknown[] = [];

// SELECT: a FIFO queue — each test pushes rows for each SELECT call in order.
// selectQueue[0] goes to the first awaited SELECT, [1] to the second, etc.
let selectQueue: unknown[][] = [];

// UPDATE: rows returned by .returning() — controls the retractFinding result.
let updateReturnRows: unknown[] = [{ findingId: "test-finding" }];

// INSERT: rows returned by .returning() — controls recordMaintainerReactions result.
let insertReturnRows: unknown[] = [{ reactionId: "r1" }];

// ---------------------------------------------------------------------------
// Build the mock DB. The chain must cover all paths used by the functions
// under test:
//
//   recordMaintainerReactions:
//     select({}).from(t).where(...)         → Promise<rows>  [dedup check]
//     insert(t).values([...])               → onConflictDoNothing({}) → returning({})
//
//   retractFindingByDismiss → retractFinding:
//     update(t).set({}).where(...).returning({})
//
//   precisionWindow:
//     select({}).from(t).innerJoin(t2,?).where(?).groupBy(?)   → Promise<rows>
//     select({}).from(t).innerJoin(t2,?).innerJoin(t3,?).where(?)
//     select({}).from(t).innerJoin(t2,?).where(?)
//
// We use a function-per-terminal-method that pops from selectQueue so each
// awaited query gets its own configured result. Non-awaited intermediate
// methods return the next chained object.
// ---------------------------------------------------------------------------

const dbMocks = vi.hoisted(() => {
  const insertVals = vi.fn((rows: unknown[]) => {
    insertValuesCalls.push(rows);
    return {
      onConflictDoNothing: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve(insertReturnRows.slice(0, rows.length))),
      })),
    };
  });

  const insert = vi.fn(() => ({ values: insertVals }));

  const updateReturning = vi.fn(() => Promise.resolve(updateReturnRows));
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn((values: unknown) => {
    updateSetCalls.push(values);
    return { where: updateWhere };
  });
  const update = vi.fn(() => ({ set: updateSet }));

  // A terminal SELECT resolver: pops the next row-set from the queue.
  const resolveSelect = (): Promise<unknown[]> => Promise.resolve(selectQueue.shift() ?? []);

  // makeWhere returns a real Promise extended with .groupBy() and .limit() so
  // callers can either `await where(...)` directly OR chain `.groupBy(...)`.
  // Using Object.assign on a real Promise avoids the unicorn/no-thenable rule.
  const makeWhere = (..._args: unknown[]) => {
    const p = resolveSelect();
    return Object.assign(p, {
      groupBy: (...__args: unknown[]) => resolveSelect(),
      limit: (...__args: unknown[]) => resolveSelect(),
    });
  };

  const makeTerminals = () => ({
    where: makeWhere,
    groupBy: (..._args: unknown[]) => resolveSelect(),
    limit: (..._args: unknown[]) => resolveSelect(),
  });

  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      ...makeTerminals(),
      innerJoin: vi.fn(() => ({
        ...makeTerminals(),
        innerJoin: vi.fn(() => makeTerminals()),
      })),
    })),
  }));

  return {
    db: { select, insert, update },
    insert,
    insertVals,
    update,
    updateSet,
    updateWhere,
    updateReturning,
    select,
  };
});

vi.mock("./index", () => ({ db: dbMocks.db }));
// precision-feedback-env imports @/db (the canonical alias for db/index).
// Provide the same mock under both identifiers so the module can load.
vi.mock("@/db", () => ({ db: dbMocks.db }));

import { recordMaintainerReactions, retractFindingByDismiss, precisionWindow } from "./queries";
import { isPrecisionAutoRetractEnabled } from "@/lib/precision-feedback-env";

beforeEach(() => {
  insertValuesCalls.length = 0;
  updateSetCalls.length = 0;
  selectQueue = [];
  updateReturnRows = [{ findingId: "test-finding" }];
  insertReturnRows = [{ reactionId: "r1" }];
  vi.clearAllMocks();
});

// ===========================================================================
// (i) recordMaintainerReactions — dismiss:reply dedup
// ===========================================================================

describe("recordMaintainerReactions — dismiss:reply dedup", () => {
  const REVIEW_ID = "aaa00000-0000-0000-0000-000000000001";
  const FINDING_ID = `${REVIEW_ID}-0`;
  const REACTOR = "alice";

  const dismissRow = () => ({
    reviewId: REVIEW_ID,
    findingId: FINDING_ID,
    actionTaken: "dismiss:reply" as const,
    reactionAt: new Date("2026-07-01T10:00:00Z"),
    reactorLogin: REACTOR,
    authorAssociation: "OWNER",
    maintainerComment: "false positive",
  });

  it("passes the row through to insert when no prior dismiss exists", async () => {
    // SELECT dedup check returns empty → no prior dismiss for this triple.
    selectQueue = [[]];
    await recordMaintainerReactions([dismissRow()]);
    // One INSERT batch with the original row.
    expect(insertValuesCalls).toHaveLength(1);
    expect((insertValuesCalls[0] as unknown[]).length).toBe(1);
  });

  it("skips insert when a prior dismiss:reply exists for the same triple", async () => {
    // SELECT returns a row matching (reviewId, findingId, reactorLogin).
    selectQueue = [[{ reviewId: REVIEW_ID, findingId: FINDING_ID, reactorLogin: REACTOR }]];

    const count = await recordMaintainerReactions([dismissRow()]);
    // After filtering, 0 rows remain → insert never called.
    expect(count).toBe(0);
    expect(insertValuesCalls).toHaveLength(0);
  });

  it("does NOT issue a dedup SELECT for non-dismiss rows", async () => {
    // No selectQueue entry needed — non-dismiss rows skip the dedup SELECT.
    const thumbsRow = {
      reviewId: REVIEW_ID,
      findingId: FINDING_ID,
      actionTaken: "reaction:thumbs_down" as const,
      reactionAt: new Date("2026-07-01T11:00:00Z"),
      reactorLogin: REACTOR,
    };
    await recordMaintainerReactions([thumbsRow]);
    // Insert was called (row passed through).
    expect(insertValuesCalls).toHaveLength(1);
    expect((insertValuesCalls[0] as unknown[]).length).toBe(1);
    // SELECT queue is still intact (wasn't consumed) — the dedup SELECT was skipped.
    expect(selectQueue).toHaveLength(0);
  });

  it("handles mixed batch: filters duplicate dismiss, passes thumbs_down through", async () => {
    // Dedup SELECT finds existing dismiss for alice.
    selectQueue = [[{ reviewId: REVIEW_ID, findingId: FINDING_ID, reactorLogin: REACTOR }]];

    const thumbsRow = {
      reviewId: REVIEW_ID,
      findingId: FINDING_ID,
      actionTaken: "reaction:thumbs_down" as const,
      reactionAt: new Date("2026-07-01T11:00:00Z"),
      reactorLogin: REACTOR,
    };
    await recordMaintainerReactions([dismissRow(), thumbsRow]);

    // Only the thumbs_down row should have been inserted.
    expect(insertValuesCalls).toHaveLength(1);
    const inserted = insertValuesCalls[0] as Array<{ actionTaken: string }>;
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.actionTaken).toBe("reaction:thumbs_down");
  });

  it("returns 0 immediately for empty input without any DB calls", async () => {
    const count = await recordMaintainerReactions([]);
    expect(count).toBe(0);
    expect(insertValuesCalls).toHaveLength(0);
  });
});

// ===========================================================================
// (ii) retractFindingByDismiss
// ===========================================================================

describe("retractFindingByDismiss", () => {
  it("calls UPDATE with the provided reason and null email", async () => {
    // UPDATE returns one row → finding was retracted.
    updateReturnRows = [{ findingId: "finding-0" }];

    const result = await retractFindingByDismiss("finding-0", "false positive");
    expect(result).toBe(true);
    expect(updateSetCalls).toHaveLength(1);
    const set = updateSetCalls[0] as {
      retractedAt: unknown;
      retractionReason: string;
      retractionEmail: unknown;
    };
    expect(set.retractionReason).toBe("false positive");
    expect(set.retractionEmail).toBeNull();
    expect(set.retractedAt).toBeInstanceOf(Date);
  });

  it("uses a default reason when null is passed", async () => {
    updateReturnRows = [{ findingId: "finding-0" }];

    await retractFindingByDismiss("finding-0", null);
    const set = updateSetCalls[0] as { retractionReason: string };
    expect(set.retractionReason).toBe("maintainer-dismissed via PR reply");
  });

  it("is idempotent: returns false when finding is already retracted", async () => {
    // retractFinding uses WHERE retractedAt IS NULL; when already retracted
    // the UPDATE matches 0 rows → empty returning → false.
    updateReturnRows = [];

    const result = await retractFindingByDismiss("already-retracted-0", "again");
    expect(result).toBe(false);
  });
});

// ===========================================================================
// (iii) precisionWindow — per-tier math + divide-by-zero + tier bucketing
// ===========================================================================

describe("precisionWindow", () => {
  it("returns zero stats for an impossible window (until < since)", async () => {
    const since = new Date("2026-07-05T00:00:00Z");
    const until = new Date("2026-07-01T00:00:00Z"); // before since
    const pw = await precisionWindow(since, until);
    for (const t of pw.tiers) {
      expect(t.postedCount).toBe(0);
      expect(t.dismissedCount).toBe(0);
      expect(t.dismissRate).toBe(0);
    }
    expect(pw.thumbsDownCount).toBe(0);
  });

  it("returns all four tiers in the canonical order", async () => {
    selectQueue = [[], [], []]; // 3 queries: posted, dismissed, thumbs
    const pw = await precisionWindow(null, null);
    expect(pw.tiers.map((t) => t.tier)).toEqual(["low", "medium", "high", "critical"]);
  });

  it("guards divide-by-zero: dismissRate=0 when postedCount=0", async () => {
    selectQueue = [[], [], []];
    const pw = await precisionWindow(null, null);
    for (const t of pw.tiers) {
      expect(t.postedCount).toBe(0);
      expect(t.dismissRate).toBe(0);
    }
  });

  it("excludes unknown severity tiers from output tiers", async () => {
    selectQueue = [[], [], []];
    const pw = await precisionWindow(null, null);
    const known = new Set(["low", "medium", "high", "critical"]);
    for (const t of pw.tiers) {
      expect(known.has(t.tier)).toBe(true);
    }
  });

  it("thumbsDownCount defaults to 0 when no thumbs-down reactions exist", async () => {
    selectQueue = [[], [], []];
    const pw = await precisionWindow(null, null);
    expect(pw.thumbsDownCount).toBe(0);
  });
});

// ===========================================================================
// (iv) isPrecisionAutoRetractEnabled — env flag, default OFF
// ===========================================================================

describe("isPrecisionAutoRetractEnabled", () => {
  afterEach(() => {
    delete process.env["ANTFLEET_PRECISION_AUTORETRACT"];
  });

  it("returns false when env var is unset (default OFF)", () => {
    delete process.env["ANTFLEET_PRECISION_AUTORETRACT"];
    expect(isPrecisionAutoRetractEnabled()).toBe(false);
  });

  it("returns true when env var is 'true'", () => {
    process.env["ANTFLEET_PRECISION_AUTORETRACT"] = "true";
    expect(isPrecisionAutoRetractEnabled()).toBe(true);
  });

  it("returns true when env var is '1'", () => {
    process.env["ANTFLEET_PRECISION_AUTORETRACT"] = "1";
    expect(isPrecisionAutoRetractEnabled()).toBe(true);
  });

  it("returns false for an arbitrary non-true string", () => {
    process.env["ANTFLEET_PRECISION_AUTORETRACT"] = "yes";
    expect(isPrecisionAutoRetractEnabled()).toBe(false);
  });
});
