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

> Phase 2 of the partnership ship. This section will be expanded with
> the `packages/aeon-skills/` install flow, env-var contract, and MCP
> tool naming once the skill pack lands. Until then the endpoint above
> is callable directly from any HTTP client that can sign EIP-191
> messages.
