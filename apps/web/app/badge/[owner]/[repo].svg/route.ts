import { NextResponse } from "next/server";
import { countFindingsForRepo } from "@/lib/identity-drift";

export const dynamic = "force-dynamic";

type RouteParams = {
  owner: string;
  repo: string;
};

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export async function GET(_req: Request, { params }: { params: Promise<RouteParams> }) {
  const { owner, repo } = await params;
  const repoName = repo.endsWith(".svg") ? repo.slice(0, -4) : repo;
  const repoFullName = `${owner}/${repoName}`;
  const count = await countFindingsForRepo(repoFullName);
  const status = count === 0 ? "not yet reviewed" : "reviewed";
  const label = `AntFleet · ${count} finding${count === 1 ? "" : "s"} · ${status}`;
  const width = Math.max(260, label.length * 7 + 28);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="28" role="img" aria-label="${xmlEscape(label)}">
  <rect width="${width}" height="28" rx="6" fill="#0a0a0a"/>
  <rect x="1" y="1" width="${width - 2}" height="26" rx="5" fill="#ffffff"/>
  <text x="14" y="18" fill="#0a0a0a" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">${xmlEscape(label)}</text>
</svg>`;
  return new NextResponse(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, s-maxage=300",
    },
  });
}
