import { describe, expect, it } from "vitest";
import { runSarifTokenUseGc } from "./sarif-token-use-gc";

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
});
