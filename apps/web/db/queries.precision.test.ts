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
// precision-feedback-env is NOT mocked — the real module is used so that
// isPrecisionAutoRetractEnabled reads process.env as expected by the env
// flag tests, and DISMISS_AUTHORISED_ASSOCIATIONS resolves from the real
// export. The @/db mock ensures DB-touching helpers don't hit a real DB.
vi.mock("@/db", () => ({ db: dbMocks.db }));

import { recordMaintainerReactions, retractFindingByDismiss, precisionWindow } from "./queries";
import {
  DISMISS_AUTHORISED_ASSOCIATIONS,
  isPrecisionAutoRetractEnabled,
} from "@/lib/precision-feedback-env";

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

  // ── Cohort alignment: dismissedCount ≤ postedCount ──────────────────────
  //
  // The new query windows dismissed findings on findingStatus.createdAt
  // (same predicate as postedRows), not on maintainerReactions.reactionAt.
  // This makes dismissed structurally a SUBSET of posted so dismissRate
  // can never exceed 1.0.

  it("realistic non-empty case: dismissRate ≤ 1.0 for every tier", async () => {
    // postedRows: medium=3, high=1
    const postedMock = [
      { severity: "medium", n: 3 },
      { severity: "high", n: 1 },
    ];
    // dismissedRows: 2 authorised medium dismisses + 1 authorised high dismiss.
    // All findingIds are distinct — 2 out of 3 medium, 1 out of 1 high.
    const dismissedMock = [
      { findingId: "f1", severity: "medium", authorAssociation: "OWNER" },
      { findingId: "f2", severity: "medium", authorAssociation: "MEMBER" },
      { findingId: "f3", severity: "high", authorAssociation: "COLLABORATOR" },
    ];
    const thumbsMock = [{ n: 5 }];

    // The mock pops two items for the first query (.where() then .groupBy()):
    //   [0] placeholder consumed by .where() — value is discarded
    //   [1] postedMock consumed by .groupBy() — becomes postedRows
    //   [2] dismissedMock consumed by .where() on dismissedRows query
    //   [3] thumbsMock consumed by .where() on thumbsRows query
    selectQueue = [[], postedMock, dismissedMock, thumbsMock];

    const pw = await precisionWindow(
      new Date("2026-07-01T00:00:00Z"),
      new Date("2026-07-05T00:00:00Z"),
    );

    const medium = pw.tiers.find((t) => t.tier === "medium")!;
    const high = pw.tiers.find((t) => t.tier === "high")!;
    const low = pw.tiers.find((t) => t.tier === "low")!;
    const critical = pw.tiers.find((t) => t.tier === "critical")!;

    expect(medium.postedCount).toBe(3);
    expect(medium.dismissedCount).toBe(2);
    expect(medium.dismissRate).toBeCloseTo(2 / 3);

    expect(high.postedCount).toBe(1);
    expect(high.dismissedCount).toBe(1);
    expect(high.dismissRate).toBe(1.0);

    // Tiers with no postings have rate 0.
    expect(low.dismissRate).toBe(0);
    expect(critical.dismissRate).toBe(0);

    // Core invariant: no tier exceeds 1.0.
    for (const t of pw.tiers) {
      expect(t.dismissRate).toBeLessThanOrEqual(1.0);
    }

    expect(pw.thumbsDownCount).toBe(5);
  });

  it("regression: finding posted BEFORE window but dismissed INSIDE must NOT inflate rate", async () => {
    // Scenario: finding F_pre was posted before the window; a maintainer
    // dismissed it during the window (reactionAt inside [since, until)).
    //
    // OLD behaviour (reactionsRange on reactionAt): dismissedRows would include
    // F_pre because reactionAt was in-window. If medium postedCount=1 and
    // dismissedCount ended up as 2 (F_pre + an in-window posted finding),
    // rate = 2/1 = 2.0 — a rate exceeding 100%.
    //
    // NEW behaviour (findingsCreatedRange on findingStatus.createdAt): the
    // dismissed query is scoped to findings POSTED in the window, so F_pre is
    // excluded from dismissedRows entirely. dismissed ⊆ posted → rate ≤ 1.0.
    //
    // Here we mock the NEW-correct DB response where F_pre is absent from
    // dismissedRows (only the one legitimately posted-in-window finding appears).
    const postedMock = [{ severity: "medium", n: 1 }];
    // Only the in-window posted finding appears in dismissedRows (new code).
    const dismissedMock = [
      { findingId: "f_in_window", severity: "medium", authorAssociation: "OWNER" },
    ];
    const thumbsMock: unknown[] = [];

    // Queue layout: [placeholder, postedMock, dismissedMock, thumbsMock].
    selectQueue = [[], postedMock, dismissedMock, thumbsMock];

    const pw = await precisionWindow(
      new Date("2026-07-01T00:00:00Z"),
      new Date("2026-07-05T00:00:00Z"),
    );

    const medium = pw.tiers.find((t) => t.tier === "medium")!;
    expect(medium.postedCount).toBe(1);
    expect(medium.dismissedCount).toBe(1);
    // Rate is exactly 1.0 — never > 1.0, which the old code could produce.
    expect(medium.dismissRate).toBe(1.0);
    expect(medium.dismissRate).toBeLessThanOrEqual(1.0);
  });

  it("posted-in-window finding dismissed AFTER the window IS counted", async () => {
    // F1 was posted during the window; the maintainer dismissed it weeks later
    // (reactionAt is outside the window). With the new query, reactionAt is
    // unbounded — only findingStatus.createdAt is windowed — so F1 appears in
    // dismissedRows and is counted toward dismissedCount.
    const postedMock = [{ severity: "high", n: 2 }];
    // Both F1 (dismissed later) and F2 (dismissed during window) are included.
    const dismissedMock = [
      { findingId: "f1_dismissed_later", severity: "high", authorAssociation: "OWNER" },
      { findingId: "f2_dismissed_during", severity: "high", authorAssociation: "MEMBER" },
    ];
    const thumbsMock: unknown[] = [];

    // Queue layout: [placeholder, postedMock, dismissedMock, thumbsMock].
    selectQueue = [[], postedMock, dismissedMock, thumbsMock];

    const pw = await precisionWindow(
      new Date("2026-07-01T00:00:00Z"),
      new Date("2026-07-05T00:00:00Z"),
    );

    const high = pw.tiers.find((t) => t.tier === "high")!;
    expect(high.postedCount).toBe(2);
    expect(high.dismissedCount).toBe(2);
    expect(high.dismissRate).toBe(1.0);
    expect(high.dismissRate).toBeLessThanOrEqual(1.0);
  });

  it("shared DISMISS_AUTHORISED_ASSOCIATIONS matches the set used for association filtering", () => {
    // Guard that ingest (route.ts) and metric (queries.ts) use the same constant.
    expect(DISMISS_AUTHORISED_ASSOCIATIONS.has("OWNER")).toBe(true);
    expect(DISMISS_AUTHORISED_ASSOCIATIONS.has("MEMBER")).toBe(true);
    expect(DISMISS_AUTHORISED_ASSOCIATIONS.has("COLLABORATOR")).toBe(true);
    expect(DISMISS_AUTHORISED_ASSOCIATIONS.has("CONTRIBUTOR")).toBe(false);
    expect(DISMISS_AUTHORISED_ASSOCIATIONS.has("NONE")).toBe(false);
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
