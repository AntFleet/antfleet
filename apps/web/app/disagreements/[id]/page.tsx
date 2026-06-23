import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { TweetIntent } from "@/components/TweetIntent";
import { db } from "@/db/index";
import { derivedPublicReceiptCondition } from "@/db/public-receipt";
import { findingDisclosure, findingStatus, reviews } from "@/db/schema";
import { isDisclosureGateEnabled } from "@/lib/daybreak-gates-env";
import {
  loadDisagreementDetail,
  redactSecrets,
  type DisagreementCategory,
  type DisagreementRow,
  type ProviderFinding,
} from "@/lib/disagreements";
import { formatRelativeTime } from "@/lib/receipts";
import { shortenRepoHash } from "@/lib/short-id";

type RelatedFinding = { findingId: string; title: string; severity: string; category: string };

async function loadRelatedFindings(reviewId: string): Promise<RelatedFinding[]> {
  const disclosureGateEnabled = isDisclosureGateEnabled();
  const visibilityCondition = disclosureGateEnabled
    ? derivedPublicReceiptCondition
    : eq(reviews.publicReceipt, true);
  const selectColumns = {
    findingId: findingStatus.findingId,
    title: findingStatus.title,
    severity: findingStatus.severity,
    category: findingStatus.category,
  };
  const rows = await (disclosureGateEnabled
    ? db
        .select(selectColumns)
        .from(findingStatus)
        .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
        .leftJoin(findingDisclosure, eq(findingDisclosure.findingId, findingStatus.findingId))
        .where(and(eq(reviews.reviewId, reviewId), visibilityCondition))
        .limit(10)
    : db
        .select(selectColumns)
        .from(findingStatus)
        .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
        .where(and(eq(reviews.reviewId, reviewId), visibilityCondition))
        .limit(10));
  return rows;
}

export const dynamic = "force-dynamic";

const SITE_URL = "https://www.antfleet.dev";

type RouteParams = { id: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<RouteParams>;
}): Promise<Metadata> {
  const { id } = await params;
  const detail = await loadDisagreementDetail(id);
  if (detail === null) {
    return { title: "AntFleet · Disagreement not found" };
  }

  return {
    title: `AntFleet · ${detail.primaryFinding.title}`,
    description: categoryDescription(detail.category),
  };
}

export default async function DisagreementDetailPage({ params }: { params: Promise<RouteParams> }) {
  const { id } = await params;
  const detail = await loadDisagreementDetail(id);
  if (detail === null) {
    notFound();
  }
  const now = new Date();
  const tweetText = tweetTextForCategory(detail.category);
  const tweetUrl = `${SITE_URL}/disagreements/${encodeURIComponent(detail.id)}`;
  const related = await loadRelatedFindings(detail.reviewId);

  return (
    <>
      <Header detail={detail} now={now} />
      <SectionDivider />
      <FindingComparison detail={detail} />
      <SectionDivider />
      <UnanimousGate />
      {related.length > 0 && (
        <>
          <SectionDivider />
          <RelatedFindings findings={related} />
        </>
      )}
      <SectionDivider />
      <FooterLinks detail={detail} tweetText={tweetText} tweetUrl={tweetUrl} />
    </>
  );
}

function ContentWrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6">{children}</div>;
}

function SectionDivider() {
  return <div className="border-t border-[var(--color-line)] my-16" />;
}

function Header({ detail, now }: { detail: DisagreementRow; now: Date }) {
  return (
    <section className="py-20 pb-12">
      <ContentWrap>
        <p className="font-mono text-xs text-[var(--color-ink-subtle)] mb-6 tracking-widest uppercase">
          Disagreement · {detail.id}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-[var(--color-ink)] leading-snug">
          {redactSecrets(detail.primaryFinding.title)}
        </h1>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Badge>{categoryLabel(detail.category)}</Badge>
        </div>
        <div className="mt-6 font-mono text-[11px] text-[var(--color-ink-subtle)] flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>repo {shortenRepoHash(detail.repoHash)}</span>
          <span className="text-[var(--color-line-strong)]">·</span>
          <span>PR #{detail.prNumber}</span>
          <span className="text-[var(--color-line-strong)]">·</span>
          <span>reviewed {formatRelativeTime(now, detail.createdAt)}</span>
        </div>
      </ContentWrap>
    </section>
  );
}

function FindingComparison({ detail }: { detail: DisagreementRow }) {
  if (detail.category === "mismatched_classification" && detail.counterpartFinding !== null) {
    return (
      <section>
        <ContentWrap>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <FindingCard label="Primary finding" finding={detail.primaryFinding} />
            <FindingCard label="Counterpart finding" finding={detail.counterpartFinding} />
          </div>
        </ContentWrap>
      </section>
    );
  }

  return (
    <section>
      <ContentWrap>
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <FindingCard
            label={`${providerLabel(detail.primaryFinding.provider)} finding`}
            finding={detail.primaryFinding}
          />
          <div className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-bg-elevated)] p-5">
            <p className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-4">
              Other reviewer
            </p>
            <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed">
              The other reviewer flagged nothing in this file/line range.
            </p>
          </div>
        </div>
      </ContentWrap>
    </section>
  );
}

function FindingCard({ label, finding }: { label: string; finding: ProviderFinding }) {
  return (
    <article className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-bg-elevated)] p-5">
      <p className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-4">
        {label}
      </p>
      <h2 className="text-sm leading-snug text-[var(--color-ink)]">
        {redactSecrets(finding.title)}
      </h2>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Badge>{finding.severity}</Badge>
        <Badge>{finding.category}</Badge>
        {finding.confidence.length > 0 && <Badge>{finding.confidence}</Badge>}
      </div>
      {finding.evidence.length > 0 && (
        <ul className="mt-5 flex flex-col gap-1 font-mono text-xs">
          {finding.evidence.map((ev, index) => (
            <li key={`${ev.path}-${index}`} className="text-[var(--color-ink)] break-words">
              {formatEvidencePath(ev)}
            </li>
          ))}
        </ul>
      )}
      {finding.reasoning.length > 0 && (
        <blockquote className="mt-5 border-l-2 border-[var(--color-line-strong)] pl-4 text-sm text-[var(--color-ink-muted)] leading-relaxed">
          {redactSecrets(finding.reasoning)}
        </blockquote>
      )}
      {finding.recommendation.length > 0 && (
        <div className="mt-5 text-sm text-[var(--color-ink-muted)] leading-relaxed">
          <p className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-1">
            Recommendation
          </p>
          <p>{redactSecrets(finding.recommendation)}</p>
        </div>
      )}
    </article>
  );
}

function UnanimousGate() {
  return (
    <section>
      <ContentWrap>
        <div className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-bg-elevated)] p-6">
          <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-4">
            Why this didn&apos;t post
          </h2>
          <p className="text-sm text-[var(--color-ink-muted)] max-w-xl leading-relaxed">
            This finding didn&apos;t meet AntFleet&apos;s unanimous agreement threshold. Both
            frontier models review every PR independently; only findings they both flag with the
            same severity and category are posted to the PR. This one fell through.
          </p>
          <a
            href="/about/methodology"
            className="mt-5 inline-block font-mono text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] underline underline-offset-2 transition-colors"
          >
            read the methodology →
          </a>
        </div>
      </ContentWrap>
    </section>
  );
}

function RelatedFindings({ findings }: { findings: RelatedFinding[] }) {
  return (
    <section>
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-5">
          From the same review
        </h2>
        <p className="text-sm text-[var(--color-ink-muted)] mb-5 max-w-xl leading-relaxed">
          These findings passed the unanimous gate on the same PR review. The disagreement above was
          filtered out; the findings below were posted.
        </p>
        <ul className="flex flex-col gap-3">
          {findings.map((f) => (
            <li
              key={f.findingId}
              className="rounded-md border border-[var(--color-line)] p-4 hover:bg-[var(--color-bg-elevated)] transition-colors"
            >
              <a href={`/anatomy/${encodeURIComponent(f.findingId)}`} className="block">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <Badge>{f.severity}</Badge>
                  <Badge>{f.category}</Badge>
                </div>
                <p className="text-sm text-[var(--color-ink)] leading-snug">{f.title}</p>
                <span className="mt-2 inline-block font-mono text-[11px] text-[var(--color-ink-subtle)]">
                  view anatomy →
                </span>
              </a>
            </li>
          ))}
        </ul>
      </ContentWrap>
    </section>
  );
}

function FooterLinks({
  detail,
  tweetText,
  tweetUrl,
}: {
  detail: DisagreementRow;
  tweetText: string;
  tweetUrl: string;
}) {
  return (
    <section className="pb-20">
      <ContentWrap>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-3 font-mono text-xs">
            <a
              href="/disagreements"
              className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] underline underline-offset-2 transition-colors"
            >
              ← back to all disagreements
            </a>
            <a
              href="/receipts"
              className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] underline underline-offset-2 transition-colors"
            >
              view public receipts
            </a>
            <a
              href="/receipts"
              className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] underline underline-offset-2 transition-colors"
            >
              see unanimous findings + anatomies &rarr;
            </a>
          </div>
          <TweetIntent
            text={tweetText}
            url={tweetUrl}
            ariaLabel={`Tweet this disagreement: ${detail.primaryFinding.title}`}
            className="self-start font-mono text-[11px] text-[var(--color-ink-subtle)] transition-colors hover:text-[var(--color-ink)] sm:self-center sm:shrink-0"
          >
            Tweet ↗
          </TweetIntent>
        </div>
      </ContentWrap>
    </section>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-[var(--color-line-strong)] px-2 py-0.5 font-mono text-[11px] text-[var(--color-ink-muted)]">
      {children}
    </span>
  );
}

function categoryLabel(category: DisagreementCategory): string {
  if (category === "solo_anthropic") return "solo Opus";
  if (category === "solo_openai") return "solo GPT-5";
  return "mismatch";
}

function categoryDescription(category: DisagreementCategory): string {
  if (category === "solo_anthropic") return "Solo Opus finding filtered by the unanimous gate.";
  if (category === "solo_openai") return "Solo GPT-5 finding filtered by the unanimous gate.";
  return "Severity or category mismatch filtered by the unanimous gate.";
}

function tweetTextForCategory(category: DisagreementCategory): string {
  if (category === "solo_anthropic")
    return "Opus flagged this; GPT-5 didn't mention it. We don't know who's right.";
  if (category === "solo_openai")
    return "GPT-5 flagged this; Opus didn't mention it. We don't know who's right.";
  return "Both reviewers flagged the same code. Different severity. Neither shipped.";
}

function providerLabel(provider: string): string {
  if (provider === "anthropic") return "Opus";
  if (provider === "openai") return "GPT-5";
  return provider;
}

function formatEvidencePath(ev: {
  path: string;
  startLine: number | null;
  endLine: number | null;
}): string {
  if (ev.startLine === null) return ev.path;
  if (ev.endLine === null || ev.endLine === ev.startLine) {
    return `${ev.path}:${ev.startLine}`;
  }
  return `${ev.path}:${ev.startLine}-${ev.endLine}`;
}
