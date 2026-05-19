import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadFactoryLaunchDetail } from "@/db/queries";
import { shortAddress } from "@/lib/agent-findings";
import { ClaimForm } from "./ClaimForm";

export const dynamic = "force-dynamic";

type RouteParams = { address: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<RouteParams>;
}): Promise<Metadata> {
  const { address } = await params;
  const detail = await loadFactoryLaunchDetail(address);
  if (detail === null) {
    return { title: "AntFleet · Agent not found" };
  }

  return {
    title: `AntFleet · Claim ${detail.agentName}`,
    description: `Attribute a GitHub source repo to ${detail.agentName}.`,
  };
}

export default async function ClaimPage({ params }: { params: Promise<RouteParams> }) {
  const { address } = await params;
  const detail = await loadFactoryLaunchDetail(address);
  if (detail === null) notFound();

  const { launch, agentName, agentTokenAddress } = detail;

  return (
    <>
      <Header
        agentName={agentName}
        tokenAddress={agentTokenAddress}
        tokenName={launch.tokenName}
        tokenSymbol={launch.tokenSymbol}
      />
      <SectionDivider />
      {launch.repoFullName !== null ? (
        <AlreadyAttributed address={agentTokenAddress} repoFullName={launch.repoFullName} />
      ) : (
        <section className="pb-20">
          <ContentWrap>
            <h2 className="mb-5 text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)]">
              Claim source repo
            </h2>
            <ClaimForm
              tokenAddress={launch.tokenAddress.toLowerCase()}
              deployerAddress={launch.deployerAddress}
            />
          </ContentWrap>
        </section>
      )}
    </>
  );
}

function Header({
  agentName,
  tokenAddress,
  tokenName,
  tokenSymbol,
}: {
  agentName: string;
  tokenAddress: string;
  tokenName: string | null;
  tokenSymbol: string | null;
}) {
  return (
    <section className="py-20 pb-12">
      <ContentWrap>
        <p className="mb-6 font-mono text-xs uppercase tracking-widest text-[var(--color-ink-subtle)]">
          Liquid Protocol agent · {shortAddress(tokenAddress)}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-[var(--color-ink)] leading-snug">
          {agentName}
          {tokenName !== null && tokenSymbol !== null && tokenName !== tokenSymbol && (
            <span className="ml-3 font-mono text-base text-[var(--color-ink-muted)]">
              ({tokenName})
            </span>
          )}
        </h1>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Badge>repo claim</Badge>
          <Badge>deployer signature required</Badge>
        </div>
        <div className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-1 break-all font-mono text-[11px] text-[var(--color-ink-subtle)]">
          <span>token</span>
          <span className="text-[var(--color-ink)]">{tokenAddress}</span>
          <a
            href={`https://basescan.org/address/${tokenAddress}`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 transition-colors hover:text-[var(--color-ink)]"
          >
            basescan
          </a>
        </div>
      </ContentWrap>
    </section>
  );
}

function AlreadyAttributed({ address, repoFullName }: { address: string; repoFullName: string }) {
  return (
    <section className="pb-20">
      <ContentWrap>
        <div className="max-w-xl border-l-2 border-[var(--color-line-strong)] pl-5">
          <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)]">
            Already attributed
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-[var(--color-ink-muted)]">
            This agent is already attributed to{" "}
            <a
              href={`https://github.com/${repoFullName}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-[var(--color-ink)] underline underline-offset-2 hover:opacity-80"
            >
              {repoFullName}
            </a>
            .
          </p>
          <a
            href={`/agents/${address}`}
            className="mt-6 inline-block rounded-md border border-[var(--color-line-strong)] px-3 py-1.5 font-mono text-[11px] text-[var(--color-ink)] transition-colors hover:bg-white"
          >
            Back to agent
          </a>
        </div>
      </ContentWrap>
    </section>
  );
}

function ContentWrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6">{children}</div>;
}

function SectionDivider() {
  return <div className="my-16 border-t border-[var(--color-line)]" />;
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-[var(--color-line-strong)] px-2 py-0.5 font-mono text-[11px] text-[var(--color-ink-muted)]">
      {children}
    </span>
  );
}
