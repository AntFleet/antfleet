import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadDisclosureFindingDetail } from "@/db/queries";
import { isDisclosureGateEnabled } from "@/lib/daybreak-gates-env";
import { disclosureTokenLogId, verifyDisclosureToken } from "@/lib/disclosure-token";
import { logInfo, logWarn } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { token: string };

export const metadata: Metadata = {
  title: "AntFleet disclosure",
  robots: { index: false, follow: false },
};

export default async function DisclosurePage({ params }: { params: Promise<RouteParams> }) {
  if (!isDisclosureGateEnabled()) {
    notFound();
  }
  const { token } = await params;
  const verified = verifyDisclosureToken(token);
  const logId = disclosureTokenLogId(token);
  if (verified.kind !== "ok") {
    logWarn("disclosure_page.token_invalid", { logId, kind: verified.kind });
    notFound();
  }
  const detail = await loadDisclosureFindingDetail(verified.payload.findingId);
  if (detail === null || detail.disclosure === null || detail.disclosure.state === "none") {
    logInfo("disclosure_page.not_found", { logId, findingId: verified.payload.findingId });
    notFound();
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-12 font-sans text-neutral-950">
      <p className="mb-3 font-mono text-xs uppercase tracking-widest text-neutral-500">
        Private coordinated disclosure
      </p>
      <h1 className="text-3xl font-semibold tracking-tight">{detail.title}</h1>
      <div className="mt-4 flex flex-wrap gap-2 font-mono text-xs">
        <span className="rounded border px-2 py-1">{detail.severity}</span>
        <span className="rounded border px-2 py-1">{detail.category}</span>
        <span className="rounded border px-2 py-1">{detail.disclosure.state}</span>
      </div>

      <section className="mt-8 border-t pt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide">Repository</h2>
        <p className="mt-2 font-mono text-sm">{repoName(detail.owner, detail.repo)}</p>
        <p className="mt-1 font-mono text-xs text-neutral-500">
          PR #{detail.prNumber} · {detail.commitSha.slice(0, 12)}
        </p>
      </section>

      <section className="mt-8 border-t pt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide">Embargo</h2>
        <dl className="mt-3 grid gap-2 text-sm">
          <div>
            <dt className="font-medium">Expires</dt>
            <dd>{detail.disclosure.embargoExpiresAt?.toISOString() ?? "not set"}</dd>
          </div>
          <div>
            <dt className="font-medium">Acknowledged</dt>
            <dd>{detail.disclosure.acknowledgedAt?.toISOString() ?? "not yet"}</dd>
          </div>
          <div>
            <dt className="font-medium">GHSA / CVE</dt>
            <dd>
              {detail.disclosure.ghsaId ?? "pending"} / {detail.disclosure.cveId ?? "pending"}
            </dd>
          </div>
        </dl>
      </section>

      <section className="mt-8 border-t pt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide">Evidence Bundle</h2>
        <pre className="mt-3 max-h-72 overflow-auto rounded border bg-neutral-50 p-4 text-xs">
          {JSON.stringify(detail.evidenceBundle ?? { status: "not available" }, null, 2)}
        </pre>
      </section>

      <section className="mt-8 border-t pt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide">Draft Advisory</h2>
        <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap rounded border bg-neutral-50 p-4 text-xs">
          {detail.disclosure.advisoryDraft ?? "Draft not generated yet."}
        </pre>
      </section>

      <form
        action={`/api/disclosure/${encodeURIComponent(token)}`}
        method="post"
        className="mt-8 border-t pt-6"
      >
        <label className="block text-sm font-medium" htmlFor="comment">
          Comment
        </label>
        <textarea
          className="mt-2 h-28 w-full rounded border px-3 py-2 text-sm"
          id="comment"
          name="comment"
          maxLength={2000}
        />
        <div className="mt-5 flex flex-wrap gap-3">
          <button
            className="rounded bg-neutral-950 px-4 py-2 text-sm text-white"
            name="action"
            value="acknowledge"
          >
            Acknowledge
          </button>
          <button
            className="rounded border px-4 py-2 text-sm"
            name="action"
            value="request-publication"
          >
            Request publication
          </button>
        </div>
      </form>
    </main>
  );
}

function repoName(owner: string | null, repo: string | null): string {
  if (owner === null || repo === null) return "unknown";
  return `${owner}/${repo}`;
}
