import { beforeEach, describe, expect, it } from "vitest";
import { checkInPrompt, firstReviewSummaryPrompt, welcomePrompt } from "./onboarder";

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

  it("includes the three concrete HIGH finding examples and the registry link", () => {
    const out = welcomePrompt({
      owner: "AntFleet",
      repo: "antfleet",
      meta: { description: null, language: null, topics: [] },
    });
    expect(out).toContain("What a finding looks like");
    // One example per distinct category attractor.
    expect(out).toContain("access-control: Allowlist mis-blocks legitimate senders");
    expect(out).toContain("input-validation: Daily spend cap silently bypassed");
    expect(out).toContain("supply-chain: Installer piped an arbitrary URL to sh");
    // Single, real, working registry link — the flagship findings have no
    // per-finding anatomy page, so /receipts is the honest target.
    expect(out).toContain("https://www.antfleet.dev/receipts");
    expect(out).not.toContain("antfleet.dev/anatomy/bitterbot");
  });

  it("explains that silence is the correct outcome for most PRs", () => {
    const out = welcomePrompt({
      owner: "AntFleet",
      repo: "antfleet",
      meta: { description: null, language: null, topics: [] },
    });
    expect(out).toMatch(/Silence is the correct outcome for most PRs/u);
  });
});

describe("checkInPrompt", () => {
  const baseArgs = {
    owner: "AntFleet",
    repo: "antfleet",
    daysElapsed: 7,
    reviewCount: 3,
    findingsAgreed: 0,
    findingsClosed: 0,
    reactionsObserved: 0,
  };

  it("injects the silence reassurance when no finding has fired", () => {
    const out = checkInPrompt(baseArgs);
    expect(out).toMatch(/If no finding has fired yet, that is expected/u);
    expect(out).toContain("both frontier models independently agree");
  });

  it("omits the silence reassurance once a finding has been agreed", () => {
    const out = checkInPrompt({ ...baseArgs, findingsAgreed: 2 });
    expect(out).not.toMatch(/If no finding has fired yet/u);
  });

  it("omits the silence reassurance at the boundary of exactly one agreed finding", () => {
    // Locks the strict `=== 0` contract: a future refactor to `< threshold`
    // would silently re-enable the line at 1 and this test would catch it.
    const out = checkInPrompt({ ...baseArgs, findingsAgreed: 1 });
    expect(out).not.toMatch(/If no finding has fired yet/u);
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
    modelIds: { anthropic: "claude-opus-4-7", openai: "gpt-5.5" },
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
