// EIP-191 binding challenge — the string an agent signs to prove control of
// the wallet it wants bound to its installation. Format is single-line so it
// pastes cleanly into a wallet's "sign message" UI; timestamp is ISO-8601
// UTC so the bind endpoint can apply a max-skew check.

const PREFIX = "AntFleet binding";

// Allow 30s into the future, 10 minutes into the past. Matches /api/claim's
// CLAIM_WINDOW_MS — same threat model, same constants.
export const BINDING_CHALLENGE_FUTURE_SKEW_MS = 30_000;
export const BINDING_CHALLENGE_MAX_AGE_MS = 10 * 60 * 1000;

export function buildBindingChallenge(args: {
  installationId: string;
  walletAddress: string;
  issuedAt: Date;
}): string {
  return `${PREFIX}: ${args.installationId} ${args.walletAddress.toLowerCase()} ${args.issuedAt.toISOString()}`;
}

export type ParsedBindingChallenge = {
  installationId: string;
  walletAddress: string;
  issuedAt: Date;
};

export function parseBindingChallenge(message: string): ParsedBindingChallenge | null {
  const match = message.match(/^AntFleet binding: ([0-9a-f-]{36}) (0x[0-9a-fA-F]{40}) (\S+)$/);
  if (match === null) return null;
  const [, installationId, walletAddress, iso] = match;
  if (installationId === undefined || walletAddress === undefined || iso === undefined) {
    return null;
  }
  const issuedAt = new Date(iso);
  if (Number.isNaN(issuedAt.getTime())) return null;
  return { installationId, walletAddress: walletAddress.toLowerCase(), issuedAt };
}
