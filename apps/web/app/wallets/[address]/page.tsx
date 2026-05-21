// Wallet reputation page. Server-rendered, no client JS. Shows total
// reviews, finding-close rate, total USDC settled, and current channel
// balance for every wallet that has bound to one or more AntFleet
// installations.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { loadWalletReputation, type WalletReputation } from "@/lib/paywall/queries";

export const dynamic = "force-dynamic";

type RouteParams = { address: string };

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<RouteParams>;
}): Promise<Metadata> {
  const { address } = await params;
  if (!ADDRESS_RE.test(address)) return { title: "AntFleet · wallet not found" };
  return {
    title: `AntFleet · wallet ${shortAddress(address)}`,
    description: "Per-wallet AntFleet reputation: reviews, findings, USDC settled.",
  };
}

export default async function WalletReputationPage({ params }: { params: Promise<RouteParams> }) {
  const { address } = await params;
  if (!ADDRESS_RE.test(address)) notFound();
  const reputation = await loadWalletReputation(db, address);
  if (reputation === null) notFound();
  return <WalletPage reputation={reputation} />;
}

function WalletPage({ reputation }: { reputation: WalletReputation }) {
  const closeRate =
    reputation.findingsTotal > 0
      ? Math.round((reputation.findingsClosed / reputation.findingsTotal) * 100)
      : null;

  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <p className="font-mono text-xs text-[var(--color-ink-subtle)] mb-3 uppercase tracking-widest">
        AntFleet wallet · Base
      </p>
      <h1 className="font-mono text-2xl text-[var(--color-ink)] break-all">
        {reputation.walletAddress}
      </h1>
      <p className="mt-3 text-sm text-[var(--color-ink-muted)]">
        Aggregated across every AntFleet installation bound to this wallet.
      </p>

      <section className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Reviews" value={String(reputation.totalReviews)} />
        <Stat
          label="Findings closed"
          value={
            closeRate === null
              ? "—"
              : `${reputation.findingsClosed}/${reputation.findingsTotal} (${closeRate}%)`
          }
        />
        <Stat label="USDC settled" value={`${formatUsdc(reputation.totalSettledUsdc)} USDC`} />
        <Stat label="Current balance" value={`${formatUsdc(reputation.currentBalanceUsdc)} USDC`} />
      </section>

      <h2 className="mt-16 text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-4">
        Installations
      </h2>
      <ul className="flex flex-col gap-3">
        {reputation.installations.map((i) => (
          <li
            key={i.installationRowId}
            className="rounded-md border border-[var(--color-line)] bg-[var(--color-bg-elevated)] px-4 py-3"
          >
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-mono text-sm text-[var(--color-ink)]">
                {i.owner && i.repo ? `${i.owner}/${i.repo}` : "(GitHub App not yet installed)"}
              </span>
              <span className="rounded-full border border-[var(--color-line-strong)] px-2 py-0.5 font-mono text-[11px] text-[var(--color-ink-muted)]">
                {i.status}
              </span>
              {i.channelBalanceUsdc !== null && (
                <span className="font-mono text-xs text-[var(--color-ink-muted)]">
                  channel: {formatUsdc(i.channelBalanceUsdc)} USDC
                </span>
              )}
            </div>
            {i.boundAt !== null && (
              <p className="mt-1 font-mono text-[11px] text-[var(--color-ink-subtle)]">
                Bound {i.boundAt.toISOString()}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-[var(--color-line)] bg-[var(--color-bg-elevated)] px-4 py-4">
      <p className="font-mono text-[11px] text-[var(--color-ink-subtle)] uppercase tracking-widest">
        {label}
      </p>
      <p className="mt-2 text-lg font-semibold text-[var(--color-ink)]">{value}</p>
    </div>
  );
}

function formatUsdc(raw: string): string {
  // Drop trailing zeros for readability, keep at least 2 decimals so
  // "5.50" stays "5.50" but "5.000000" becomes "5.00".
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return n.toFixed(Math.max(2, decimalsNeeded(raw)));
}

function decimalsNeeded(raw: string): number {
  const idx = raw.indexOf(".");
  if (idx === -1) return 0;
  const frac = raw.slice(idx + 1).replace(/0+$/, "");
  return frac.length;
}
