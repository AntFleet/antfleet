import { randomUUID } from "node:crypto";
import {
  claimFindingDisclosureGhsaReservation,
  completeFindingDisclosureGhsaReservation,
  createFindingDisclosure,
  isLiveProtocolInstallRepo,
  loadDisclosureFindingDetail,
  loadDisclosurePublishCandidates,
  loadDisclosureTimerCandidates,
  markFindingDisclosureGhsaPublished,
  recordFindingDisclosureGhsaDraft,
  releaseFindingDisclosureGhsaReservation,
  transitionFindingDisclosure,
  type DisclosureFindingDetail,
} from "@/db/queries";
import {
  addDays,
  EMBARGO_DAYS,
  isHighOrCritical,
  MIN_GRACE_DAYS,
  type DisclosureActorType,
  type DisclosureState,
} from "./disclosure-types";
import {
  generateGhsaMarkdown,
  ghsaInputFromAdvisory,
  type AdvisoryFindingContext,
} from "./disclosure-advisory";
import {
  buildDisclosureUrl,
  disclosureTokenLogId,
  encryptDisclosureSecret,
} from "./disclosure-token";
import { ghsaClient, type GhsaClient } from "./ghsa-client";
import { alertCritical } from "./alert";
import { logError, logInfo, messageOf } from "./log";
import { getPublicBaseUrl } from "./paywall/env";

export type InitializeDisclosureFinding = {
  findingId: string;
  findingIndex: number;
  title: string;
  severity: string;
  category: string;
};

export type InitializeDisclosureArgs = {
  reviewId: string;
  owner: string;
  repo: string;
  installationId: number | null;
  commitSha: string;
  prNumber: number;
  publicReceipt: boolean;
  agreementDecision: unknown;
  providerResponses: unknown;
  findings: InitializeDisclosureFinding[];
  liveProtocolReviewRequired?: boolean;
  routeLiveProtocolEmbargo?: boolean;
  // Cyber tier override (Daybreak follow-up). When 'cyber', EVERY finding
  // auto-embargoes regardless of severity or live-protocol status — the
  // tier itself is the gate. Defaults to 'default' so existing call sites
  // (which don't pass this field) keep byte-identical behavior.
  cyberTier?: "default" | "cyber";
  now?: Date;
  ghsa?: GhsaClient;
};

export type InitializeDisclosureResult = {
  embargoedFindingIds: string[];
  embargoedFindingIndexes: number[];
};

export async function initializeDisclosureForFindings(
  args: InitializeDisclosureArgs,
): Promise<InitializeDisclosureResult> {
  const now = args.now ?? new Date();
  const embargoedFindingIds: string[] = [];
  const embargoedFindingIndexes: number[] = [];
  const routeLiveProtocolEmbargo = args.routeLiveProtocolEmbargo !== false;
  const isLiveProtocol =
    routeLiveProtocolEmbargo &&
    (args.liveProtocolReviewRequired === true ||
      (await isLiveProtocolInstallRepo({
        installationId: args.installationId,
        owner: args.owner,
        repo: args.repo,
      })));
  const isCyberTier = args.cyberTier === "cyber";

  for (const finding of args.findings) {
    // Cyber-tier repos embargo every finding regardless of severity. The
    // existing live-protocol path stays unchanged for non-cyber repos.
    const embargo = isCyberTier || (isLiveProtocol && isHighOrCritical(finding.severity));
    const state: DisclosureState = embargo ? "embargoed" : "none";
    if (embargo) {
      embargoedFindingIds.push(finding.findingId);
      embargoedFindingIndexes.push(finding.findingIndex);
    }
    const advisoryDraft = embargo
      ? generateGhsaMarkdown({
          findingId: finding.findingId,
          title: finding.title,
          severity: finding.severity,
          category: finding.category,
          reviewId: args.reviewId,
          findingIndex: finding.findingIndex,
          owner: args.owner,
          repo: args.repo,
          commitSha: args.commitSha,
          prNumber: args.prNumber,
          disclosureState: "embargoed",
          agreementDecision: args.agreementDecision,
          providerResponses: args.providerResponses,
          evidenceBundle: null,
          threatModel: null,
        })
      : null;
    const maintainerUrl = embargo
      ? buildDisclosureUrl({
          baseUrl: getPublicBaseUrl(),
          findingId: finding.findingId,
          now,
        })
      : null;
    const maintainerUrlLogId = maintainerUrl === null ? null : disclosureUrlLogId(maintainerUrl);
    const maintainerUrlCiphertext =
      maintainerUrl === null ? null : encryptDisclosureSecret(maintainerUrl);
    const created = await createFindingDisclosure({
      findingId: finding.findingId,
      reviewId: args.reviewId,
      state,
      enteredAt: now,
      embargoExpiresAt: embargo ? addDays(now, EMBARGO_DAYS) : null,
      maintainerUrlCiphertext,
      maintainerUrlLogId,
      advisoryDraft,
      atSha: args.commitSha,
      reason: embargo
        ? isCyberTier
          ? "auto-embargoed cyber-tier finding"
          : "auto-embargoed high-severity live-protocol finding"
        : "initialized non-disclosure finding",
    });
    if (!embargo || !created.created) continue;
    notifyPrivateDisclosureUrl({
      findingId: finding.findingId,
      reviewId: args.reviewId,
      repo: `${args.owner}/${args.repo}`,
      maintainerUrlLogId: maintainerUrlLogId!,
    });
  }
  return { embargoedFindingIds, embargoedFindingIndexes };
}

async function prepareGhsaForPublication(
  detail: DisclosureFindingDetail,
  ghsa: GhsaClient = ghsaClient,
): Promise<{ owner: string; repo: string; ghsaId: string } | null> {
  if (detail.disclosure === null) return null;
  if (
    detail.disclosure.state !== "published" &&
    !canPublishDisclosureState(detail.disclosure.state)
  ) {
    return null;
  }
  if (detail.owner === null || detail.repo === null) {
    logError("disclosure.ghsa_missing_repo", { findingId: detail.findingId });
    return null;
  }

  if (
    detail.disclosure.ghsaId !== null &&
    (detail.disclosure.cveId !== null || detail.disclosure.cveRequestedAt !== null)
  ) {
    return { owner: detail.owner, repo: detail.repo, ghsaId: detail.disclosure.ghsaId };
  }

  const now = new Date();
  const reservationToken = randomUUID();
  const claimed = await claimFindingDisclosureGhsaReservation({
    findingId: detail.findingId,
    reservationToken,
    now,
    staleBefore: new Date(now.getTime() - 15 * 60_000),
  });
  if (!claimed) {
    const current = await loadDisclosureFindingDetail(detail.findingId);
    if (current?.disclosure?.ghsaId !== null && current?.disclosure?.ghsaId !== undefined) {
      return { owner: detail.owner, repo: detail.repo, ghsaId: current.disclosure.ghsaId };
    }
    logInfo("disclosure.ghsa_reservation_in_progress", { findingId: detail.findingId });
    return null;
  }

  try {
    const draft =
      detail.disclosure.ghsaId === null
        ? await ghsa.createDraftAdvisory(ghsaInputFromAdvisory(advisoryContext(detail)))
        : null;
    const ghsaId = detail.disclosure.ghsaId ?? draft?.ghsaId;
    if (ghsaId === undefined) return null;
    const cveId = detail.disclosure.cveId ?? draft?.cveId ?? null;
    const draftRecorded =
      detail.disclosure.ghsaId !== null ||
      (await recordFindingDisclosureGhsaDraft({
        findingId: detail.findingId,
        reservationToken,
        ghsaId,
        cveId,
        ghsaHtmlUrl: detail.disclosure.ghsaHtmlUrl ?? draft?.htmlUrl ?? null,
        now: new Date(),
      }));
    if (!draftRecorded) {
      const current = await loadDisclosureFindingDetail(detail.findingId);
      if (current?.disclosure?.ghsaId !== null && current?.disclosure?.ghsaId !== undefined) {
        return { owner: detail.owner, repo: detail.repo, ghsaId: current.disclosure.ghsaId };
      }
      return null;
    }
    let cveRequestedAt = detail.disclosure.cveRequestedAt;
    let latestCveId = cveId;
    let latestHtmlUrl = detail.disclosure.ghsaHtmlUrl ?? draft?.htmlUrl ?? null;
    if (cveId === null && cveRequestedAt === null) {
      const refreshed = await ghsa.requestCve(detail.owner, detail.repo, ghsaId);
      latestCveId = refreshed.cveId ?? cveId;
      latestHtmlUrl = refreshed.htmlUrl ?? latestHtmlUrl;
      cveRequestedAt = new Date();
    }
    const completed = await completeFindingDisclosureGhsaReservation({
      findingId: detail.findingId,
      reservationToken,
      ghsaId,
      cveId: latestCveId,
      ghsaHtmlUrl: latestHtmlUrl,
      cveRequestedAt,
      now: new Date(),
    });
    if (!completed) {
      logInfo("disclosure.ghsa_reservation_lost", { findingId: detail.findingId, ghsaId });
      const current = await loadDisclosureFindingDetail(detail.findingId);
      if (current?.disclosure?.ghsaId !== null && current?.disclosure?.ghsaId !== undefined) {
        return { owner: detail.owner, repo: detail.repo, ghsaId: current.disclosure.ghsaId };
      }
      return null;
    }
    logInfo("disclosure.ghsa_reserved", {
      findingId: detail.findingId,
      ghsaId,
      cveId,
    });
    return { owner: detail.owner, repo: detail.repo, ghsaId };
  } catch (err) {
    await releaseFindingDisclosureGhsaReservation({
      findingId: detail.findingId,
      reservationToken,
      now: new Date(),
    });
    throw err;
  }
}

export async function acknowledgeDisclosure(args: {
  findingId: string;
  actorLabel: string;
  comment: string | null;
  now?: Date;
}): Promise<void> {
  const detail = await loadDisclosureFindingDetail(args.findingId);
  if (detail?.disclosure === null || detail === null) return;
  const state = detail.disclosure.state;
  if (state === "published" || state === "embargo-expired" || state === "none") return;
  const toState: DisclosureState =
    state === "patch-merged" ? "patch-merged" : "maintainer-acknowledged";
  await transitionFindingDisclosure({
    findingId: args.findingId,
    toState,
    actorType: "maintainer",
    actorId: args.actorLabel,
    reason: "maintainer acknowledged private disclosure",
    atSha: detail.commitSha,
    now: args.now ?? new Date(),
    acknowledgedBy: args.actorLabel,
    metadata: { comment: args.comment },
  });
  alertCritical("disclosure.maintainer_acknowledged", {
    findingId: args.findingId,
    repo: repoName(detail),
  });
}

export async function requestDisclosurePublication(args: {
  findingId: string;
  actorLabel: string;
  comment: string | null;
  now?: Date;
}): Promise<void> {
  const detail = await loadDisclosureFindingDetail(args.findingId);
  if (detail?.disclosure === null || detail === null) return;
  await transitionFindingDisclosure({
    findingId: args.findingId,
    toState: detail.disclosure.state,
    actorType: "maintainer",
    actorId: args.actorLabel,
    reason: "maintainer requested publication",
    atSha: detail.commitSha,
    now: args.now ?? new Date(),
    metadata: { requestedPublication: true, comment: args.comment },
  });
  alertCritical("disclosure.publication_requested", {
    findingId: args.findingId,
    repo: repoName(detail),
  });
}

export async function publishDisclosure(args: {
  findingId: string;
  actorType: DisclosureActorType;
  actorId: string;
  reason: string;
  now?: Date;
  ghsa?: GhsaClient;
}): Promise<void> {
  const detail = await loadDisclosureFindingDetail(args.findingId);
  if (detail?.disclosure === null || detail === null) return;
  const client = args.ghsa ?? ghsaClient;
  const publication = await prepareGhsaForPublication(detail, client);
  if (publication === null) return;

  if (detail.disclosure.state !== "published") {
    if (!canPublishDisclosureState(detail.disclosure.state)) return;
    const transition = await transitionFindingDisclosure({
      findingId: args.findingId,
      toState: "published",
      actorType: args.actorType,
      actorId: args.actorId,
      reason: args.reason,
      atSha: disclosurePatchSha(detail),
      now: args.now ?? new Date(),
      forcedBy: args.actorType === "operator" ? args.actorId : null,
    });
    if (!transition.transitioned) return;
  }
  const published = await client.publishAdvisory(
    publication.owner,
    publication.repo,
    publication.ghsaId,
  );
  if (!published.published || published.htmlUrl === null) {
    logInfo("disclosure.ghsa_publish_not_confirmed", {
      findingId: args.findingId,
      ghsaId: publication.ghsaId,
      mock: published.mock,
    });
    return;
  }
  await markFindingDisclosureGhsaPublished({
    findingId: args.findingId,
    ghsaHtmlUrl: published.htmlUrl,
    ghsaPublishedAt: args.now ?? new Date(),
  });
}

export type DisclosureCronResult = {
  scanned: number;
  expired: number;
  patchMerged: number;
  published: number;
  errors: number;
};

export async function runDisclosureCronTick(now: Date = new Date()): Promise<DisclosureCronResult> {
  const candidates = await loadDisclosureTimerCandidates(now);
  const result: DisclosureCronResult = {
    scanned: candidates.length,
    expired: 0,
    patchMerged: 0,
    published: 0,
    errors: 0,
  };
  for (const detail of candidates) {
    try {
      const disclosure = detail.disclosure;
      if (disclosure === null) continue;
      if (
        isFindingPatched(detail) &&
        disclosure.state !== "patch-merged" &&
        disclosure.state !== "embargo-expired"
      ) {
        const draft = generateGhsaMarkdown({
          ...advisoryContext(detail),
          disclosureState: "patch-merged",
        });
        await transitionFindingDisclosure({
          findingId: detail.findingId,
          toState: "patch-merged",
          actorType: "system",
          actorId: "cron",
          reason: "patch merged on upstream main",
          atSha: disclosurePatchSha(detail),
          now,
          advisoryDraft: draft,
        });
        result.patchMerged += 1;
      }
      const refreshed = await loadDisclosureFindingDetail(detail.findingId);
      if (refreshed?.disclosure === null || refreshed === null) continue;
      if (shouldExpire(refreshed, now)) {
        await transitionFindingDisclosure({
          findingId: refreshed.findingId,
          toState: "embargo-expired",
          actorType: "system",
          actorId: "cron",
          reason: "embargo expiry criteria met",
          atSha: disclosurePatchSha(refreshed),
          now,
          metadata: {
            timerExpired:
              refreshed.disclosure.embargoExpiresAt !== null &&
              refreshed.disclosure.embargoExpiresAt.getTime() <= now.getTime(),
            acknowledged: refreshed.disclosure.acknowledgedAt !== null,
            patched: isFindingPatched(refreshed),
          },
        });
        result.expired += 1;
      }
    } catch (err) {
      result.errors += 1;
      logError("disclosure_cron.candidate_failed", {
        findingId: detail.findingId,
        message: messageOf(err),
      });
    }
  }
  const publishCandidates = await loadDisclosurePublishCandidates();
  result.scanned += publishCandidates.length;
  for (const detail of publishCandidates) {
    try {
      const before = detail.disclosure;
      if (before === null) continue;
      await publishDisclosure({
        findingId: detail.findingId,
        actorType: "system",
        actorId: "cron",
        reason: "publish expired coordinated disclosure",
        now,
      });
      const after = await loadDisclosureFindingDetail(detail.findingId);
      if (
        before.ghsaPublishedAt === null &&
        after?.disclosure !== null &&
        after !== null &&
        after.disclosure.ghsaPublishedAt !== null
      ) {
        result.published += 1;
      }
    } catch (err) {
      result.errors += 1;
      logError("disclosure_cron.publish_candidate_failed", {
        findingId: detail.findingId,
        message: messageOf(err),
      });
    }
  }
  return result;
}

function shouldExpire(detail: DisclosureFindingDetail, now: Date): boolean {
  const disclosure = detail.disclosure;
  if (disclosure === null) return false;
  if (
    disclosure.embargoExpiresAt !== null &&
    disclosure.embargoExpiresAt.getTime() <= now.getTime()
  ) {
    return true;
  }
  const minGraceElapsed =
    now.getTime() - disclosure.createdAt.getTime() >= MIN_GRACE_DAYS * 24 * 60 * 60 * 1000;
  return disclosure.acknowledgedAt !== null && isFindingPatched(detail) && minGraceElapsed;
}

function isFindingPatched(detail: DisclosureFindingDetail): boolean {
  return detail.patchAcceptedAt !== null || detail.closureDetectedAt !== null;
}

function disclosurePatchSha(detail: DisclosureFindingDetail): string {
  return detail.patchAcceptedSha ?? detail.closureSha ?? detail.commitSha;
}

function canPublishDisclosureState(state: DisclosureState): boolean {
  return (
    state === "embargoed" ||
    state === "maintainer-acknowledged" ||
    state === "patch-merged" ||
    state === "embargo-expired"
  );
}

function advisoryContext(detail: DisclosureFindingDetail): AdvisoryFindingContext {
  return {
    findingId: detail.findingId,
    title: detail.title,
    severity: detail.severity,
    category: detail.category,
    reviewId: detail.reviewId,
    findingIndex: detail.findingIndex,
    owner: detail.owner,
    repo: detail.repo,
    commitSha: detail.commitSha,
    prNumber: detail.prNumber,
    disclosureState: detail.disclosure?.state ?? "none",
    agreementDecision: detail.agreementDecision,
    providerResponses: detail.providerResponses,
    evidenceBundle: detail.evidenceBundle,
    threatModel: detail.threatModel,
  };
}

function repoName(detail: Pick<DisclosureFindingDetail, "owner" | "repo">): string {
  if (detail.owner === null || detail.repo === null) return "unknown";
  return `${detail.owner}/${detail.repo}`;
}

function disclosureUrlLogId(url: string): string {
  const token = new URL(url).pathname.split("/").filter(Boolean).at(-1);
  return token === undefined ? "unknown" : disclosureTokenLogId(token);
}

function notifyPrivateDisclosureUrl(args: {
  findingId: string;
  reviewId: string;
  repo: string;
  maintainerUrlLogId: string;
}): void {
  logInfo("disclosure.maintainer_url_issued", {
    findingId: args.findingId,
    reviewId: args.reviewId,
    repo: args.repo,
    maintainerUrlLogId: args.maintainerUrlLogId,
    delivery: "encrypted_side_table",
  });
  alertCritical("disclosure.maintainer_url_issued", {
    findingId: args.findingId,
    reviewId: args.reviewId,
    repo: args.repo,
    maintainerUrlLogId: args.maintainerUrlLogId,
    handling: "decrypt side-table URL and send via bug-bounty/security-contact channel",
  });
}
