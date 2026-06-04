export type AgentSubmissionStatus = "open" | "merged" | "absorbed" | "superseded_landed";

export type AgentSubmission = {
  agentTokenAddress: string;
  kind: "pr" | "issue";
  repoFullName: string;
  number: number;
  title: string;
  url: string;
  submittedBy: string;
  channel: "antfleet_app" | "direct_claude_code";
  status: AgentSubmissionStatus;
  submittedAt: string;
  resolvedAt: string | null;
  resolutionSha: string | null;
  resolutionUrl: string | null;
  note: string | null;
};

export type AgentSubmissionStats = {
  total: number;
  open: number;
  landed: number;
  latestSubmittedAt: string | null;
};

const AUTONOMOPOLY_TOKEN = "0xB3D7e0c3C39A1D3F1B304663065A2F83Ddf56d8e";
const AUTONOMOPOLY_REPO = "Liquid-Protocol-Ops/agent-autonomopoly";
const AUTONOMOPOLY_PR = (number: number) =>
  `https://github.com/${AUTONOMOPOLY_REPO}/pull/${number}`;
const AUTONOMOPOLY_COMMIT = (sha: string) =>
  `https://github.com/${AUTONOMOPOLY_REPO}/commit/${sha}`;

export const AGENT_SUBMISSIONS: AgentSubmission[] = [
  {
    agentTokenAddress: AUTONOMOPOLY_TOKEN,
    kind: "pr",
    repoFullName: AUTONOMOPOLY_REPO,
    number: 33,
    title: "fix: post-merge polish - track-earnings, constants, skill-gap-audit",
    url: AUTONOMOPOLY_PR(33),
    submittedBy: "antfleet-ops",
    channel: "direct_claude_code",
    status: "open",
    submittedAt: "2026-06-03T22:57:40Z",
    resolvedAt: null,
    resolutionSha: null,
    resolutionUrl: null,
    note: "Operator-assisted AntFleet submission with three independent post-merge fixes.",
  },
  {
    agentTokenAddress: AUTONOMOPOLY_TOKEN,
    kind: "pr",
    repoFullName: AUTONOMOPOLY_REPO,
    number: 32,
    title: "fix(skills/diagnose): pass loadPrivyConfig() to loadSignerFromPrivy",
    url: AUTONOMOPOLY_PR(32),
    submittedBy: "antfleet-ops",
    channel: "direct_claude_code",
    status: "open",
    submittedAt: "2026-06-03T22:42:48Z",
    resolvedAt: null,
    resolutionSha: null,
    resolutionUrl: null,
    note: "Operator-assisted AntFleet submission for the diagnose skill's Privy wallet config call.",
  },
  {
    agentTokenAddress: AUTONOMOPOLY_TOKEN,
    kind: "pr",
    repoFullName: AUTONOMOPOLY_REPO,
    number: 31,
    title: 'fix(messages): match unquoted "on:" values in reactive trigger parser',
    url: AUTONOMOPOLY_PR(31),
    submittedBy: "antfleet-ops",
    channel: "direct_claude_code",
    status: "open",
    submittedAt: "2026-06-03T22:39:06Z",
    resolvedAt: null,
    resolutionSha: null,
    resolutionUrl: null,
    note: "Operator-assisted AntFleet submission to restore the Venice-key self-heal trigger parser.",
  },
  {
    agentTokenAddress: AUTONOMOPOLY_TOKEN,
    kind: "pr",
    repoFullName: AUTONOMOPOLY_REPO,
    number: 11,
    title: "fix(aeon): exit 1 when zero-token retry also returns empty output",
    url: AUTONOMOPOLY_PR(11),
    submittedBy: "antfleet-ops",
    channel: "direct_claude_code",
    status: "superseded_landed",
    submittedAt: "2026-06-01T22:52:12Z",
    resolvedAt: "2026-06-03T21:21:50Z",
    resolutionSha: "12e8f0a7d379b6b8d3d1d804d2f328ad4a3aec84",
    resolutionUrl: AUTONOMOPOLY_COMMIT("12e8f0a7d379b6b8d3d1d804d2f328ad4a3aec84"),
    note: "Closed after upstream PR #14 ported the exact fix and merged at 12e8f0a.",
  },
  {
    agentTokenAddress: AUTONOMOPOLY_TOKEN,
    kind: "pr",
    repoFullName: AUTONOMOPOLY_REPO,
    number: 10,
    title: "fix(claim-and-allocate): estimateVeniceDemandDiem reads variant field not model",
    url: AUTONOMOPOLY_PR(10),
    submittedBy: "antfleet-ops",
    channel: "direct_claude_code",
    status: "superseded_landed",
    submittedAt: "2026-06-01T22:51:37Z",
    resolvedAt: "2026-06-03T21:21:48Z",
    resolutionSha: "12e8f0a7d379b6b8d3d1d804d2f328ad4a3aec84",
    resolutionUrl: AUTONOMOPOLY_COMMIT("12e8f0a7d379b6b8d3d1d804d2f328ad4a3aec84"),
    note: "Closed after upstream PR #14 ported the exact fix and merged at 12e8f0a.",
  },
  {
    agentTokenAddress: AUTONOMOPOLY_TOKEN,
    kind: "pr",
    repoFullName: AUTONOMOPOLY_REPO,
    number: 9,
    title: "fix(venice): write bearer cache with 0o600 permissions",
    url: AUTONOMOPOLY_PR(9),
    submittedBy: "antfleet-ops",
    channel: "direct_claude_code",
    status: "superseded_landed",
    submittedAt: "2026-06-01T22:51:15Z",
    resolvedAt: "2026-06-03T21:21:46Z",
    resolutionSha: "12e8f0a7d379b6b8d3d1d804d2f328ad4a3aec84",
    resolutionUrl: AUTONOMOPOLY_COMMIT("12e8f0a7d379b6b8d3d1d804d2f328ad4a3aec84"),
    note: "Closed after upstream PR #14 ported the exact fix and merged at 12e8f0a.",
  },
  {
    agentTokenAddress: AUTONOMOPOLY_TOKEN,
    kind: "pr",
    repoFullName: AUTONOMOPOLY_REPO,
    number: 8,
    title: "fix(reposition): correct computeNewRange comment + assert token0 < token1 at startup",
    url: AUTONOMOPOLY_PR(8),
    submittedBy: "antfleet-ops",
    channel: "antfleet_app",
    status: "absorbed",
    submittedAt: "2026-05-20T06:25:56Z",
    resolvedAt: "2026-05-26T20:46:20Z",
    resolutionSha: "7329b8a",
    resolutionUrl: AUTONOMOPOLY_COMMIT("7329b8a"),
    note: "Closed without merge after the token0 < token1 assertion landed upstream in 7329b8a.",
  },
  {
    agentTokenAddress: AUTONOMOPOLY_TOKEN,
    kind: "pr",
    repoFullName: AUTONOMOPOLY_REPO,
    number: 5,
    title: "fix(on-chain-monitor): pin canonical view-call pattern for check: watches",
    url: AUTONOMOPOLY_PR(5),
    submittedBy: "antfleet-ops",
    channel: "antfleet_app",
    status: "absorbed",
    submittedAt: "2026-05-19T01:29:58Z",
    resolvedAt: "2026-05-26T23:15:26Z",
    resolutionSha: "bab1e4b",
    resolutionUrl: AUTONOMOPOLY_COMMIT("bab1e4b"),
    note: "Closed by antfleet-ops after the selector/view-call fix landed upstream in bab1e4b.",
  },
  {
    agentTokenAddress: AUTONOMOPOLY_TOKEN,
    kind: "pr",
    repoFullName: AUTONOMOPOLY_REPO,
    number: 4,
    title: "fix(deploy): make husky prepare script tolerate missing devDep",
    url: AUTONOMOPOLY_PR(4),
    submittedBy: "antfleet-ops",
    channel: "antfleet_app",
    status: "merged",
    submittedAt: "2026-05-18T05:27:25Z",
    resolvedAt: "2026-05-19T01:06:01Z",
    resolutionSha: "fb5509ce5d31cc108492e1e5b6637253ae0912d2",
    resolutionUrl: AUTONOMOPOLY_PR(4),
    note: "Merged upstream.",
  },
  {
    agentTokenAddress: AUTONOMOPOLY_TOKEN,
    kind: "pr",
    repoFullName: AUTONOMOPOLY_REPO,
    number: 3,
    title: "docs: harmonize build-mode threshold description across files",
    url: AUTONOMOPOLY_PR(3),
    submittedBy: "antfleet-ops",
    channel: "antfleet_app",
    status: "merged",
    submittedAt: "2026-05-18T05:25:35Z",
    resolvedAt: "2026-05-19T01:05:58Z",
    resolutionSha: "3299eed8c52f41ed01e1a249c0e6c7b6f4e3c649",
    resolutionUrl: AUTONOMOPOLY_PR(3),
    note: "Merged upstream.",
  },
];

export function loadAgentSubmissions(agentTokenAddress: string): AgentSubmission[] {
  const normalized = agentTokenAddress.toLowerCase();
  return AGENT_SUBMISSIONS.filter((submission) => {
    return submission.agentTokenAddress.toLowerCase() === normalized;
  });
}

export function loadAgentSubmissionStats(agentTokenAddress: string): AgentSubmissionStats {
  return summarizeAgentSubmissions(loadAgentSubmissions(agentTokenAddress));
}

export function loadRepoSubmissionStats(repoFullName: string): AgentSubmissionStats {
  const normalized = repoFullName.toLowerCase();
  return summarizeAgentSubmissions(
    AGENT_SUBMISSIONS.filter((submission) => submission.repoFullName.toLowerCase() === normalized),
  );
}

export function isLandedAgentSubmission(submission: AgentSubmission): boolean {
  return submission.status !== "open";
}

function summarizeAgentSubmissions(submissions: readonly AgentSubmission[]): AgentSubmissionStats {
  let latestSubmittedAt: string | null = null;
  let open = 0;
  let landed = 0;

  for (const submission of submissions) {
    if (submission.status === "open") {
      open += 1;
    } else {
      landed += 1;
    }
    if (
      latestSubmittedAt === null ||
      new Date(submission.submittedAt) > new Date(latestSubmittedAt)
    ) {
      latestSubmittedAt = submission.submittedAt;
    }
  }

  return {
    total: submissions.length,
    open,
    landed,
    latestSubmittedAt,
  };
}
