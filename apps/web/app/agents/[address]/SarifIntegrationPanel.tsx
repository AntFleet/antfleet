"use client";

import { useMemo, useState } from "react";

type Props = {
  repos: string[];
};

type Result = {
  batch_id: string;
  source_tool: string;
  stats: {
    totalClaims: number;
    realCount: number;
    falsePositiveCount: number;
    inconclusiveCount: number;
    errorCount: number;
  };
};

export function SarifIntegrationPanel({ repos }: Props) {
  const [repo, setRepo] = useState(repos[0] ?? "");
  const [fileText, setFileText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const exportPath = useMemo(() => {
    const parsed = parseRepo(repo);
    return parsed === null ? null : `/api/repos/${parsed.owner}/${parsed.repo}/findings.sarif`;
  }, [repo]);

  async function submit() {
    const parsed = parseRepo(repo);
    if (parsed === null) {
      setError("repo must be owner/repo");
      return;
    }
    if (fileText === null || fileText.length === 0) {
      setError("upload or paste SARIF JSON");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`/api/repos/${parsed.owner}/${parsed.repo}/sarif`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sarif: fileText }),
      });
      const body = (await res.json()) as unknown;
      if (!res.ok) {
        const msg =
          body !== null && typeof body === "object" && "message" in body
            ? String((body as { message: unknown }).message)
            : "SARIF ingest failed";
        throw new Error(msg);
      }
      setResult(body as Result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-bg-elevated)] p-5">
      <div className="grid gap-4">
        <label className="grid gap-1">
          <span className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">
            Repo
          </span>
          <input
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
            placeholder="owner/repo"
            className="rounded-md border border-[var(--color-line)] bg-white px-3 py-2 font-mono text-xs text-[var(--color-ink)]"
          />
        </label>
        <label className="grid gap-1">
          <span className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">
            SARIF file
          </span>
          <input
            type="file"
            accept=".sarif,application/sarif+json,application/json"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              setFileText(file === undefined ? null : await file.text());
            }}
            className="text-xs text-[var(--color-ink-muted)]"
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-[var(--color-ink-muted)]">
          <input type="checkbox" disabled className="size-4" />
          Code Scanning auto-sync requires install-token code scanning permissions
        </label>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 font-mono text-[11px] text-[var(--color-ink)] hover:bg-white disabled:opacity-50"
          >
            {busy ? "processing" : "ingest SARIF"}
          </button>
          {exportPath !== null && (
            <a
              href={exportPath}
              className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 font-mono text-[11px] text-[var(--color-ink)] hover:bg-white"
            >
              export SARIF
            </a>
          )}
        </div>
        {error !== null && <p className="text-sm text-red-700">{error}</p>}
        {result !== null && (
          <div className="grid gap-2 border-t border-[var(--color-line)] pt-4 font-mono text-[11px] text-[var(--color-ink-muted)]">
            <span>batch {result.batch_id}</span>
            <span>tool {result.source_tool}</span>
            <span>
              {result.stats.totalClaims} total · {result.stats.realCount} real ·{" "}
              {result.stats.falsePositiveCount} false positives · {result.stats.inconclusiveCount}{" "}
              inconclusive · {result.stats.errorCount} errors
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function parseRepo(value: string): { owner: string; repo: string } | null {
  const [owner, repo] = value.split("/");
  if (owner === undefined || repo === undefined || owner.length === 0 || repo.length === 0) {
    return null;
  }
  return { owner, repo };
}
