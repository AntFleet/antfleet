// SARIF integration docs panel. Pre-pivot this rendered an upload form,
// but the agent page has no logged-in viewer so the form could never
// safely mint a Bearer token client-side. The route requires
// `Authorization: Bearer <signed-ingest-token>` and tokens are minted
// server-side via `scripts/mint-sarif-ingest-token.ts`; customers then
// either curl directly or wire the customer-owned GitHub Action snippet
// from /public/integrations/codescanning.yml.
//
// This panel is now docs-only — copy-paste snippets covering the three
// supported v1 flows: (1) export AntFleet findings as SARIF, (2) ingest
// a single SARIF via curl, (3) push the export into GitHub Code Scanning
// via the customer's own workflow.

type Props = {
  repos: string[];
};

export function SarifIntegrationPanel({ repos }: Props) {
  const sample = repos[0] ?? "OWNER/REPO";

  return (
    <div className="grid gap-5 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-bg-elevated)] p-5">
      <div className="grid gap-2 font-mono text-[11px] text-[var(--color-ink-muted)]">
        <span className="uppercase tracking-widest text-[var(--color-ink-subtle)]">
          1. Export AntFleet findings as SARIF v2.1.0
        </span>
        <pre className="overflow-x-auto rounded-md border border-[var(--color-line)] bg-[var(--color-bg)] p-3">
          {`curl -L https://www.antfleet.dev/api/repos/${sample}/findings.sarif \\
  -o antfleet.sarif`}
        </pre>
      </div>

      <div className="grid gap-2 font-mono text-[11px] text-[var(--color-ink-muted)]">
        <span className="uppercase tracking-widest text-[var(--color-ink-subtle)]">
          2. Ingest a scanner SARIF (CodeQL / Snyk / Semgrep)
        </span>
        <p className="font-sans text-xs text-[var(--color-ink-muted)]">
          Tokens are minted server-side via{" "}
          <code className="font-mono text-[11px]">
            pnpm exec tsx apps/web/scripts/mint-sarif-ingest-token.ts
          </code>{" "}
          and are valid for 5 minutes. Ask the AntFleet team for one bound to your install + repo.
        </p>
        <pre className="overflow-x-auto rounded-md border border-[var(--color-line)] bg-[var(--color-bg)] p-3">
          {`curl -X POST https://www.antfleet.dev/api/repos/${sample}/sarif \\
  -H "Authorization: Bearer $ANTFLEET_SARIF_TOKEN" \\
  -H "Content-Type: application/json" \\
  --data-binary @"@codeql-results.sarif"`}
        </pre>
      </div>

      <div className="grid gap-2 font-mono text-[11px] text-[var(--color-ink-muted)]">
        <span className="uppercase tracking-widest text-[var(--color-ink-subtle)]">
          3. Render AntFleet findings on the GitHub Security tab
        </span>
        <p className="font-sans text-xs text-[var(--color-ink-muted)]">
          Drop the customer-owned workflow at{" "}
          <a
            href="/integrations/codescanning.yml"
            className="underline decoration-dotted underline-offset-2"
          >
            /integrations/codescanning.yml
          </a>{" "}
          into your repo&apos;s <code className="font-mono text-[11px]">.github/workflows/</code>{" "}
          directory. It pulls the export above and uploads via{" "}
          <code className="font-mono text-[11px]">github/codeql-action/upload-sarif</code>.
        </p>
      </div>
    </div>
  );
}
