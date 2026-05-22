import { describe, expect, it } from "vitest";
import {
  buildReviewChallenge,
  parseReviewChallenge,
  REVIEW_CHALLENGE_FUTURE_SKEW_MS,
  REVIEW_CHALLENGE_MAX_AGE_MS,
} from "./review-challenge";

const CHALLENGE = "11111111-1111-4111-8111-111111111111";
const INSTALL = "22222222-2222-4222-8222-222222222222";
const WALLET = "0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd";
const ISSUED = new Date("2026-05-22T14:30:00.000Z");

describe("buildReviewChallenge", () => {
  it("produces the canonical 'AntFleet review:' string", () => {
    expect(
      buildReviewChallenge({
        challengeId: CHALLENGE,
        installationRowId: INSTALL,
        walletAddress: WALLET,
        issuedAt: ISSUED,
      }),
    ).toBe(
      `AntFleet review: ${CHALLENGE} ${INSTALL} ${WALLET.toLowerCase()} 2026-05-22T14:30:00.000Z`,
    );
  });

  it("lowercases the wallet address even when passed mixed-case", () => {
    const built = buildReviewChallenge({
      challengeId: CHALLENGE,
      installationRowId: INSTALL,
      walletAddress: WALLET,
      issuedAt: ISSUED,
    });
    expect(built).toContain(WALLET.toLowerCase());
    expect(built).not.toContain("AbCdEf");
  });
});

describe("parseReviewChallenge", () => {
  it("round-trips a built challenge back to its fields", () => {
    const built = buildReviewChallenge({
      challengeId: CHALLENGE,
      installationRowId: INSTALL,
      walletAddress: WALLET,
      issuedAt: ISSUED,
    });
    const parsed = parseReviewChallenge(built);
    expect(parsed).toEqual({
      challengeId: CHALLENGE,
      installationRowId: INSTALL,
      walletAddress: WALLET.toLowerCase(),
      issuedAt: ISSUED,
    });
  });

  it("rejects a binding-prefix challenge (wrong namespace)", () => {
    expect(
      parseReviewChallenge(
        `AntFleet binding: ${INSTALL} ${WALLET.toLowerCase()} ${ISSUED.toISOString()}`,
      ),
    ).toBeNull();
  });

  it("rejects a malformed timestamp", () => {
    expect(
      parseReviewChallenge(
        `AntFleet review: ${CHALLENGE} ${INSTALL} ${WALLET.toLowerCase()} not-a-date`,
      ),
    ).toBeNull();
  });

  it("rejects a non-uuid challenge_id", () => {
    const bad = `AntFleet review: notauuid-1111-4111-8111-111111111111 ${INSTALL} ${WALLET.toLowerCase()} ${ISSUED.toISOString()}`;
    // The regex requires hex, so 'notauuid' won't match the 8-hex segment.
    expect(parseReviewChallenge(bad)).toBeNull();
  });

  it("rejects a non-uuid installation_row_id", () => {
    const bad = `AntFleet review: ${CHALLENGE} not-a-uuid-shape ${WALLET.toLowerCase()} ${ISSUED.toISOString()}`;
    expect(parseReviewChallenge(bad)).toBeNull();
  });

  it("rejects an address that's the wrong length", () => {
    const shortAddr = "0xabcdef";
    expect(
      parseReviewChallenge(
        `AntFleet review: ${CHALLENGE} ${INSTALL} ${shortAddr} ${ISSUED.toISOString()}`,
      ),
    ).toBeNull();
  });
});

describe("challenge TTL constants", () => {
  it("matches the bind challenge's window (10min back, 30s forward)", () => {
    // Same threat model as /bind: a snooped signature has at most 10
    // minutes of validity, plus 30s clock-skew headroom forward.
    expect(REVIEW_CHALLENGE_MAX_AGE_MS).toBe(10 * 60 * 1000);
    expect(REVIEW_CHALLENGE_FUTURE_SKEW_MS).toBe(30_000);
  });
});
