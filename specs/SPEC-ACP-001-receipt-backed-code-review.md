# SPEC-ACP-001 - Receipt-backed code review for agent repos

**Status:** Draft for v0 implementation
**Date:** 2026-06-10
**Owner:** AntFleet
**Offering:** Receipt-backed code review for agent repos
**External context checked:** Virtuals ACP commerce docs, `@virtuals-protocol/acp-cli`, x402 docs, x402 Foundation repo

## 0. Implementation and Submission Boundary

This repository is the product/spec reference for the ACP provider.

**PR #82 architecture pivot:** the v0 launch adapter intentionally runs in this
repo (`AntFleet/antfleet`) because the existing receipt, review job, ACP status,
and public schema surfaces already live here. The original plan to put all
production provider runtime in [`AntFleet/antfleet-core`](https://github.com/AntFleet/antfleet-core)
is now a future extraction path, not a prerequisite for registering the first
Virtuals ACP Reviewer offering.

Submissions, demo wiring, and marketplace-facing examples must be prepared through [`Virtual-Protocol/acp-cli-demos`](https://github.com/Virtual-Protocol/acp-cli-demos) from the AntFleet operator account `antfleet-ops`.

Practical boundary for v0:

- This spec may define schemas, copy, receipt behavior, and acceptance criteria.
- `AntFleet/antfleet` owns the v0 ACP intake adapter, durable inbox, budget/funded transitions, provider worker, guarded ACP submit state, receipts, status projection, schemas, docs, and validation fixtures.
- `antfleet-core` remains the preferred extraction target if the runtime grows beyond the narrow v0 adapter.
- `acp-cli-demos` owns Virtuals demo/submission artifacts, demo scripts, and any required upstream example PR.

## 1. Product Positioning

### One-sentence description

AntFleet is an ACP provider that reviews agent repositories with two independent frontier models, returns only consensus findings, and publishes SHA-pinned receipts when those findings are fixed.

### Target users / buyer agents

- Virtuals agents building ACP handlers, agent wallets, workflow scripts, trading-agent code, data pipelines, or repo automation.
- Provider agents that want a pre-delivery review before submitting code to an ACP client.
- Evaluator agents that need a second-opinion audit artifact for a disputed or high-value job.
- Agent operators preparing a repository for Virtuals Showcase, marketplace listing, or public launch.

### Why it matters inside Virtuals

ACP makes agent labor discoverable and escrowed, but the marketplace still needs practical trust artifacts. A buyer agent should not have to trust a provider's "LGTM" model output. It should be able to hire an independent reviewer, receive structured findings, and later point to public receipts proving that real code changes closed real issues at specific SHAs.

This fits the Virtuals economy because:

- ACP jobs already model provider/client/evaluator roles and escrowed service delivery.
- EconomyOS gives agents wallets, email, compute, cards, and marketplace access, so agents can buy security review without human account setup.
- AntFleet's output is machine-readable enough for agent workflows and public enough for marketplace reputation.
- Receipts create durable proof that can be reused in listings, Showcase submissions, changelogs, and evaluator decisions.
- The implementation path is compatible with Virtuals submission expectations because v0 provider code lives in `AntFleet/antfleet`, with `antfleet-core` documented as the extraction target and demo/submission artifacts in `Virtual-Protocol/acp-cli-demos`.

### Explicit non-claims

AntFleet must not claim:

- That it proves code is secure, safe, profitable, or bug-free.
- That it replaces human security review, formal verification, compliance review, or exchange/regulatory review.
- That it provides financial advice, trading advice, strategy validation, alpha, risk management, or autonomous trading approval.
- That a no-finding result means no issues exist. It means no eligible two-model consensus finding was emitted for the submitted scope.
- That individual model outputs are endorsed findings. Only the agreement gate output is the product.
- That public receipts expose all raw code or private repository content. Receipts expose bounded evidence and SHA-pinned closure metadata.

## 2. ACP Offering Definition

### Offering

**Name:** Receipt-backed code review for agent repos

**Marketplace description:**

> Two independent frontier reviewers inspect a public GitHub PR. AntFleet returns only findings both models agree on, plus a review receipt URL or receipt-pending status. Built for ACP handlers, agent repos, trading-agent code, and workflow automation.

### Price model

v0 should use fixed USDC pricing inside ACP escrow:

- **PR review:** `1.00 USDC` flat per public PR up to existing AntFleet changed-file limits.
- **Manual dispute rerun:** no automatic free rerun in v0; disputed jobs can be re-run by operator override only.

Rationale: fixed pricing is easiest for buyer agents to reason about, maps to ACP budget/fund flow, and avoids usage-based settlement complexity in the first provider.

Note: existing direct HTTP/x402 review defaults may remain lower, for example `0.50 USDC`. The ACP price is intentionally higher because it includes marketplace discovery, escrow lifecycle handling, typed delivery, and dispute/evaluator support.

### SLA

- Provider response to new ACP job: within 2 minutes.
- PR review delivery: target 10 minutes, hard SLA 30 minutes.
- Receipt finalization:
  - Review-level receipt: returned at delivery time when a review row exists.
  - Finding-level closure receipt: pending until the finding is fixed and closure is detected.
- Provider online window: 24/7 best effort with queue retry; v0 listing should advertise "beta SLA".

### Required inputs JSON schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://www.antfleet.dev/schemas/acp/review-request-v0.json",
  "title": "AntFleet ACP review request",
  "type": "object",
  "additionalProperties": false,
  "required": ["target", "mode"],
  "properties": {
    "mode": {
      "type": "string",
      "const": "pr",
      "description": "v0 reviews one public pull request. Repo scan is deferred until scan receipts have a persistence model."
    },
    "target": {
      "type": "object",
      "additionalProperties": false,
      "required": ["repo"],
      "properties": {
        "repo": {
          "type": "string",
          "pattern": "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
          "examples": ["virtuals-agent/acp-handler"]
        },
        "pr": {
          "type": "integer",
          "minimum": 1,
          "description": "Required when mode=pr unless sha is supplied and resolves to exactly one open PR head."
        },
        "sha": {
          "type": "string",
          "pattern": "^[0-9a-fA-F]{7,64}$",
          "description": "Optional PR head SHA. For PR reviews, SHA must resolve to exactly one open PR head."
        }
      }
    },
    "client": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "agent_wallet": { "type": "string", "pattern": "^0x[a-fA-F0-9]{40}$" },
        "agent_name": { "type": "string", "maxLength": 120 },
        "contact_email": { "type": "string", "format": "email" }
      }
    },
    "options": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "public_receipt": {
          "type": "boolean",
          "const": true,
          "default": true,
          "description": "v0 requires public receipts for public PR reviews. Private receipt mode is deferred."
        },
        "focus": {
          "type": "array",
          "maxItems": 5,
          "items": {
            "type": "string",
            "enum": ["security", "api-contract", "data-loss", "concurrency", "trading-risk", "build-release"]
          }
        },
        "max_findings": {
          "type": "integer",
          "minimum": 0,
          "maximum": 20,
          "default": 10
        },
        "acknowledge_not_financial_advice": {
          "type": "boolean",
          "description": "Required true when focus includes trading-risk. Runtime validation may also require it when v0 trading-code heuristics match."
        }
      }
    }
  },
  "allOf": [
    {
      "oneOf": [
        {
          "properties": {
            "target": {
              "required": ["pr"],
              "not": { "required": ["sha"] }
            }
          }
        },
        {
          "properties": {
            "target": {
              "required": ["sha"],
              "not": { "required": ["pr"] }
            }
          }
        }
      ]
    },
    {
      "if": {
        "properties": {
          "options": {
            "properties": {
              "focus": {
                "contains": { "const": "trading-risk" }
              }
            },
            "required": ["focus"]
          }
        }
      },
      "then": {
        "properties": {
          "options": {
            "required": ["acknowledge_not_financial_advice"],
            "properties": {
              "acknowledge_not_financial_advice": { "const": true }
            }
          }
        }
      }
    }
  ]
}
```

### Deliverable schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://www.antfleet.dev/schemas/acp/review-deliverable-v0.json",
  "title": "AntFleet ACP review deliverable",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "status", "job", "target", "review", "receipt", "findings"],
  "properties": {
    "schema_version": { "type": "string", "const": "antfleet.acp.review.deliverable.v0" },
    "status": {
      "type": "string",
      "enum": ["complete", "complete_no_findings", "receipt_pending"]
    },
    "job": {
      "type": "object",
      "additionalProperties": false,
      "required": ["acp_job_id", "antfleet_job_id", "provider_agent", "status_url"],
      "properties": {
        "acp_job_id": { "type": "string" },
        "antfleet_job_id": { "type": "string" },
        "provider_agent": { "type": "string" },
        "client_agent_wallet": { "type": "string" },
        "status_url": { "type": "string", "format": "uri" }
      }
    },
    "target": {
      "type": "object",
      "additionalProperties": false,
      "required": ["repo", "mode", "head_sha"],
      "properties": {
        "repo": { "type": "string" },
        "mode": { "type": "string", "const": "pr" },
        "pr": { "type": "integer", "minimum": 1 },
        "head_sha": { "type": "string" },
        "files_reviewed": { "type": "array", "items": { "type": "string" } }
      }
    },
    "review": {
      "type": "object",
      "additionalProperties": false,
      "required": ["review_id", "agreement_mode", "reviewer_count", "degraded", "model_ids"],
      "properties": {
        "review_id": { "type": "string" },
        "agreement_mode": { "type": "string", "const": "unanimous" },
        "reviewer_count": { "type": "integer", "const": 2 },
        "degraded": { "type": "boolean", "const": false },
        "degraded_reason": { "type": "null" },
        "model_ids": {
          "type": "object",
          "additionalProperties": { "type": "string" }
        },
        "duration_ms": { "type": "integer", "minimum": 0 }
      }
    },
    "receipt": {
      "type": "object",
      "additionalProperties": false,
      "required": ["state", "review_receipt_url", "finding_receipt_urls"],
      "properties": {
        "state": {
          "type": "string",
          "enum": ["review_receipt_ready", "finding_receipts_pending", "no_findings", "unavailable"]
        },
        "review_receipt_url": { "type": ["string", "null"], "format": "uri" },
        "finding_receipt_urls": {
          "type": "array",
          "items": { "type": "string", "format": "uri" }
        },
        "receipt_note": { "type": "string" }
      }
    },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "finding_id",
          "title",
          "severity",
          "category",
          "confidence",
          "evidence",
          "reasoning",
          "reproduction",
          "recommendation",
          "whyTestsDoNotAlreadyCoverThis",
          "suggestedRegressionTest",
          "minimumFixScope",
          "requiresPolicyReview",
          "upstreamOrigin",
          "status"
        ],
        "properties": {
          "finding_id": { "type": "string" },
          "title": { "type": "string" },
          "severity": { "type": "string", "enum": ["critical", "high", "medium", "low"] },
          "category": {
            "type": "string",
            "enum": [
              "bug",
              "security",
              "performance",
              "concurrency",
              "api-contract",
              "data-loss",
              "test-gap",
              "docs-gap",
              "build-release",
              "maintainability"
            ]
          },
          "confidence": { "type": "string", "enum": ["high", "medium", "low"] },
          "evidence": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": ["path", "startLine", "endLine", "symbol", "quote"],
              "properties": {
                "path": { "type": "string" },
                "startLine": { "type": ["integer", "null"], "minimum": 1 },
                "endLine": { "type": ["integer", "null"], "minimum": 1 },
                "symbol": { "type": ["string", "null"] },
                "quote": { "type": ["string", "null"] }
              }
            }
          },
          "reasoning": { "type": "string" },
          "reproduction": { "type": ["string", "null"] },
          "recommendation": { "type": "string" },
          "whyTestsDoNotAlreadyCoverThis": { "type": "string" },
          "suggestedRegressionTest": { "type": ["string", "null"] },
          "minimumFixScope": { "type": "string" },
          "requiresPolicyReview": { "type": "boolean" },
          "upstreamOrigin": {
            "anyOf": [
              {
                "type": "object",
                "additionalProperties": false,
                "required": ["package", "reason"],
                "properties": {
                  "package": { "type": "string" },
                  "reason": { "type": "string" }
                }
              },
              { "type": "null" }
            ]
          },
          "status": { "type": "string", "enum": ["open", "closed", "superseded", "not_posted"] },
          "receipt_url": { "type": ["string", "null"], "format": "uri" }
        }
      }
    },
    "disclaimer": {
      "type": "string",
      "description": "Required when reviewing trading-agent or financial workflow code."
    }
  }
}
```

The ACP adapter must map AntFleet's internal `Finding` objects directly and add only `finding_id`, `status`, and `receipt_url`. It must not rename internal finding fields unless the deliverable schema is versioned.

### Error schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://www.antfleet.dev/schemas/acp/review-error-v0.json",
  "title": "AntFleet ACP review error",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "status", "error"],
  "properties": {
    "schema_version": { "type": "string", "const": "antfleet.acp.review.error.v0" },
    "status": { "type": "string", "const": "failed" },
    "error": {
      "type": "object",
      "additionalProperties": false,
      "required": ["code", "message", "retryable", "settlement"],
      "properties": {
        "code": {
          "type": "string",
          "enum": [
            "invalid_input",
            "repo_not_accessible",
            "private_repo_not_supported",
            "pr_not_found",
            "pr_not_open",
            "sha_not_in_open_pr",
            "sha_ambiguous",
            "no_reviewable_files",
            "rate_limited",
            "provider_degraded",
            "provider_error",
            "timeout",
            "cost_cap_exceeded",
            "internal"
          ]
        },
        "message": { "type": "string" },
        "retryable": { "type": "boolean" },
        "settlement": {
          "type": "string",
          "enum": ["not_charged", "escrow_refundable", "escrow_releasable", "operator_review"]
        },
        "details": { "type": "object" }
      }
    }
  }
}
```

### Service-only or fund-transfer

This is **service-only**. AntFleet does not transfer client funds, custody funds, trade, bridge, or rebalance assets. ACP escrow handles job funding and settlement. AntFleet delivers code-review artifacts.

### Evaluation requirement

Evaluation should be **optional** in v0.

Default path: the client agent evaluates directly by checking that the deliverable validates against the schema and, when present, the receipt URL resolves.

Optional evaluator path: recommended for high-value jobs, disputes, or showcase submissions. The evaluator should verify:

- target repo/PR/SHA matches the request,
- schema is valid,
- review is not degraded,
- findings are consensus findings only,
- receipt URL is reachable or explicitly pending,
- no financial/trading claim is made.

## 3. User Flows

### Happy path: public PR review

1. Client agent discovers AntFleet's offering via ACP marketplace.
2. Client creates a job with `mode=pr`, `target.repo`, and `target.pr`.
3. AntFleet provider validates the job JSON and accepts.
4. Provider sets the fixed ACP budget.
5. Client funds escrow.
6. Provider resolves the public PR head SHA via GitHub.
7. Provider creates an internal AntFleet job keyed by `(acpJobId, repo, pr, sha)`.
8. AntFleet fetches changed files and runs `reviewPR()` using the existing two-model unanimous pipeline.
9. AntFleet persists review metadata and agreed findings.
10. Provider delivers structured JSON with findings and `/receipts/review/{review_id}`.
11. Client accepts; ACP job completes and escrow settles.

Example request:

```json
{
  "mode": "pr",
  "target": {
    "repo": "demo-agent/acp-handler",
    "pr": 42
  },
  "client": {
    "agent_wallet": "0x1111111111111111111111111111111111111111",
    "agent_name": "BuilderAgent"
  },
  "options": {
    "public_receipt": true,
    "focus": ["security", "api-contract"],
    "max_findings": 10
  }
}
```

Example deliverable:

```json
{
  "schema_version": "antfleet.acp.review.deliverable.v0",
  "status": "complete",
  "job": {
    "acp_job_id": "43868",
    "antfleet_job_id": "af_acp_01jz7ra9x0",
    "provider_agent": "AntFleet",
    "client_agent_wallet": "0x1111111111111111111111111111111111111111",
    "status_url": "https://www.antfleet.dev/api/v1/acp/review-jobs/af_acp_01jz7ra9x0"
  },
  "target": {
    "repo": "demo-agent/acp-handler",
    "mode": "pr",
    "pr": 42,
    "head_sha": "4d967f2a8f5a6f1d7a8235e8e6a9d2b7c8e9f001",
    "files_reviewed": ["src/handler.ts", "src/settlement.ts"]
  },
  "review": {
    "review_id": "b6f4e8d5-1b9e-4d50-930c-3d36f40d15a8",
    "agreement_mode": "unanimous",
    "reviewer_count": 2,
    "degraded": false,
    "degraded_reason": null,
    "model_ids": {
      "anthropic": "claude-opus-4-7",
      "openai": "gpt-5"
    },
    "duration_ms": 84231
  },
  "receipt": {
    "state": "finding_receipts_pending",
    "review_receipt_url": "https://www.antfleet.dev/receipts/review/b6f4e8d5-1b9e-4d50-930c-3d36f40d15a8",
    "finding_receipt_urls": [],
    "receipt_note": "Review receipt is ready. Finding receipts publish after fixes are detected and SHA-pinned."
  },
  "findings": [
    {
      "finding_id": "b6f4e8d5-0",
      "title": "ACP delivery accepts unsigned settlement callback",
      "severity": "high",
      "category": "security",
      "confidence": "high",
      "evidence": [
        {
          "path": "src/settlement.ts",
          "startLine": 88,
          "endLine": 103,
          "symbol": "handleSettlement",
          "quote": "callback payload is trusted before signature verification"
        }
      ],
      "reasoning": "Both reviewers flagged the same unauthenticated settlement path.",
      "reproduction": "Send a callback body with status=paid and no valid signature.",
      "recommendation": "Verify callback signature before reading settlement status.",
      "whyTestsDoNotAlreadyCoverThis": "Existing tests exercise successful settlement only.",
      "suggestedRegressionTest": "Reject unsigned settlement callbacks.",
      "minimumFixScope": "Verify the callback signature before parsing or trusting settlement status.",
      "requiresPolicyReview": false,
      "upstreamOrigin": null,
      "status": "open",
      "receipt_url": null
    }
  ]
}
```

### Deferred repo scan path

Repo scan is not in ACP v0 because the existing `scanRepo()` path returns scan results without creating a `reviews` row or public review receipt. Shipping it under the same receipt-backed offering would weaken the core promise.

The v0.1 repo scan path can ship after AntFleet adds one of:

- a scan receipt table/page keyed by `(repo, head_sha, scan_id)`, or
- a safe way to persist scan chunks into `reviews` without fake PR numbers.

When it ships, the flow should be:

1. Client submits a separate `repo_scan` offering with a public repo.
2. AntFleet resolves default branch HEAD and fetches the public tree.
3. Scanner filters reviewable files, groups by directory, and packs up to 10 chunks.
4. Each chunk runs through the same two-model review pipeline.
5. Findings are deduplicated across chunks by evidence agreement.
6. Deliverable includes `scan_id`, `head_sha`, `chunk_count`, `files_reviewed`, deduplicated findings, and a scan receipt URL or explicit `receipt.state=unavailable`.

Repo scan should use existing `scanRepo()` behavior from `apps/web/lib/repo-scanner.ts` rather than a new scanner.

### No findings path

Return `status=complete_no_findings`, `findings=[]`, and:

```json
{
  "state": "no_findings",
  "review_receipt_url": "https://www.antfleet.dev/receipts/review/{review_id}",
  "finding_receipt_urls": [],
  "receipt_note": "No two-model consensus findings were emitted for this scope."
}
```

Important wording: "No consensus findings" rather than "clean".

### Findings found path

Return open findings with `receipt_url=null` per finding until closure. The review-level receipt is ready immediately. Finding-level receipts become available only after a fix lands and AntFleet records the closure SHA.

### Receipt-pending path

Use `status=receipt_pending` when review completed but public receipt publication is delayed, for example:

- receipt page cache has not caught up,
- review row exists but public receipt projection has not indexed,
- closure detection is not yet applicable.

The deliverable must include the review ID and `job.status_url` so the client can poll.

### Failure / inaccessible repo path

Return a schema-valid `review-error-v0` object and reject or fail the ACP job according to its current ACP phase. Do not return `review-deliverable-v0` with `status=failed`; successful deliverables and error objects are separate schemas.

- before budget/funding: reject the job with `invalid_input` or `repo_not_accessible`,
- after funding but before compute: fail as `escrow_refundable`,
- after successful validation but no reviewable files: fail with `review-error-v0` code `no_reviewable_files` and settlement `escrow_refundable` for v0 clarity.

### Dispute / rejection path

If the client rejects:

1. Provider posts a compact dispute response containing `acp_job_id`, `antfleet_job_id`, `review_id`, target tuple, and receipt URL/state.
2. Optional evaluator checks schema validity and target matching.
3. If the deliverable is malformed, AntFleet re-delivers at no charge.
4. If the buyer disagrees with findings, the dispute should not expose raw per-provider outputs by default. AntFleet can disclose the agreement metadata, evidence ranges, and receipt trail.
5. If a finding is later proven false, operator can retract it using the existing receipt/retraction boundary; the ACP deliverable remains immutable but receipt page shows retraction state.

## 4. Technical Architecture

### Repository ownership

Production ACP implementation for PR #82 lands in `AntFleet/antfleet`.
`AntFleet/antfleet-core` remains the intended extraction target after the v0
marketplace path is proven.

This spec assumes the following repo split:

- This repo / `www.antfleet.dev`: v0 provider adapter, ACP CLI integration, job state machine, validation, review pipeline adapter, storage migrations, queue worker, public receipt pages, product docs, schema publication, read-only status/deliverable projections, and any web UI copy needed to support the offering.
- `AntFleet/antfleet-core`: future provider-runtime extraction target if the adapter needs isolation from the public web app.
- `Virtual-Protocol/acp-cli-demos`: demo provider/client scripts, submission fixtures, and marketplace/showcase artifacts submitted from `antfleet-ops`.

The v0 provider process is `apps/web/scripts/acp-provider-worker.ts`; it drains
ACP CLI events into `review_jobs` and `acp_provider_events`. Keep it narrow:
ACP-specific runtime growth beyond intake, review execution, submit guarding,
and recovery should trigger the `antfleet-core` extraction discussion.

### Repo anchors to adapt

- `apps/web/lib/review-pipeline.ts`: two-model PR review and agreement gate.
- `apps/web/lib/review-job-queries.ts`: existing async job persistence.
- `apps/web/lib/review-job-worker.ts`: existing review worker and x402 result payload shape.
- `apps/web/app/api/v1/review/x402/route.ts`: public PR validation, idempotency, status URL, and receipt result model.
- `apps/web/lib/repo-scanner.ts` and `apps/web/app/api/v1/scan/x402/route.ts`: deferred v0.1 reference for repo scan only; not part of ACP v0.
- `apps/web/lib/receipts.ts` and receipt pages: public receipt projection.

### ACP event mapping

ACP provider loop should be a thin adapter:

| ACP phase/event | AntFleet action |
| --- | --- |
| Job discovered / new task | Parse job content as `review-request-v0`; validate repo/target shape only. |
| Negotiation | Accept if public GitHub target can be resolved; set fixed price and SLA. Reject malformed/private/inaccessible targets. |
| Funded / transaction | Create internal `acp_review_jobs` row; enqueue worker. Do not overload `review_jobs.payment_rail`, whose current constraint is channel/x402-only. |
| Work started | Resolve PR SHA again and freeze target tuple. |
| Work complete | Persist review row, finding rows, and ACP job result JSON. |
| Deliver service | Submit deliverable JSON as ACP deliverable. |
| Evaluation | If optional evaluator is present, respond to evaluator with receipt/schema evidence. Otherwise wait for buyer accept/reject. |
| Rejected/disputed | Enter dispute workflow; do not rerun automatically unless malformed delivery or operator override. |

### Input validation

Validation layers:

1. JSON schema validation for ACP job content.
2. ACP signer validation: derive `acp_client_wallet` from the authenticated ACP job/client, not from untrusted request JSON.
3. Repo string normalization: lowercase owner/repo for idempotency, preserve display casing from GitHub response.
4. GitHub resolution:
   - PR mode: PR must exist, be open, and expose a head SHA.
   - SHA mode for PR review: SHA must match exactly one open PR head.
5. Scope caps:
   - PR review uses existing changed-file caps.
6. Trading disclaimer:
   - if `focus` includes `trading-risk`, require `acknowledge_not_financial_advice=true`;
   - if runtime trading-code heuristics match and the acknowledgment is missing, reject before funding with `invalid_input`;
   - deliverable includes the disclaimer string.

Trading-code heuristics for v0 are intentionally simple and auditable. Treat the repo as trading-agent code if any of these public GitHub metadata checks match before funding:

- repository topics include `trading`, `defi`, `dex`, `market-maker`, `arbitrage`, `portfolio`, or `execution`;
- repo name or description contains `trading`, `trade`, `trader`, `market-maker`, `arbitrage`, `portfolio`, `dex`, or `exchange`;
- changed-file paths include `trade`, `trading`, `orders`, `positions`, `portfolio`, `strategy`, `execution`, `exchange`, or `broker`.

These heuristics only trigger the disclaimer acknowledgment gate. They are not a claim that the repo is financial software.

### Calling existing pipelines

PR mode:

```ts
const files = await getPublicChangedFiles({ owner, repo, prNumber, headSha });
const bundle = await reviewPR({ files, owner, repo, prNumber, signal });
```

No new model prompt should be invented for v0. Use the existing prompt/versioning and finding schema.

### Job metadata storage

v0 should add one small ACP-specific table rather than overloading x402 fields:

```sql
CREATE TABLE acp_review_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  acp_job_id text NOT NULL UNIQUE,
  acp_client_wallet text NOT NULL,
  acp_provider_wallet text,
  acp_evaluator_wallet text,
  mode text NOT NULL CHECK (mode = 'pr'),
  repo_owner text NOT NULL,
  repo_name text NOT NULL,
  pr_number integer NOT NULL,
  requested_sha text,
  resolved_sha text NOT NULL,
  antfleet_review_id uuid REFERENCES reviews(review_id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'queued',
  failure_code text,
  failure_message text,
  deliverable jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX acp_review_jobs_status_idx ON acp_review_jobs(status, created_at);
CREATE UNIQUE INDEX acp_review_jobs_target_idempotency_idx
  ON acp_review_jobs(acp_client_wallet, mode, lower(repo_owner), lower(repo_name), pr_number, lower(resolved_sha));
```

The existing `reviews` table remains the source of truth for review evidence and receipts.

### Returning deliverables

The ACP handler should deliver the JSON object directly in the job deliverable. If ACP only supports URL deliverables for a given provider runtime, deliver:

```json
{
  "type": "url",
  "value": "https://www.antfleet.dev/api/v1/acp/jobs/{acp_job_id}/deliverable"
}
```

That endpoint should return the same deliverable schema with `Cache-Control: no-store` while the job is in progress and immutable cache headers after completion.

### Receipt URL generation and deferral

- Review-level URL: `https://www.antfleet.dev/receipts/review/{review_id}`.
- Finding-level closure URL: existing `/receipts/{finding_id}` or GitHub closure comment URL after closure.
- For PRs reviewed without GitHub App installation, AntFleet may not be able to post PR comments. The review receipt remains the primary artifact. Finding closure receipts are deferred until a public fix can be observed and pinned.
- `receipt.state` must distinguish:
  - `review_receipt_ready`,
  - `finding_receipts_pending`,
  - `no_findings`,
  - `unavailable`.

### Virtuals Compute credits

Use Compute credits only for AntFleet-owned runtime execution, not as delegated spend from client jobs in v0.

Safe v0 policy:

- Provider worker can run on Virtuals Compute if the AntFleet operator funds it.
- Client-supplied repo content must never choose model, max runtime, or spend cap.
- Enforce wall-clock timeout and changed-file caps before model calls.
- Record estimated USD/model cost for operator economics; do not pass through variable usage to ACP settlement in v0.
- Disable autonomous top-ups from job proceeds until explicit operator approval exists.

### x402 relationship

ACP and x402 are complementary, not substitutes:

- ACP offering is the agent-to-agent marketplace product: discovery, escrow, SLA, typed deliverable, optional evaluator.
- x402 endpoints are direct HTTP paid APIs for agents or scripts that do not need ACP job lifecycle.
- v0 ACP provider may internally reuse validation and worker code from x402 routes, but should not require x402 payment signatures. ACP escrow is the payment rail.
- Public listing copy can mention x402 as an alternate direct API only after the ACP path is stable.

Runtime intake shape, currently represented by ACP CLI events drained into
`apps/web/scripts/acp-provider-worker.ts`:

```http
POST {ANTFLEET_ACP_PROVIDER_BASE_URL}/review-jobs
Content-Type: application/json
X-AntFleet-ACP-Signature: ...

{
  "acp_job_id": "43868",
  "client_wallet": "0x1111111111111111111111111111111111111111",
  "request": {
    "mode": "pr",
    "target": { "repo": "demo-agent/acp-handler", "pr": 42 },
    "options": { "public_receipt": true }
  }
}
```

Read-only projection/status response, exposed through `www.antfleet.dev` from the v0 `review_jobs` ACP state:

```json
{
  "antfleet_job_id": "af_acp_01jz7ra9x0",
  "status": "queued",
  "status_url": "https://www.antfleet.dev/api/v1/acp/review-jobs/af_acp_01jz7ra9x0",
  "expected_duration_sec": 600
}
```

## 5. Security and Safety

### GitHub access rules

- v0 supports public GitHub repositories only.
- Use unauthenticated GitHub API or `GITHUB_PUBLIC_TOKEN` for rate-limited public reads.
- Never request client GitHub tokens through ACP in v0.
- Do not post PR comments unless `antfleet[bot]` is installed and repo policy allows it.
- Freeze resolved target SHA before model calls.
- Include target repo, PR, and SHA in every deliverable.

### Public vs private repo handling

- Public repo: accepted if GitHub API can resolve target and files are reviewable.
- Private repo: rejected in v0 with `private_repo_not_supported`.
- Future private support must go through GitHub App installation or a signed archive upload flow with explicit retention policy.

### Payment and settlement behavior

- ACP escrow is authoritative for payment.
- AntFleet should accept/fund/deliver only through ACP SDK actions; no side-channel payment in ACP job flow.
- If validation fails before funded phase, reject without budget.
- If compute fails after funding for provider/internal reasons, mark refundable/rejected according to ACP mechanics.
- If user input is invalid after funding because the repo disappeared or PR closed, deliver a structured failure and mark `escrow_releasable` only if ACP norms allow charging for validation work. v0 should prefer buyer-friendly refund for inaccessible targets.

### Abuse prevention

- Per client wallet: max 10 jobs/hour in v0.
- Per repo: max 1 fresh review per 10 minutes; repeated identical `(repo, pr, sha)` returns cached deliverable.
- Per target: idempotency by `acp_job_id` and target tuple.
- File caps: keep existing `MAX_FILE_BYTES`, `MAX_FILES`, `MAX_TOTAL_PROMPT_BYTES`, `MAX_CHUNKS=10`.
- Reject binary, vendored, generated, lockfile-heavy, and oversized files through existing reviewable-path filters.
- Log but do not deliver raw provider disagreements.

### Prompt injection from repo content

Repo content is hostile input. v0 controls:

- Existing prompt instructs reviewers to use only included file evidence.
- Structured output must parse through strict schemas.
- Triage skip is allowed only for docs-only file sets; non-doc files escalate regardless of model triage.
- Repo text cannot alter budget, target, recipient wallet, evaluator, model selection, or public receipt settings.
- Deliverables must not include hidden model instructions, secrets, or long raw file excerpts.
- If fewer than two independent reviewer outputs are available, or if the agreement gate cannot run, v0 fails with `review-error-v0` code `provider_degraded`. It must not deliver partial findings or any success payload marked as degraded.

### Trading-agent disclaimer

For trading-agent repos, include:

> AntFleet reviews code structure and implementation risks. It does not evaluate trading profitability, market strategy, regulatory suitability, portfolio risk, or whether an autonomous agent should trade. Findings are not financial advice.

### Data retention and public receipt boundaries

- Retain ACP job metadata, target tuple, model IDs, agreement output, timing, and cost estimates.
- Do not publicly expose raw provider outputs, non-agreed findings, private contact email, client wallet unless intentionally part of ACP public profile, or private repo names.
- Public receipts show review/finding metadata, evidence paths, category/severity/title, closure SHA, and public URLs.
- Add retraction state for false positives using existing retraction boundary; do not delete receipt history silently.

## 6. MVP Scope

### Ships in v0

- One ACP provider offering.
- Public PR review.
- Fixed USDC pricing.
- Optional evaluator.
- ACP job handler that validates requests, runs existing AntFleet PR review code, and delivers schema-valid JSON.
- Review-level receipt URL or receipt-pending status.
- Finding-level receipt pending semantics.
- Rate limits and idempotency.
- Landing page/listing copy and demo script.

### Deferred

- Private repositories.
- GitHub token upload or OAuth from ACP clients.
- Automatic PR comment posting for non-installed repos.
- Patch generation / fix PRs.
- Autonomous trading approval.
- Variable usage-based pricing.
- Receipt-backed repo scan.
- Subscriptions.
- Mandatory evaluator network.
- Public raw model transcript release.
- Non-GitHub forge support.

### Non-goals

- Replace ACP escrow/payment.
- Build a new review engine.
- Build a new receipt system.
- Expand the v0 adapter into a broad provider platform inside this repo without revisiting the `antfleet-core` extraction boundary.
- Submit Virtuals ACP demo artifacts directly from this repo.
- Promise correctness/security.
- Tokenize AntFleet before usefulness.

### Acceptance criteria

- ACP offering is discoverable with name, description, price, SLA, requirements schema, deliverable schema.
- Provider accepts a valid public PR job and rejects malformed/private/inaccessible targets.
- Funded PR job produces a valid deliverable in under 30 minutes.
- Deliverable validates against `review-deliverable-v0`.
- Failure payloads validate against `review-error-v0`, not `review-deliverable-v0`.
- No-finding result says "no consensus findings" and includes a review receipt URL or pending status.
- Findings result includes only unanimous findings from the existing agreement gate.
- Receipt-pending deliverables include `job.status_url`.
- Target SHA is pinned and visible in deliverable.
- ACP job is idempotent by `acp_job_id` and target tuple.
- ACP client wallet is derived from authenticated ACP context and stored non-null.
- Rate limit test covers wallet and repo cooldowns.
- Trading-agent request requires or emits the no-financial-advice disclaimer.
- Optional evaluator can verify schema and receipt URL without private data.
- Production ACP runtime changes are implemented in `AntFleet/antfleet` for v0,
  with `antfleet-core` documented as the future extraction target.
- Virtuals demo/submission artifacts are prepared in `Virtual-Protocol/acp-cli-demos` from `antfleet-ops`.

### Test plan

Unit tests:

- Request schema accepts valid PR requests and rejects malformed or repo-scan targets.
- PR SHA resolution rejects ambiguous/no-open-PR SHAs.
- Private/inaccessible repo maps to `private_repo_not_supported` or `repo_not_accessible`.
- Deliverable schema validates examples.
- Error schema validates all failure codes.
- ACP job idempotency returns existing job.
- Target idempotency still holds when the client wallet comes from ACP signer context.
- Rate limiter rejects 11th wallet job/hour.
- Trading focus requires disclaimer acknowledgment.
- Trading-code heuristic match without acknowledgment rejects before funding.

Integration tests:

- Mock ACP funded job -> mock AntFleet review -> deliver JSON.
- Public PR fixture with no findings -> `complete_no_findings`.
- Public PR fixture with mock consensus finding -> `complete`.
- Provider degradation -> `review-error-v0` with code `provider_degraded`; no findings posted and no success deliverable emitted.
- Receipt URL endpoint resolves for completed review.

Manual tests:

- Run provider in testnet ACP environment.
- Create job from buyer agent wallet.
- Observe budget/fund/deliver/evaluate phases.
- Reject a deliverable and confirm dispute artifact.
- Confirm no x402 payment is requested inside ACP flow.

### Manual demo script

1. Open AntFleet ACP provider listing in Virtuals marketplace.
2. Buyer agent creates job:

```json
{
  "mode": "pr",
  "target": {
    "repo": "antfleet/x402-fixture",
    "pr": 1
  },
  "options": {
    "public_receipt": true,
    "focus": ["security", "api-contract"],
    "max_findings": 10
  }
}
```

3. AntFleet accepts and sets `1.00 USDC` budget.
4. Buyer funds escrow.
5. AntFleet logs `queued -> running -> delivered`.
6. Show ACP deliverable JSON.
7. Open review receipt URL.
8. If fixture has a finding, show `receipt.state=finding_receipts_pending`.
9. If fixture has no finding, point out "no consensus findings" language.
10. Buyer accepts; ACP job completes.

## 7. Promotion Plan

### Virtuals Showcase packaging

Package AntFleet as "agent-to-agent trust infrastructure":

- 90-second demo video: buyer agent hires AntFleet, receives receipt-backed review, accepts job.
- Public receipt examples from real/fixture repos.
- Architecture diagram: ACP job -> AntFleet queue -> two frontier reviewers -> agreement gate -> receipt.
- Marketplace listing screenshot.
- JSON schemas for requirements and deliverables.
- Short post explaining why receipts matter more than model output.

### Proof artifacts

- Link to `https://www.antfleet.dev/receipts`.
- Link to `https://www.antfleet.dev/architecture`.
- Link to PR #82 in `AntFleet/antfleet`.
- Link to the future `AntFleet/antfleet-core` extraction PR only if/when that happens.
- Link to the `Virtual-Protocol/acp-cli-demos` submission/demo PR from `antfleet-ops`.
- Example ACP job ID on testnet/mainnet.
- Example deliverable JSON.
- Example review receipt URL.
- Example finding closure receipt URL if available.
- Test output from schema/idempotency/rate-limit tests.
- Public commit SHA of the ACP provider implementation in `AntFleet/antfleet`.

### Suggested landing-page copy

Headline:

> Receipt-backed code review for agent repos

Subhead:

> Hire AntFleet through ACP to review a public GitHub PR. Two independent frontier reviewers inspect the code; only findings they both agree on are returned; fixed findings become SHA-pinned public receipts.

Body bullets:

- Built for ACP handlers, workflow scripts, agent wallets, and trading-agent code.
- Consensus findings only: individual model output is not the product.
- Receipt-first: review URL at delivery, closure receipts after fixes land.
- Useful before tokenization: pay per job through ACP escrow.
- No financial advice, no trading approval, no "bug-free" claims.

CTA:

> Hire AntFleet in ACP

### Suggested ACP marketplace listing copy

**Title:** Receipt-backed code review for agent repos

**Short description:** Two-model consensus review for public GitHub PRs, with structured findings and SHA-pinned receipt URLs.

**Long description:**

> AntFleet reviews agent repositories the way agents need: machine-readable, escrow-friendly, and auditable. Submit a public GitHub PR. AntFleet runs two independent frontier model reviews, returns only findings both models agree on, and provides a review receipt URL. When findings are fixed, AntFleet pins closure receipts to the resolving SHA. Best for ACP handlers, agent wallets, workflow scripts, and trading-agent infrastructure. Not financial advice and not a guarantee that code is secure or bug-free.

**Tags:** code-review, security, receipts, github, acp, agent-trust, auditability

### Suggested X announcement thread

1. Agents are starting to hire agents. The missing layer is trust in the code they ship.
2. AntFleet is launching an ACP provider: receipt-backed code review for agent repos.
3. Submit a public GitHub PR. AntFleet runs two independent frontier reviews and returns only findings both models agree on.
4. The artifact is not a model transcript. The artifact is a receipt: target repo, PR/SHA, consensus finding, and eventually the SHA that fixed it.
5. Built for Virtuals agents shipping ACP handlers, workflow scripts, wallets, and trading-agent infrastructure.
6. It works before tokenization: fixed-price jobs, ACP escrow, typed requirements, structured deliverables, optional evaluator flow.
7. Important boundary: no financial advice, no autonomous trading approval, no "secure" stamp. Silence means no consensus finding, not no bugs.
8. Demo: buyer agent hires AntFleet -> AntFleet reviews -> deliverable JSON + receipt URL -> buyer/evaluator can verify.
9. Receipts compound. Every fixed finding becomes reusable proof for listings, changelogs, Showcase submissions, and agent reputation.
10. The agent economy needs audit trails other agents can read. This is one small, shippable piece.

## 8. Success Metrics

MVP activation:

- 5 ACP jobs completed in first week after listing.
- 3 unique buyer agents.
- 80% of valid jobs delivered within SLA.
- 0 jobs settle with malformed deliverables.

Quality:

- 0 raw provider-only findings exposed as consensus.
- <= 5% provider-degraded jobs on public PRs.
- >= 1 finding accepted/fixed into a public receipt within first month.

Economics:

- Average model cost below 50% of fixed price for PR review.
- No single PR review exceeds configured timeout or cost-cap policy.

Trust:

- At least one optional evaluator acceptance.
- No unresolved dispute older than 72 hours.
- No private repo/name leakage in public receipts.
- Public implementation and submission provenance are clear: `AntFleet/antfleet` for v0 provider code, `AntFleet/antfleet-core` as future extraction target, and `Virtual-Protocol/acp-cli-demos` for demo/submission.

## 9. Seven-Day Implementation Plan

### Day 1 - ACP provider skeleton

- Work in `AntFleet/antfleet` for the PR #82 v0 provider adapter.
- Create ACP provider runtime process using `@virtuals-protocol/acp-cli` or SDK v2.
- Register offering metadata, fixed prices, SLA, and schemas.
- Add environment contract for provider wallet, signer, and AntFleet API base URL.

### Day 2 - Job intake and validation

- Implement request parser and JSON schema validation.
- Derive client/provider wallet identity from ACP authenticated job context.
- Add public GitHub target resolution for PR.
- Add rejection paths for malformed/private/inaccessible targets.
- Add trading disclaimer gate, including the v0 metadata/path heuristics.

### Day 3 - Persistence and idempotency

- Add `acp_review_jobs` migration and query helpers.
- Store ACP job IDs, wallets, target tuple, status, result, and linked review ID.
- Enforce wallet/repo cooldown and target idempotency.
- Assert `acp_client_wallet` is non-null before inserting target-idempotency rows.

### Day 4 - Pipeline adapter

- Wire PR mode to existing `getPublicChangedFiles()` + `reviewPR()`.
- Build deliverable mapper from review result to `review-deliverable-v0`.
- Route failures and provider degradation to `review-error-v0`; do not emit degraded success deliverables.
- Generate review receipt URL or pending status.

### Day 5 - ACP delivery and evaluation

- Implement provider actions for accept, set budget, deliver, and dispute response.
- Add optional evaluator evidence response.
- Add status endpoint for AntFleet job lookup.

### Day 6 - Tests and hardening

- Unit-test schemas, validation, idempotency, rate limits, error mapping, disclaimer.
- Integration-test mock ACP job through completed deliverable.
- Verify no x402 payment branch is invoked in ACP flow.
- Verify public receipt URL behavior.

### Day 7 - Demo and launch assets

- Run manual demo on ACP testnet or staging.
- Record deliverable JSON and receipt URL.
- Prepare the upstream demo/submission in `Virtual-Protocol/acp-cli-demos` from the `antfleet-ops` account.
- Publish marketplace listing draft.
- Add landing-page section and X thread.
- Document known limitations: public repos only, no fix PRs, optional evaluator, no financial advice.

## 10. Source Notes

- Virtuals ACP docs describe provider/client/evaluator commerce phases and optional evaluation.
- `@virtuals-protocol/acp-cli` documents offerings with price, SLA, requirements, deliverable, escrowed job lifecycle, and EconomyOS primitives including wallet, email, card, compute, and marketplace access.
- x402 docs and the x402 Foundation repo describe HTTP 402 direct-payment flows; AntFleet should treat x402 as a direct API rail, while ACP remains the marketplace/escrow rail.
- AntFleet repo already implements the review and scan primitives this spec depends on; v0 should adapt them rather than inventing new review machinery.
- Virtuals ACP v0 production work for this offering belongs in `AntFleet/antfleet`; `AntFleet/antfleet-core` remains the future extraction target, and demo/submission artifacts belong in `Virtual-Protocol/acp-cli-demos`.
