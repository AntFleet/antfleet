// Regression-fixture runner. Pushes each known-safe fixture through the REAL
// two-model review gate (reviewPR) and reports any fixture on which the
// unanimous gate fired — that is a drift signal, since the gate must never
// flag these correct patterns. By reusing reviewPR (not a reimplemented gate),
// fixture behavior tracks real-review behavior exactly: if the live gate logic
// changes, the fixtures inherit the change for free.
//
// COUPLING NOTE: "the gate fired" means the UNANIMOUS gate fired, which today
// requires both providers in review-pipeline's 2-provider STACK to flag the
// same finding (a single model having a bad day cannot fire a fixture alone).
// If a third provider is ever added, `unanimous` requires all three, silently
// raising the bar at which a fixture fires — revisit this suite's sensitivity
// if the STACK size changes.

import { reviewPR } from "./review-pipeline";
import {
  REGRESSION_FIXTURES,
  fixtureFilename,
  type RegressionFixture,
} from "./__regression_fixtures__";
import type { ChangedFile } from "./github-files";
import type { Finding } from "./review-types";

export type FixtureReviewOutcome = {
  // Findings both models independently agreed on. Non-empty == the gate fired
  // on a fixture it should never fire on == drift.
  agreed: Finding[];
  // True when fewer than the required providers succeeded (an API outage, not
  // a gate decision) — the fixture could not be tested this run.
  degraded: boolean;
  degradedReason: string | null;
};

export type FixtureReviewer = (fixture: RegressionFixture) => Promise<FixtureReviewOutcome>;

export type RegressionResult = {
  ran: number;
  passed: number;
  failed: number;
  degraded: number;
  // Fixture ids whose unanimous gate FIRED (the regression we alert on).
  failures: string[];
  // Fixture ids whose review degraded (provider outage — inconclusive, not a
  // regression; surfaced separately so an outage doesn't read as drift).
  degradedFixtures: string[];
  details: Array<{ fixtureId: string; agreedCount: number; degraded: boolean }>;
};

// Production reviewer: run the fixture through the real two-model gate. The
// fixture code becomes the entire "changed file" of a hypothetical PR.
export const realFixtureReviewer: FixtureReviewer = async (fixture) => {
  const file: ChangedFile = {
    filename: fixtureFilename(fixture),
    contents: fixture.code,
    status: "added",
    sha: `fixture-${fixture.id}`,
    patch: null,
  };
  const bundle = await reviewPR({
    files: [file],
    owner: "antfleet",
    repo: "regression-fixtures",
    prNumber: 0,
    mode: "unanimous",
  });
  return {
    agreed: bundle.agreed,
    degraded: bundle.degraded,
    degradedReason: bundle.degradedReason,
  };
};

/**
 * Review every fixture (in parallel) and tally results. A fixture "fails" only
 * when the unanimous gate fired on it. Degraded reviews are tracked but do NOT
 * count as failures — a provider outage is inconclusive, not gate drift.
 */
export async function runRegressionFixtures(
  reviewer: FixtureReviewer = realFixtureReviewer,
  fixtures: readonly RegressionFixture[] = REGRESSION_FIXTURES,
): Promise<RegressionResult> {
  // Parallel: each fixture is 2 LLM calls; the whole suite is ~one review's
  // wall-clock instead of N sequential reviews. Run weekly, so the burst is
  // a dozen calls once every seven days.
  const outcomes = await Promise.all(
    fixtures.map(async (fixture) => ({ fixture, outcome: await reviewer(fixture) })),
  );

  const failures: string[] = [];
  const degradedFixtures: string[] = [];
  const details = outcomes.map(({ fixture, outcome }) => {
    if (outcome.agreed.length > 0) failures.push(fixture.id);
    if (outcome.degraded) degradedFixtures.push(fixture.id);
    return {
      fixtureId: fixture.id,
      agreedCount: outcome.agreed.length,
      degraded: outcome.degraded,
    };
  });

  return {
    ran: fixtures.length,
    passed: fixtures.length - failures.length,
    failed: failures.length,
    degraded: degradedFixtures.length,
    failures,
    degradedFixtures,
    details,
  };
}
