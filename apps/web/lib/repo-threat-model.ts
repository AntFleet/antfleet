import type { ChangedFile } from "./github-files";
import { isReviewablePath, MAX_FILE_BYTES } from "./github-files";

export const REPO_THREAT_MODEL_VERSION = 1;
export const REPO_THREAT_MODEL_GENERATOR_ID = "repo-threat-model-static-v1";

const MAX_THREAT_MODEL_FILES = 60;
const MAX_THREAT_MODEL_TOTAL_BYTES = 240 * 1024;

export type ThreatModelPublicAccess = "private" | "public" | "live_protocol_review_required";

export type ThreatModelSectionName =
  | "entryPoints"
  | "trustBoundaries"
  | "sinks"
  | "secretsSurface"
  | "criticalAssets";

export type ThreatModelItem = {
  name: string;
  kind: string;
  path: string;
  line: number | null;
  summary: string;
  confidence: "low" | "medium" | "high";
};

export type ThreatModelSection = {
  items: ThreatModelItem[];
  provenance: {
    modelId: string;
    lastRefreshedSha: string;
    refreshCount: number;
  };
};

export type RepoThreatModelDocument = {
  schemaVersion: 1;
  repo: {
    owner: string;
    repo: string;
    repoHash: string;
  };
  generatedAt: string;
  updatedAt: string;
  sections: Record<ThreatModelSectionName, ThreatModelSection>;
};

export type RepoThreatModelPublicView = {
  schemaVersion: 1;
  repo: {
    owner: string;
    repo: string;
  };
  updatedAt: string;
  sections: Pick<RepoThreatModelDocument["sections"], "entryPoints" | "trustBoundaries" | "sinks">;
};

export type RepoThreatModelForReachability = Pick<
  RepoThreatModelDocument["sections"],
  "entryPoints"
>;

export type StoredRepoThreatModel = {
  version: number;
  model: unknown;
  refreshCount: number;
};

export type RepoThreatModelUpdateResult = {
  document: RepoThreatModelDocument;
  changed: boolean;
  refreshedSections: ThreatModelSectionName[];
};

export type RepoThreatModelSnapshot = {
  files: ChangedFile[];
  paths: string[];
};

export type RepoThreatModelPersistence = {
  repoHash: string;
  owner: string;
  repo: string;
  version: number;
  model: RepoThreatModelDocument;
  publicModel: RepoThreatModelPublicView | Record<string, never>;
  provenance: unknown;
  generatorModelId: string;
  lastReviewedSha: string;
  entryPointsRefreshedSha: string | null;
  trustBoundariesRefreshedSha: string | null;
  sinksRefreshedSha: string | null;
  secretsSurfaceRefreshedSha: string | null;
  criticalAssetsRefreshedSha: string | null;
  refreshCount: number;
  publicAccess: ThreatModelPublicAccess;
};

export function generateRepoThreatModel(args: {
  owner: string;
  repo: string;
  repoHash: string;
  sha: string;
  files: readonly ChangedFile[];
  now?: Date;
}): RepoThreatModelDocument {
  const now = (args.now ?? new Date()).toISOString();
  const sections = classifyThreatModelSections(args.files, args.sha, 1);
  return {
    schemaVersion: REPO_THREAT_MODEL_VERSION,
    repo: { owner: args.owner, repo: args.repo, repoHash: args.repoHash },
    generatedAt: now,
    updatedAt: now,
    sections,
  };
}

export function updateRepoThreatModel(args: {
  existing: RepoThreatModelDocument;
  sha: string;
  changedFiles: readonly ChangedFile[];
  repoPaths?: readonly string[] | null;
  now?: Date;
}): RepoThreatModelUpdateResult {
  const touched = new Set(threatModelSectionsForUpdate(args.existing, args.changedFiles));
  const repoPaths =
    args.repoPaths === undefined || args.repoPaths === null ? null : new Set(args.repoPaths);
  for (const section of SECTION_NAMES) {
    if (
      repoPaths !== null &&
      args.existing.sections[section].items.some((item) => !repoPaths.has(item.path))
    ) {
      touched.add(section);
    }
  }
  const touchedSections = SECTION_NAMES.filter((section) => touched.has(section));
  if (touchedSections.length === 0) {
    return { document: args.existing, changed: false, refreshedSections: [] };
  }

  const refreshCount = Math.max(1, maxSectionRefreshCount(args.existing) + 1);
  const partial = classifyThreatModelSections(args.changedFiles, args.sha, refreshCount);
  const updated: RepoThreatModelDocument = {
    ...args.existing,
    updatedAt: (args.now ?? new Date()).toISOString(),
    sections: { ...args.existing.sections },
  };

  for (const section of touchedSections) {
    updated.sections[section] = mergeSectionItems(
      args.existing.sections[section],
      partial[section],
      args.changedFiles,
      repoPaths,
    );
  }

  return { document: updated, changed: true, refreshedSections: touchedSections };
}

export function parseRepoThreatModelDocument(value: unknown): RepoThreatModelDocument | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (obj["schemaVersion"] !== REPO_THREAT_MODEL_VERSION) return null;
  const sections = obj["sections"];
  if (sections === null || typeof sections !== "object" || Array.isArray(sections)) return null;
  for (const section of SECTION_NAMES) {
    const raw = (sections as Record<string, unknown>)[section];
    if (!isThreatModelSection(raw)) return null;
  }
  return value as RepoThreatModelDocument;
}

export function toReachabilityThreatModel(
  document: RepoThreatModelDocument | null,
): RepoThreatModelForReachability | null {
  if (document === null) return null;
  return { entryPoints: document.sections.entryPoints };
}

export function publicThreatModelView(args: {
  document: RepoThreatModelDocument;
  access: ThreatModelPublicAccess;
}): RepoThreatModelPublicView | Record<string, never> {
  if (args.access !== "public") return {};
  return {
    schemaVersion: REPO_THREAT_MODEL_VERSION,
    repo: {
      owner: args.document.repo.owner,
      repo: args.document.repo.repo,
    },
    updatedAt: args.document.updatedAt,
    sections: {
      entryPoints: args.document.sections.entryPoints,
      trustBoundaries: args.document.sections.trustBoundaries,
      sinks: args.document.sections.sinks,
    },
  };
}

export function repoThreatModelPersistence(args: {
  document: RepoThreatModelDocument;
  sha: string;
  refreshCount: number;
  publicAccess: ThreatModelPublicAccess;
}): RepoThreatModelPersistence {
  const sections = args.document.sections;
  return {
    repoHash: args.document.repo.repoHash,
    owner: args.document.repo.owner,
    repo: args.document.repo.repo,
    version: REPO_THREAT_MODEL_VERSION,
    model: args.document,
    publicModel: publicThreatModelView({ document: args.document, access: args.publicAccess }),
    provenance: sectionProvenance(args.document),
    generatorModelId: REPO_THREAT_MODEL_GENERATOR_ID,
    lastReviewedSha: args.sha,
    entryPointsRefreshedSha: sections.entryPoints.provenance.lastRefreshedSha,
    trustBoundariesRefreshedSha: sections.trustBoundaries.provenance.lastRefreshedSha,
    sinksRefreshedSha: sections.sinks.provenance.lastRefreshedSha,
    secretsSurfaceRefreshedSha: sections.secretsSurface.provenance.lastRefreshedSha,
    criticalAssetsRefreshedSha: sections.criticalAssets.provenance.lastRefreshedSha,
    refreshCount: args.refreshCount,
    publicAccess: args.publicAccess,
  };
}

export function publicAccessForThreatModel(args: {
  owner: string;
  repo: string;
  publicReceipt: boolean;
}): ThreatModelPublicAccess {
  if (!args.publicReceipt) return "private";
  const name = `${args.owner}/${args.repo}`.toLowerCase();
  if (operatorApprovedPublicRepo(name)) return "public";
  if (LIVE_PROTOCOL_REPO_HINTS.some((hint) => name.includes(hint))) {
    return "live_protocol_review_required";
  }
  return isSyntheticPublicRepo(name) ? "public" : "live_protocol_review_required";
}

export function threatModelSectionsTouched(
  files: readonly Pick<ChangedFile, "filename" | "contents" | "patch">[],
): ThreatModelSectionName[] {
  const touched = new Set<ThreatModelSectionName>();
  for (const file of files) {
    const haystack = `${file.filename}\n${file.patch ?? ""}\n${file.contents}`.toLowerCase();
    for (const rule of SECTION_RULES) {
      if (rule.patterns.some((pattern) => pattern.test(haystack))) touched.add(rule.section);
    }
  }
  return SECTION_NAMES.filter((section) => touched.has(section));
}

export function threatModelNeedsRefresh(files: readonly ChangedFile[]): boolean {
  return threatModelSectionsTouched(files).length > 0;
}

function threatModelSectionsForUpdate(
  existing: RepoThreatModelDocument,
  changedFiles: readonly ChangedFile[],
): ThreatModelSectionName[] {
  const touched = new Set(threatModelSectionsTouched(changedFiles));
  const changedPaths = new Set(changedFiles.map((file) => file.filename));
  for (const section of SECTION_NAMES) {
    if (existing.sections[section].items.some((item) => changedPaths.has(item.path))) {
      touched.add(section);
    }
  }
  return SECTION_NAMES.filter((section) => touched.has(section));
}

export type ThreatModelOctokit = {
  rest: {
    git: {
      getCommit: (params: { owner: string; repo: string; commit_sha: string }) => Promise<{
        data: {
          tree?: {
            sha?: string;
          };
        };
      }>;
      getTree: (params: {
        owner: string;
        repo: string;
        tree_sha: string;
        recursive: "1";
      }) => Promise<{
        data: {
          truncated?: boolean;
          tree?: Array<{
            path?: string;
            type?: string;
            size?: number;
            sha?: string;
          }>;
        };
      }>;
    };
    repos: {
      getContent: (params: {
        owner: string;
        repo: string;
        path: string;
        ref: string;
      }) => Promise<{ data: unknown }>;
    };
  };
};

export async function getRepoThreatModelFilesWith(
  octokit: ThreatModelOctokit,
  args: { owner: string; repo: string; sha: string },
): Promise<RepoThreatModelSnapshot> {
  const commit = await octokit.rest.git.getCommit({
    owner: args.owner,
    repo: args.repo,
    commit_sha: args.sha,
  });
  const treeSha = commit.data.tree?.sha;
  if (typeof treeSha !== "string" || treeSha.length === 0) {
    throw new Error("repo threat model commit did not include a tree sha");
  }
  const tree = await octokit.rest.git.getTree({
    owner: args.owner,
    repo: args.repo,
    tree_sha: treeSha,
    recursive: "1",
  });
  if (tree.data.truncated === true) {
    throw new Error("repo threat model file tree was truncated by GitHub");
  }
  const eligible = (tree.data.tree ?? [])
    .filter((item) => item.type === "blob")
    .filter((item): item is { path: string; type: string; size?: number; sha?: string } => {
      return (
        typeof item.path === "string" &&
        isReviewablePath(item.path) &&
        !isIgnoredThreatModelPath(item.path)
      );
    });
  const paths = eligible.map((item) => item.path);
  const candidates = eligible
    .filter((item) => item.size === undefined || item.size <= MAX_FILE_BYTES)
    .toSorted((a, b) => threatModelFileScore(b.path) - threatModelFileScore(a.path))
    .slice(0, MAX_THREAT_MODEL_FILES);

  const out: ChangedFile[] = [];
  let totalBytes = 0;
  for (const item of candidates) {
    const resp = await octokit.rest.repos.getContent({
      owner: args.owner,
      repo: args.repo,
      path: item.path,
      ref: args.sha,
    });
    const data = resp.data as { type?: string; content?: string } | unknown[];
    if (Array.isArray(data) || data.type !== "file" || typeof data.content !== "string") continue;
    const contents = Buffer.from(data.content, "base64").toString("utf8");
    const bytes = Buffer.byteLength(contents, "utf8");
    if (
      bytes === 0 ||
      bytes > MAX_FILE_BYTES ||
      totalBytes + bytes > MAX_THREAT_MODEL_TOTAL_BYTES
    ) {
      continue;
    }
    totalBytes += bytes;
    out.push({
      filename: item.path,
      contents,
      status: "changed",
      sha: item.sha ?? args.sha,
      patch: null,
    });
  }
  return { files: out, paths };
}

const SECTION_NAMES: ThreatModelSectionName[] = [
  "entryPoints",
  "trustBoundaries",
  "sinks",
  "secretsSurface",
  "criticalAssets",
];

const LIVE_PROTOCOL_REPO_HINTS = [
  "aave",
  "balancer",
  "compound",
  "curve",
  "doppler",
  "eigenlayer",
  "lido",
  "maker",
  "morpho",
  "uniswap",
];
const SAFE_PUBLIC_REPO_RE = /(^|[/_-])(bench|benchmark|fixture|example|demo|test)([/_-]|$)/u;

const SECTION_RULES: Array<{ section: ThreatModelSectionName; patterns: RegExp[] }> = [
  {
    section: "entryPoints",
    patterns: [
      /\b(route|router|handler|controller|server|api|webhook|cron|schedule|command|cli)\b/u,
      /\b(app\.(get|post|put|patch|delete)|fastify\.|router\.(get|post|put|patch|delete))\b/u,
      /\bexport\s+(async\s+)?function\b/u,
    ],
  },
  {
    section: "trustBoundaries",
    patterns: [
      /\b(auth|session|jwt|oauth|permission|role|admin|middleware|cors|csrf|apikey|api_key)\b/u,
      /\b(public|private|internal|external|unauthenticated|authenticated)\b/u,
    ],
  },
  {
    section: "sinks",
    patterns: [
      /\b(exec|spawn|eval|function\(|deserialize|pickle|yaml\.load|writefile|appendfile)\b/u,
      /\b(insert|update|delete|query|transaction|fetch|axios|request|http\.|https\.)\b/u,
      /\b(prisma|drizzle|sequelize|mongoose|knex|sql`|\$queryraw)\b/u,
    ],
  },
  {
    section: "secretsSurface",
    patterns: [
      /\b(process\.env|dotenv|secret|token|api[_-]?key|private[_-]?key|password|credential)\b/u,
      /\b(vault|kms|keychain|keystore|mounted|\.env)\b/u,
    ],
  },
  {
    section: "criticalAssets",
    patterns: [
      /\b(payment|wallet|balance|fund|transfer|withdraw|deposit|invoice|billing|settlement)\b/u,
      /\b(user|account|email|pii|admin|owner|control plane|credential|oauth)\b/u,
    ],
  },
];

function classifyThreatModelSections(
  files: readonly ChangedFile[],
  sha: string,
  refreshCount: number,
): Record<ThreatModelSectionName, ThreatModelSection> {
  const sections: Record<ThreatModelSectionName, ThreatModelSection> = {
    entryPoints: emptySection(sha, refreshCount),
    trustBoundaries: emptySection(sha, refreshCount),
    sinks: emptySection(sha, refreshCount),
    secretsSurface: emptySection(sha, refreshCount),
    criticalAssets: emptySection(sha, refreshCount),
  };

  for (const file of files) {
    if (isIgnoredThreatModelPath(file.filename)) continue;
    addEntryPointItems(sections.entryPoints.items, file);
    addKeywordItems(sections.trustBoundaries.items, file, "trust-boundary", [
      "auth",
      "session",
      "jwt",
      "permission",
      "role",
      "admin",
      "middleware",
      "cors",
      "csrf",
    ]);
    addKeywordItems(sections.sinks.items, file, "sink", [
      "exec",
      "spawn",
      "eval",
      "writeFile",
      "appendFile",
      "fetch",
      "query",
      "insert",
      "update",
      "delete",
      "transaction",
    ]);
    addKeywordItems(sections.secretsSurface.items, file, "secret-surface", [
      "process.env",
      "secret",
      "token",
      "apiKey",
      "api_key",
      "privateKey",
      "private_key",
      "password",
    ]);
    addKeywordItems(sections.criticalAssets.items, file, "critical-asset", [
      "payment",
      "wallet",
      "balance",
      "transfer",
      "withdraw",
      "deposit",
      "billing",
      "settlement",
      "email",
      "pii",
      "admin",
    ]);
  }

  for (const section of SECTION_NAMES) {
    sections[section].items = dedupeItems(sections[section].items).slice(0, 25);
  }
  return sections;
}

function emptySection(sha: string, refreshCount: number): ThreatModelSection {
  return {
    items: [],
    provenance: {
      modelId: REPO_THREAT_MODEL_GENERATOR_ID,
      lastRefreshedSha: sha,
      refreshCount,
    },
  };
}

function addEntryPointItems(out: ThreatModelItem[], file: ChangedFile): void {
  const path = file.filename;
  const lowerPath = path.toLowerCase();
  const content = file.contents;
  const patterns: Array<{
    kind: string;
    re: RegExp;
    summary: string;
    pathGate?: (path: string) => boolean;
  }> = [
    {
      kind: "http",
      re: /\b(app|router)\.(get|post|put|patch|delete)\s*\(|\bexport\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/u,
      summary: "HTTP route handler",
    },
    {
      kind: "webhook",
      re: /\bwebhook\b/iu,
      summary: "webhook receiver",
      pathGate: (p) => p.includes("webhook") && !/(components|hooks|i18n|locales)/u.test(p),
    },
    {
      kind: "cron",
      re: /\b(cron|schedule|scheduled)\b/iu,
      summary: "scheduled job",
      pathGate: (p) =>
        /(cron|schedule|job|worker)/u.test(p) && !/(components|i18n|locales)/u.test(p),
    },
    {
      kind: "cli",
      re: /\b(command|commander|yargs|process\.argv|tsx|node)\b/iu,
      summary: "CLI command",
      pathGate: (p) => /(^|\/)(scripts|cmd|cli|bin)\//u.test(p),
    },
    {
      kind: "public-export",
      re: /\bexport\s+(async\s+)?(function|const|class)\b/u,
      summary: "public module export",
      pathGate: (p) => /(^|\/)(index|mod|main)\.(ts|tsx|js|mjs|go|rs|py)$/u.test(p),
    },
    {
      kind: "queue-consumer",
      re: /\b(queue|consumer|subscribe|handler)\b/iu,
      summary: "message or event consumer",
      pathGate: (p) => !/(components|hooks|i18n|locales)/u.test(p),
    },
  ];

  for (const pattern of patterns) {
    if (!pattern.re.test(content) && !pattern.re.test(lowerPath)) continue;
    if (pattern.pathGate !== undefined && !pattern.pathGate(lowerPath)) continue;
    out.push({
      name: `${pattern.kind}:${path}`,
      kind: pattern.kind,
      path,
      line: firstMatchingLine(content, pattern.re),
      summary: pattern.summary,
      confidence: lowerPathIncludesKind(lowerPath, pattern.kind) ? "high" : "medium",
    });
  }
}

function addKeywordItems(
  out: ThreatModelItem[],
  file: ChangedFile,
  kind: string,
  keywords: readonly string[],
): void {
  const lowerPath = file.filename.toLowerCase();
  const lowerContents = file.contents.toLowerCase();
  for (const keyword of keywords) {
    const lowerKeyword = keyword.toLowerCase();
    if (!lowerPath.includes(lowerKeyword) && !lowerContents.includes(lowerKeyword)) continue;
    out.push({
      name: `${kind}:${keyword}:${file.filename}`,
      kind,
      path: file.filename,
      line: firstKeywordLine(file.contents, keyword),
      summary: `${kind} involving ${keyword}`,
      confidence: lowerPath.includes(lowerKeyword) ? "high" : "medium",
    });
    return;
  }
}

function firstMatchingLine(contents: string, re: RegExp): number | null {
  const lines = contents.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i]!)) return i + 1;
  }
  return null;
}

function firstKeywordLine(contents: string, keyword: string): number | null {
  const lowerKeyword = keyword.toLowerCase();
  const lines = contents.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.toLowerCase().includes(lowerKeyword)) return i + 1;
  }
  return null;
}

function dedupeItems(items: ThreatModelItem[]): ThreatModelItem[] {
  const seen = new Set<string>();
  const out: ThreatModelItem[] = [];
  for (const item of items) {
    const key = `${item.kind}:${item.path}:${item.line ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function mergeSectionItems(
  existing: ThreatModelSection,
  refreshed: ThreatModelSection,
  changedFiles: readonly Pick<ChangedFile, "filename">[],
  repoPaths: ReadonlySet<string> | null,
): ThreatModelSection {
  const refreshedPaths = new Set([
    ...changedFiles.map((file) => file.filename),
    ...refreshed.items.map((item) => item.path),
  ]);
  const kept = existing.items.filter((item) => {
    if (repoPaths !== null && !repoPaths.has(item.path)) return false;
    return !refreshedPaths.has(item.path);
  });
  return {
    items: dedupeItems([...refreshed.items, ...kept]).slice(0, 25),
    provenance: refreshed.provenance,
  };
}

function maxSectionRefreshCount(document: RepoThreatModelDocument): number {
  return Math.max(
    ...SECTION_NAMES.map((section) => document.sections[section].provenance.refreshCount),
  );
}

function sectionProvenance(document: RepoThreatModelDocument): unknown {
  const out: Record<string, ThreatModelSection["provenance"]> = {};
  for (const section of SECTION_NAMES) out[section] = document.sections[section].provenance;
  return out;
}

function isThreatModelSection(value: unknown): value is ThreatModelSection {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return Array.isArray(obj["items"]);
}

function threatModelFileScore(path: string): number {
  const lower = path.toLowerCase();
  let score = 0;
  if (/(^|\/)(app|pages|api|routes|controllers|server|cmd|cli|scripts)\//u.test(lower)) score += 20;
  if (/(auth|middleware|webhook|cron|schedule|queue|consumer|worker)/u.test(lower)) score += 15;
  if (/(db|database|storage|wallet|payment|billing|admin|secret|config)/u.test(lower)) score += 10;
  if (/\.(ts|tsx|js|mjs|go|py|rs|sol)$/u.test(lower)) score += 5;
  return score;
}

function isIgnoredThreatModelPath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.startsWith(".agents/") ||
    lower.startsWith(".claude/") ||
    lower.includes("/__tests__/") ||
    lower.includes("/test/") ||
    lower.includes("/tests/") ||
    /\b(test|spec)\.(ts|tsx|js|mjs|py|go|rs|sol)$/u.test(lower) ||
    /\.(md|mdx)$/u.test(lower)
  );
}

function operatorApprovedPublicRepo(name: string): boolean {
  const allowlist = process.env["ANTFLEET_PUBLIC_THREAT_MODEL_REPOS"];
  if (allowlist === undefined || allowlist.trim() === "") return false;
  return allowlist
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .some((entry) => entry === name);
}

function isSyntheticPublicRepo(name: string): boolean {
  return SAFE_PUBLIC_REPO_RE.test(name);
}

function lowerPathIncludesKind(path: string, kind: string): boolean {
  if (kind === "public-export") return path.includes("index.") || path.includes("mod.");
  if (kind === "queue-consumer") return path.includes("queue") || path.includes("consumer");
  return path.includes(kind);
}
