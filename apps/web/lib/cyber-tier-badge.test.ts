import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Behavioral guarantee for the public badge SVG surface: when the repo
// is classified cyber, countFindingsForRepo MUST return 0 — not even a
// nonzero submission-stat total may leak. Pass-4 audit caught the
// regression where the cyber branch returned `Math.max(0, submissions)`
// which could surface a nonzero count for cyber repos with seeded
// submissions.

const mockSubmissionStats = vi.fn();
const mockSelect = vi.fn();
const mockIsCyberTierRepo = vi.fn();

vi.mock("@/db/index", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => mockSelect(),
      }),
    }),
  },
}));

vi.mock("./agent-submissions", () => ({
  loadRepoSubmissionStats: (repo: string) => mockSubmissionStats(repo),
}));

vi.mock("./cyber-tier", () => ({
  isCyberTierRepo: (...args: unknown[]) => mockIsCyberTierRepo(...args),
}));

describe("countFindingsForRepo — cyber-tier badge zero-count guarantee", () => {
  beforeEach(() => {
    mockSubmissionStats.mockReset();
    mockSelect.mockReset();
    mockIsCyberTierRepo.mockReset();
  });
  afterEach(() => {
    vi.resetModules();
  });

  test("returns 0 for cyber repo even when submission stats are nonzero", async () => {
    mockIsCyberTierRepo.mockResolvedValue(true);
    mockSubmissionStats.mockReturnValue({ total: 42, latestSubmittedAt: null });
    // The DB query should NOT be reached at all when cyber returns true.
    mockSelect.mockResolvedValue([{ count: 17 }]);
    const { countFindingsForRepo } = await import("./identity-drift");
    const n = await countFindingsForRepo("AntFleet/bench-cyber");
    expect(n).toBe(0);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  test("returns max(db_count, submission_total) for non-cyber repos", async () => {
    mockIsCyberTierRepo.mockResolvedValue(false);
    mockSubmissionStats.mockReturnValue({ total: 3, latestSubmittedAt: null });
    mockSelect.mockResolvedValue([{ count: 8 }]);
    const { countFindingsForRepo } = await import("./identity-drift");
    const n = await countFindingsForRepo("AntFleet/aeon-bench");
    expect(n).toBe(8);
  });

  test("returns submission total when db count is zero (non-cyber)", async () => {
    mockIsCyberTierRepo.mockResolvedValue(false);
    mockSubmissionStats.mockReturnValue({ total: 5, latestSubmittedAt: null });
    mockSelect.mockResolvedValue([{ count: 0 }]);
    const { countFindingsForRepo } = await import("./identity-drift");
    const n = await countFindingsForRepo("AntFleet/aeon-bench");
    expect(n).toBe(5);
  });
});
