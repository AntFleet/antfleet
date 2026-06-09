import { describe, expect, it } from "vitest";
import { databaseHostForLog, migration0035Statements } from "./apply-migration-0035";

describe("migration 0035 static shape", () => {
  it("adds only nullable Patch Agent per-side skip-reason columns and checks", () => {
    expect(migration0035Statements()).toEqual([
      ["ALTER TABLE finding_status", "  ADD COLUMN IF NOT EXISTS patch_skip_reason_opus text"].join(
        "\n",
      ),
      ["ALTER TABLE finding_status", "  ADD COLUMN IF NOT EXISTS patch_skip_reason_gpt5 text"].join(
        "\n",
      ),
      [
        "DO $$",
        "BEGIN",
        "  ALTER TABLE finding_status",
        "    ADD CONSTRAINT finding_status_patch_skip_reason_opus_check",
        "    CHECK (",
        "      patch_skip_reason_opus IS NULL",
        "      OR patch_skip_reason_opus IN (",
        "        'models_disagreed', 'outside_diff_hunk', 'generation_error', 'disabled', 'size_cap'",
        "      )",
        "    );",
        "EXCEPTION",
        "  WHEN duplicate_object THEN NULL;",
        "END $$",
      ].join("\n"),
      [
        "DO $$",
        "BEGIN",
        "  ALTER TABLE finding_status",
        "    ADD CONSTRAINT finding_status_patch_skip_reason_gpt5_check",
        "    CHECK (",
        "      patch_skip_reason_gpt5 IS NULL",
        "      OR patch_skip_reason_gpt5 IN (",
        "        'models_disagreed', 'outside_diff_hunk', 'generation_error', 'disabled', 'size_cap'",
        "      )",
        "    );",
        "EXCEPTION",
        "  WHEN duplicate_object THEN NULL;",
        "END $$",
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
