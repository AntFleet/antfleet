// EIP-191 review-trigger challenge — the string an agent signs to authorize
// one synchronous review via POST /api/v1/installations/{id}/review.
//
// Mirrors the /bind challenge shape (lib/paywall/challenge.ts) so wallet
// UIs render both signing prompts in the same idiom; only the prefix and
// the leading challenge_id differ. The bind challenge is stateless and
// derived from installations.created_at — safe because binding is one-shot
// per install. Review is repeating, so the challenge_id is server-issued
// and stored in review_challenges with single-use redemption semantics
// (see migration 0021).

const PREFIX = "AntFleet review";

// Same window as /bind. Wallet round-trips routinely take 10–30s; 10min
// gives Aeon's tooling enough headroom while keeping the surface for a
// stolen signature small.
export const REVIEW_CHALLENGE_FUTURE_SKEW_MS = 30_000;
export const REVIEW_CHALLENGE_MAX_AGE_MS = 10 * 60 * 1000;

export function buildReviewChallenge(args: {
  challengeId: string;
  installationRowId: string;
  walletAddress: string;
  issuedAt: Date;
}): string {
  return `${PREFIX}: ${args.challengeId} ${args.installationRowId} ${args.walletAddress.toLowerCase()} ${args.issuedAt.toISOString()}`;
}

export type ParsedReviewChallenge = {
  challengeId: string;
  installationRowId: string;
  walletAddress: string;
  issuedAt: Date;
};

export function parseReviewChallenge(message: string): ParsedReviewChallenge | null {
  const match = message.match(
    /^AntFleet review: ([0-9a-f-]{36}) ([0-9a-f-]{36}) (0x[0-9a-fA-F]{40}) (\S+)$/,
  );
  if (match === null) return null;
  const [, challengeId, installationRowId, walletAddress, iso] = match;
  if (
    challengeId === undefined ||
    installationRowId === undefined ||
    walletAddress === undefined ||
    iso === undefined
  ) {
    return null;
  }
  const issuedAt = new Date(iso);
  if (Number.isNaN(issuedAt.getTime())) return null;
  return {
    challengeId,
    installationRowId,
    walletAddress: walletAddress.toLowerCase(),
    issuedAt,
  };
}
