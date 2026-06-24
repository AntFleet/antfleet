import { describe, expect, it } from "vitest";
import {
  runSarifTokenUseGc,
  SARIF_TOKEN_USE_GC_BATCH_SIZE,
  SARIF_TOKEN_USE_GC_MAX_BATCHES,
} from "./sarif-token-use-gc";

describe("runSarifTokenUseGc", () => {
  it("purges only token-use rows older than one hour", async () => {
    const rows = [
      { jti: "old", usedAt: new Date("2026-06-24T10:59:59.000Z") },
      { jti: "boundary", usedAt: new Date("2026-06-24T11:00:00.000Z") },
      { jti: "recent", usedAt: new Date("2026-06-24T11:30:00.000Z") },
    ];

    const result = await runSarifTokenUseGc(
      {
        purgeBefore: async (cutoff) => {
          let deleted = 0;
          for (let index = rows.length - 1; index >= 0; index -= 1) {
            const row = rows[index];
            if (row !== undefined && row.usedAt < cutoff) {
              rows.splice(index, 1);
              deleted += 1;
            }
          }
          return deleted;
        },
      },
      new Date("2026-06-24T12:00:00.000Z"),
    );

    expect(result).toEqual({
      deleted: 1,
      cutoff: new Date("2026-06-24T11:00:00.000Z"),
    });
    expect(rows.map((row) => row.jti)).toEqual(["boundary", "recent"]);
  });

  it("deletes more than one batch across multiple DB calls", async () => {
    let expiredRows = SARIF_TOKEN_USE_GC_BATCH_SIZE + 275;
    const batchSizes: number[] = [];

    const result = await runSarifTokenUseGc({
      purgeBefore: async () => {
        const deleted = Math.min(expiredRows, SARIF_TOKEN_USE_GC_BATCH_SIZE);
        expiredRows -= deleted;
        batchSizes.push(deleted);
        return deleted;
      },
    });

    expect(result.deleted).toBe(SARIF_TOKEN_USE_GC_BATCH_SIZE + 275);
    expect(batchSizes).toEqual([SARIF_TOKEN_USE_GC_BATCH_SIZE, 275]);
  });

  it("deletes one non-empty batch when at most one batch is expired", async () => {
    const batchSizes = [427];
    const calls: number[] = [];

    const result = await runSarifTokenUseGc({
      purgeBefore: async () => {
        const deleted = batchSizes.shift() ?? 0;
        calls.push(deleted);
        return deleted;
      },
    });

    expect(result.deleted).toBe(427);
    expect(calls).toEqual([427]);
  });

  it("caps one cron run so concurrent inserts wait on at most one batch lock scope", async () => {
    let activeBatches = 0;
    let maxActiveBatches = 0;
    const calls: number[] = [];

    const result = await runSarifTokenUseGc({
      purgeBefore: async () => {
        activeBatches += 1;
        maxActiveBatches = Math.max(maxActiveBatches, activeBatches);
        calls.push(SARIF_TOKEN_USE_GC_BATCH_SIZE);
        activeBatches -= 1;
        return SARIF_TOKEN_USE_GC_BATCH_SIZE;
      },
    });

    expect(result.deleted).toBe(SARIF_TOKEN_USE_GC_BATCH_SIZE * SARIF_TOKEN_USE_GC_MAX_BATCHES);
    expect(calls).toHaveLength(SARIF_TOKEN_USE_GC_MAX_BATCHES);
    expect(maxActiveBatches).toBe(1);
  });
});
