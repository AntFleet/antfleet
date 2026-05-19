export const CLAIM_MESSAGE_REGEX =
  /^I am the deployer of (0x[a-fA-F0-9]{40})\. I attest that github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+) is the agent's source repository\.\nNonce: ([A-Za-z0-9_-]{10,})\nTimestamp: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)$/;

export type ParsedClaimMessage = {
  tokenAddress: string;
  repoFullName: string;
  nonce: string;
  timestamp: string;
};

export function buildClaimMessage(args: {
  tokenAddress: string;
  repoFullName: string;
  nonce: string;
  timestamp: string;
}): string {
  return `I am the deployer of ${args.tokenAddress}. I attest that github.com/${args.repoFullName} is the agent's source repository.\nNonce: ${args.nonce}\nTimestamp: ${args.timestamp}`;
}

export function parseClaimMessage(message: string): ParsedClaimMessage | null {
  const match = CLAIM_MESSAGE_REGEX.exec(message);
  if (match === null) return null;
  const [, tokenAddress, repoFullName, nonce, timestamp] = match;
  return {
    tokenAddress: tokenAddress!,
    repoFullName: repoFullName!,
    nonce: nonce!,
    timestamp: timestamp!,
  };
}
