import { describe, expect, it } from "vitest";
import { databaseHostForLog, migration0031Statements } from "./apply-migration-0031";

describe("migration 0031 static shape", () => {
  it("adds only nullable Patch Agent rationale columns", () => {
    expect(migration0031Statements()).toEqual([
      [
        "ALTER TABLE finding_status",
        "  ADD COLUMN IF NOT EXISTS patch_rationale_opus text,",
        "  ADD COLUMN IF NOT EXISTS patch_rationale_gpt5 text",
      ].join("\n"),
    ]);
  });
});

describe("databaseHostForLog", () => {
  it("logs only host for postgres URLs", () => {
    expect(databaseHostForLog("postgres://user:secret@example.neon.tech/db")).toBe(
      "example.neon.tech",
    );
  });

  it("logs only host for postgresql URLs", () => {
    expect(databaseHostForLog("postgresql://user:secret@example.neon.tech/db")).toBe(
      "example.neon.tech",
    );
  });

  it("does not echo unparseable DATABASE_URL values", () => {
    expect(databaseHostForLog("postgres://user:secret@")).toBe("(unparseable DATABASE_URL)");
  });
});
