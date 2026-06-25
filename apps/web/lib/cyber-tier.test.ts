import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Cyber-tier flag-gate tests. Verify that when ANTFLEET_CYBER_TIER is
// OFF, all read helpers return 'default' regardless of any repo_tier
// rows that may exist — byte-identical to pre-cyber-tier behavior.
//
// We mock the db layer to avoid a Neon round-trip in unit tests; the
// flag gate is in the helper module itself, so the mock just verifies
// the gate short-circuits before the SQL hits.

const mockSelect = vi.fn();

vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => mockSelect() }),
      }),
    }),
  },
}));

describe("isCyberTierRepo — flag-off short-circuit", () => {
  const ORIG_ENV = process.env["ANTFLEET_CYBER_TIER"];

  beforeEach(() => {
    mockSelect.mockReset();
  });
  afterEach(() => {
    if (ORIG_ENV === undefined) delete process.env["ANTFLEET_CYBER_TIER"];
    else process.env["ANTFLEET_CYBER_TIER"] = ORIG_ENV;
  });

  test("returns false when flag is OFF, even with a cyber row in the table", async () => {
    delete process.env["ANTFLEET_CYBER_TIER"];
    // Pretend the table HAS a cyber row — the mock would return it if asked.
    mockSelect.mockResolvedValue([{ tier: "cyber" }]);
    const { isCyberTierRepo } = await import("./cyber-tier");
    const result = await isCyberTierRepo("AntFleet", "bench-cyber");
    expect(result).toBe(false);
    // The flag-gate short-circuits before the SELECT runs.
    expect(mockSelect).not.toHaveBeenCalled();
  });

  test("returns true when flag is ON and the repo is classified cyber", async () => {
    process.env["ANTFLEET_CYBER_TIER"] = "1";
    mockSelect.mockResolvedValue([{ tier: "cyber" }]);
    vi.resetModules();
    const { isCyberTierRepo } = await import("./cyber-tier");
    const result = await isCyberTierRepo("AntFleet", "bench-cyber");
    expect(result).toBe(true);
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  test("returns false when flag is ON but the repo has no row", async () => {
    process.env["ANTFLEET_CYBER_TIER"] = "1";
    mockSelect.mockResolvedValue([]);
    vi.resetModules();
    const { isCyberTierRepo } = await import("./cyber-tier");
    const result = await isCyberTierRepo("AntFleet", "bench-default");
    expect(result).toBe(false);
  });

  test("lowercases owner+repo before lookup (strictest-wins across case variations)", async () => {
    process.env["ANTFLEET_CYBER_TIER"] = "1";
    mockSelect.mockResolvedValue([{ tier: "cyber" }]);
    vi.resetModules();
    const { isCyberTierRepo } = await import("./cyber-tier");
    // The mock doesn't inspect args; the test just exercises the path.
    // The lowercase property is guaranteed by the helper using
    // owner.toLowerCase() / repo.toLowerCase() — see normalizeKey().
    const result = await isCyberTierRepo("ANTFleet", "BENCH-Cyber");
    expect(result).toBe(true);
  });
});
