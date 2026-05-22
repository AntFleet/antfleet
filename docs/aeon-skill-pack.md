# Aeon skill pack — AntFleet PR review

This doc covers the on-demand review surface that lets Aeon agents (and
any other install-bound caller) trigger a two-model-consensus review on
a specific PR or commit, mid-session.

- **Push-mode** (existing): AntFleet's GitHub App reviews automatically
  when a PR opens. No caller action; runs on every commit.
- **Pull-mode** (this doc): Aeon agent calls `POST /api/v1/installations/{id}/review`
  to trigger a review _right now_ against a named PR/SHA. Same channel,
  same price, same finding pipeline — purely an additional trigger.

There is no new payment surface. Both push and pull flows debit the
existing install-bound channel via the shared `debitForReview` helper
in `lib/paywall/gate.ts`; the only difference is the trigger.

---

## Caller pre-reqs

Before any API call works:

1. Install `antfleet[bot]` on the target repo: <https://github.com/apps/antfleet>
2. Create a wallet-bound installation row via `POST /api/v1/installations`
   (returns `installation_id` UUID, status `pending_binding`, and a
   binding challenge string).
3. Sign the binding challenge with the same wallet and POST it to
   `POST /api/v1/installations/{id}/bind` (transitions to `awaiting_deposit`).
4. Send USDC on Base to the configured deposit address; the deposit
   detector credits the channel (status flips to `active`).
5. Then the review endpoint becomes usable.

The `{id}` in every URL below is the **installation row UUID**, not the
GitHub installation ID integer. The dashboard surfaces both.

---

## Endpoint contract

### 1. Issue a challenge

`POST /api/v1/installations/{id}/review/challenge`

No body, no auth. Returns a single-use challenge that's good for 10
minutes.

**Response (200):**

```json
{
  "challenge_id": "11111111-1111-4111-8111-111111111111",
  "challenge": "AntFleet review: 11111111-1111-4111-8111-111111111111 22222222-2222-4222-8222-222222222222 0xabcd...abcd 2026-05-22T14:30:00.000Z",
  "installation_id": "22222222-2222-4222-8222-222222222222",
  "issued_at": "2026-05-22T14:30:00.000Z",
  "expires_at": "2026-05-22T14:40:00.000Z"
}
```

The `wallet_address` is intentionally **not** included as a top-level
response field. The legitimate caller already knows their wallet (they
are about to sign with it), and anonymous probes of installation UUIDs
should not be able to read the bound wallet from this surface. The
wallet still appears inside the `challenge` string (it must, to be
signable) — that's acceptable because forging a signature requires the
private key.

**Failure response (404):**

```json
{
  "error": {
    "code": "not_eligible",
    "message": "installation is not eligible for review challenges"
  }
}
```

This single code covers three internal states: the row does not exist,
the row has no wallet claimed, or the row's wallet was claimed but never
bound. Collapsed deliberately so an unauth caller cannot enumerate the
lifecycle stage of a target installation. Operators can disambiguate
via the `paywall.review_challenge.rejected` log entries.

**Why two calls instead of one?** The `/bind` challenge is stateless
because binding is one-shot per install. Review is repeating, so the
server mints a fresh `challenge_id` and marks it used on redemption —
that's the anti-replay surface. A snooped signature is invalid after
the first redemption.

### 2. Sign the challenge

Sign the `challenge` string with the bound wallet's private key using
**EIP-191 personal_sign** (the same scheme `/bind` uses). The recovered
address must equal the installation's `wallet_address`, lowercased.

```ts
import { privateKeyToAccount } from "viem/accounts";
const account = privateKeyToAccount(privateKey);
const signature = await account.signMessage({ message: challenge });
```

### 3. Submit the review trigger

`POST /api/v1/installations/{id}/review`

```json
{
  "challenge_id": "11111111-1111-4111-8111-111111111111",
  "signature": "0x...130 hex...",
  "pr_number": 42,
  "repo": "acme/demo"
}
```

**Body fields:**

- `challenge_id` (required) — UUID from step 1.
- `signature` (required) — EIP-191 sig over the challenge string.
- `pr_number` (optional) — open PR number on the install's repo.
- `sha` (optional) — head SHA of an open PR. Server resolves to the
  PR via `octokit.repos.listPullRequestsAssociatedWithCommit`; rejects
  if 0 or >1 open PRs match. Pass `pr_number` if you have it.
- `repo` (optional) — `owner/name`. Required only if the install row
  has no bound repo yet (no webhook has landed). Must match the
  install's repo when both are set.
- **Exactly one** of `pr_number` or `sha` is required.

**Success response (200):**

```json
{
  "cached": false,
  "receipt": {
    "review_id": "33333333-3333-4333-8333-333333333333",
    "repo": { "owner": "acme", "name": "demo" },
    "pr_number": 42,
    "sha": "deadbeef...",
    "finding_count": 2,
    "finding_ids": ["33333333-0", "33333333-1"],
    "public_receipt": true,
    "is_benchmark": false,
    "pr_comment_url": "https://github.com/acme/demo/pull/42#issuecomment-..."
  },
  "findings": [
    /* Finding[] — see types/review-output.ts */
  ],
  "finding": {
    /* the first finding, for callers that want one */
  },
  "evidence": [
    /* flat list of EvidenceRef with finding_title for context */
  ],
  "channel": {
    "debited_usdc": "0.500000",
    "remaining_usdc": "4.500000",
    "drawdown_id": "..."
  }
}
```

**Error responses (selected):**

| HTTP | `error.code`                                                       | Meaning                                                                                            |
| ---- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| 400  | `invalid_input`                                                    | Body schema failed (missing target, malformed sig/uuid, bad repo string)                           |
| 400  | `pr_not_open`                                                      | pr_number resolves to a closed/merged PR; only open PRs are reviewable                             |
| 400  | `sha_has_no_open_pr`                                               | sha given but no open PR has it as head                                                            |
| 400  | `sha_matches_multiple_prs`                                         | sha is the head of multiple open PRs; pass `pr_number`                                             |
| 401  | `unknown_challenge`                                                | `challenge_id` not found                                                                           |
| 401  | `challenge_install_mismatch`                                       | challenge was issued for a different install                                                       |
| 401  | `challenge_already_used`                                           | challenge was redeemed by a prior call                                                             |
| 401  | `expired_challenge`                                                | challenge older than 10 min                                                                        |
| 401  | `signature_mismatch`                                               | signature doesn't recover to bound wallet                                                          |
| 402  | `insufficient_channel_balance`                                     | balance < `REVIEW_PRICE_USDC`; response includes `required_usdc`, `current_usdc`, `wallet_address` |
| 404  | `not_found`                                                        | install row missing                                                                                |
| 404  | `pr_not_found`                                                     | pr_number doesn't exist in the repo                                                                |
| 409  | `missing_wallet` / `wallet_not_bound` / `github_app_not_installed` | install row not ready                                                                              |
| 409  | `install_repo_mismatch`                                            | install doesn't cover the requested repo                                                           |
| 501  | `force_not_yet_supported`                                          | `?force=true` is deferred to v2                                                                    |
| 502  | `github_auth_failed` / `github_lookup_failed` / `review_failed`    | upstream / pipeline error                                                                          |
| 503  | `review_in_progress`                                               | review hit a transient failure; cron will finish it                                                |

### Idempotency

Reviews are cached by `(installation_id, sha)`. A second call for the
same SHA returns the prior finding with `cached: true` and **does not
debit again**. The cache is permanent (not 24h); the SHA is the
identity. To re-run a review, push a new commit. `?force=true` would
opt out of the cache but is not yet implemented (returns 501); the
add-it-when-needed decision waits on real Aeon usage signal.

### Signature challenge format

```
AntFleet review: {challenge_id} {installation_row_id} {wallet_address_lowercase} {issued_at_iso}
```

This mirrors the bind challenge's `AntFleet binding: {id} {wallet} {iso}`
shape with two changes: the `AntFleet review:` prefix (namespace
isolation) and a leading `challenge_id` (the single-use token). Parser
lives at `lib/paywall/review-challenge.ts`.

---

## Aeon skill pack

Phase 2 of the partnership ship — the
[`packages/aeon-skills/`](../packages/aeon-skills/) directory is an
Aeon-compatible skill pack containing one skill, `pr-review-antfleet`,
that exercises the endpoint contract above.

### Layout

The pack ships at `packages/aeon-skills/` inside the AntFleet monorepo
during the partnership rollout, then extracts to a standalone
`AntFleet/aeon-skills` GitHub repo once the surface stabilizes. The
extraction is mechanical because the contents are self-contained.

```
packages/aeon-skills/
├── README.md                    cold-install human docs
├── package.json                 npm metadata + viem dep
├── .gitignore                   excludes node_modules, .outputs
├── client/
│   └── antfleet.mjs             shared client (mintChallenge, signChallenge,
│                                 submitReview, triggerReview) for non-Aeon callers
└── pr-review-antfleet/          ← only this folder gets copied by ./add-skill
    ├── SKILL.md                 natural-language instructions for the AI agent
    ├── package.json             declares viem dep for the skill's runtime
    └── run.mjs                  the three-call runner (self-contained)
```

The depth-1 skill folder is required: Aeon's `./add-skill` script uses
`find -maxdepth 2 -name SKILL.md` to discover installable skills inside
a repo tarball, so a nested `skills/<name>/SKILL.md` layout (which the
luca-aeon-skills reference uses) doesn't actually get discovered. We
match the working convention used by `BankrBot/skills` and Aeon's own
built-in skills.

### Install flow

From an Aeon project root:

```bash
./add-skill antfleet/aeon-skills pr-review-antfleet
cd skills/pr-review-antfleet
npm install                              # one-time, adds viem
```

`./add-skill`:

1. Downloads the repo tarball from
   `https://github.com/antfleet/aeon-skills/archive/refs/heads/main.tar.gz`.
2. Finds skills via `find … -maxdepth 2 -name SKILL.md`.
3. Runs a security scan on each skill's SKILL.md (waived for trusted
   sources listed in `skills/security/trusted-sources.txt`).
4. `cp -r`s the skill folder into `<aeon>/skills/<skill-name>/`.
5. Records provenance (source repo, commit SHA, imported_at) in
   `skills.lock`.
6. Adds a disabled entry to `aeon.yml`:
   `pr-review-antfleet: { enabled: false, schedule: "0 12 * * *" }`.

Note: `add-skill` only copies the per-skill folder. The pack's
top-level `client/`, `README.md`, and `package.json` are NOT bundled
into the Aeon project — that's why the skill's `run.mjs` is
intentionally self-contained (imports `viem` from its own
`node_modules`, makes its own HTTP calls). The top-level `client/`
module is a parallel surface for non-Aeon consumers who want to import
the helpers via npm.

### Env-var contract

Set as GitHub Actions secrets on the Aeon project (or in `aeon.yml`
`vars`):

| Name                          | Required | What                                         |
| ----------------------------- | -------- | -------------------------------------------- |
| `ANTFLEET_INSTALLATION_ID`    | yes      | UUID from the AntFleet dashboard             |
| `ANTFLEET_WALLET_PRIVATE_KEY` | yes      | 0x-prefixed 64 hex chars of the bound wallet |
| `ANTFLEET_API_BASE`           | no       | default `https://www.antfleet.dev`           |
| `ANTFLEET_OUTPUT_PATH`        | no       | default `.outputs/pr-review-antfleet.md`     |

**Security of `ANTFLEET_WALLET_PRIVATE_KEY`:** the key only authorizes
review-trigger signatures on this single installation. It cannot move
USDC out of the channel — only spend channel funds on reviews at the
`REVIEW_PRICE_USDC` rate (default $0.50/call). Blast radius if exposed
is bounded to the channel balance. Use a single-purpose wallet and
rotate cheaply (re-run the onboarding flow with a fresh wallet) if you
suspect compromise.

### Invocation contract

The SKILL.md takes a single `var` value:

- `PR=42` — review PR #42 on the install's bound repo
- `SHA=deadbeef1234` — review by head SHA (server resolves to PR via
  GitHub API; rejects 0/>1 matches)
- `PR=42;REPO=acme/demo` — disambiguate for multi-repo installs

In the Aeon `aeon.yml`:

```yaml
skills:
  pr-review-antfleet:
    enabled: true
    var: "PR=42"
    schedule: "0 12 * * *" # or omit for ad-hoc only
```

Direct invocation (skipping Aeon's runtime, useful for testing):

```bash
cd skills/pr-review-antfleet
ANTFLEET_INSTALLATION_ID=<uuid> \
ANTFLEET_WALLET_PRIVATE_KEY=0x... \
node run.mjs --pr 42
```

Exit codes: `0` = success, `2` = 4xx from API (e.g. insufficient
balance, closed PR, signature mismatch — error report written to the
output path), `3` = unexpected error (network, signing).

### Three-call protocol

The runner executes:

```
[1] POST {ANTFLEET_API_BASE}/api/v1/installations/{id}/review/challenge
    ← { challenge_id, challenge, expires_at }
[2] sign(challenge) with ANTFLEET_WALLET_PRIVATE_KEY via EIP-191
    ← signature
[3] POST {ANTFLEET_API_BASE}/api/v1/installations/{id}/review
    body: { challenge_id, signature, pr_number?, sha?, repo? }
    ← { findings, receipt, channel }
```

Then writes a structured Markdown report to
`${ANTFLEET_OUTPUT_PATH:-.outputs/pr-review-antfleet.md}` containing:
target repo/PR/SHA, finding count, channel debit, receipt URL, and
each finding's severity/evidence/reasoning/recommendation. On 4xx, an
error report is written instead with a contextual hint for the most
common codes (`insufficient_channel_balance`, `signature_mismatch`,
`pr_not_open`, etc.).

### MCP surface

When the operator runs `./add-mcp` in their Aeon project (after this
skill is installed), it registers an MCP server with Claude Code /
Claude Desktop. Every Aeon skill appears as an `aeon-<skill-name>`
tool, so this skill exposes the MCP tool name
**`aeon-pr-review-antfleet`** in the Claude tool surface. That's the
user-facing path most Aeon users will hit — calling the skill
conversationally from within Claude rather than scheduling it via
`aeon.yml`.

### Phase 2 verification status

| Check                                                | Status                                                                                                                |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `add-skill --maxdepth 2` discovery                   | ✅ verified: `find packages/aeon-skills -maxdepth 2 -name SKILL.md` returns `pr-review-antfleet/SKILL.md`             |
| Skill folder self-contained (no shared imports)      | ✅ verified: `run.mjs` only imports `viem` (declared in same folder's `package.json`)                                 |
| `npm install` works in installed location            | ✅ verified end-to-end inside `/tmp/aeon-scratch/aeon/skills/pr-review-antfleet/`                                     |
| CLI parses args, exits cleanly on missing target/env | ✅ verified: exit code 1 with clear stderr                                                                            |
| Live network call against prod endpoint              | ✅ verified: bogus UUID returns `404 not_eligible`, error report written, exit code 2                                 |
| MCP tool name maps to `aeon-pr-review-antfleet`      | ✅ verified via `./add-mcp` convention in aeon source                                                                 |
| Real funded-install end-to-end                       | ❌ requires test wallet + funded channel — see [follow-up note](../.omc/plans/note-followup-user-as-agent-testing.md) |
| MCP server invocation via Claude Code / Desktop      | ❌ requires the user to run `./add-mcp` + a real install — same blocker as above                                      |

The two ❌ items are gated on a real funded install. Until they're
done, the skill is shippable as a code artifact but not declared
production-grade for the Aeon partnership announcement.
