import { describe, expect, it } from "vitest";
import {
  isLandedAgentSubmission,
  loadAgentSubmissionStats,
  loadAgentSubmissions,
  loadRepoSubmissionStats,
} from "./agent-submissions";

const AUTONOMOPOLY_TOKEN = "0xB3D7e0c3C39A1D3F1B304663065A2F83Ddf56d8e";
const AUTONOMOPOLY_REPO = "Liquid-Protocol-Ops/agent-autonomopoly";

describe("agent submission ledger", () => {
  it("counts Autonomopoly submissions as the public finding ledger", () => {
    const stats = loadAgentSubmissionStats(AUTONOMOPOLY_TOKEN);

    expect(stats).toMatchObject({
      total: 10,
      open: 3,
      landed: 7,
      latestSubmittedAt: "2026-06-03T22:57:40Z",
    });
  });

  it("counts the same ledger by upstream repo for badges", () => {
    expect(loadRepoSubmissionStats(AUTONOMOPOLY_REPO).total).toBe(10);
  });

  it("treats every non-open PR as landed upstream work", () => {
    const submissions = loadAgentSubmissions(AUTONOMOPOLY_TOKEN);

    expect(submissions.filter(isLandedAgentSubmission)).toHaveLength(7);
  });
});
