import { beforeEach, describe, expect, it } from "vitest";
import { firstReviewSummaryPrompt, welcomePrompt } from "./onboarder";

beforeEach(() => {
  process.env["OPTIN_HMAC_SECRET"] = "test-secret-for-onboarder";
});

describe("welcomePrompt", () => {
  it("drops the email opt-in path and points at the one-click link instead", () => {
    const out = welcomePrompt({
      owner: "AntFleet",
      repo: "antfleet",
      meta: { description: null, language: null, topics: [] },
    });
    expect(out).not.toContain("agent@antfleet.dev");
    expect(out).not.toMatch(/email\s+agent@/iu);
    expect(out).toContain("one-click opt-in link");
  });

  it("still mentions public receipts are off by default", () => {
    const out = welcomePrompt({
      owner: "AntFleet",
      repo: "antfleet",
      meta: { description: null, language: null, topics: [] },
    });
    expect(out).toContain("public receipts are off by default");
  });
});

describe("firstReviewSummaryPrompt", () => {
  const baseArgs = {
    owner: "AntFleet",
    repo: "antfleet",
    prNumber: 42,
    perProviderFindingCounts: { anthropic: 3, openai: 4 },
    agreedCount: 2,
    disagreementCount: 5,
    modelIds: { anthropic: "claude-opus-4-7", openai: "gpt-5" },
    optInUrl: "https://www.antfleet.dev/api/opt-in?t=abc.def",
  };

  it("includes the opt-in URL verbatim", () => {
    const out = firstReviewSummaryPrompt(baseArgs);
    expect(out).toContain("https://www.antfleet.dev/api/opt-in?t=abc.def");
  });

  it("instructs the model to render the URL exactly as given", () => {
    const out = firstReviewSummaryPrompt(baseArgs);
    expect(out).toContain("VERBATIM");
    expect(out).toContain("Public receipts opt-in");
  });

  it("instructs the model to frame opt-in as off-by-default", () => {
    const out = firstReviewSummaryPrompt(baseArgs);
    expect(out).toMatch(/off by default/iu);
  });
});
