# SPEC-001 OQ unblock runbook — pre-mainnet final gates

State: 2026-05-30 (after PR #270 ping)

## Status overview

| Gate | State | Owner | Next action |
|---|---|---|---|
| aaronjmars/aeon PR #270 merge | Ping sent, waiting on Aaron | Aaron | Merge when convenient |
| antfleet/aeon-skills PR #1 merge | ✅ MERGED (`b27469a`) | — | — |
| OQ-1 AEON_GATE_SECRETS generated | ✅ DONE | — | — |
| OQ-1 secret distributed to Aaron | ⏳ Pending operator action | You | See OQ-1 below |
| OQ-5 CDP API keys obtained | ⏳ Pending operator action | You | See OQ-5 below |
| Mainnet deterministic env vars | ✅ DONE (6 vars set in Vercel production) | — | — |
| AC-1a Sepolia automated smoke | ✅ Wired in CI (`verify` mode) | — | Runs every push |
| AC-1 mainnet smoke | ⏳ Blocked on OQ-1 + OQ-5 + #270 | You | See AC-1 below |

## OQ-1 — AEON_GATE_SECRETS distribution

### What's done

A fresh HMAC secret has been generated and stored in production Vercel:

- **kid:** `aeon-prod-202605-01`
- **secret:** 64 hex chars (32 bytes); see `/tmp/aeon-gate-secrets.json`
- **format:** `[{"kid":"<kid>","secret":"<64-hex>"}]` JSON-encoded
- **Vercel env var:** `AEON_GATE_SECRETS` (Production)
- **Rotation:** 24h overlapping per FR-C2; aeon-prod-202605-02 will be added (alongside -01) when first rotation occurs, then -01 retired 24h later

### What's left

The same secret must be distributed to the aeon runtime so aeon agents can mint `X-Aeon-Context` tokens.

#### Distribution checklist

1. **Read the secret:**
   ```bash
   cat /tmp/aeon-gate-secrets.json
   ```

2. **Send to Aaron via secure channel.** Recommend Telegram (the existing partnership channel) or Signal — NOT email, NOT a public GitHub comment. The secret is:
   - 32 bytes of entropy — sufficient against brute force
   - Has limited blast radius: leak only enables rate-limited unsigned x402 calls against AntFleet (which are also wallet-funded by the attacker)
   - Rotatable in 24h overlap window if compromised

3. **Suggested Telegram message:**

   ```
   x402 gate secret for the aeon runtime (production):

   kid: aeon-prod-202605-01
   secret: <paste from /tmp/aeon-gate-secrets.json>

   token format per SPEC-001 v0.6 FR-C2:
     <kid>:<aeon_session_id>:<unix_timestamp>:<hex_hmac>

   where hex_hmac = HMAC-SHA256(secret, "<kid>:<session_id>:<timestamp>")

   validity: 5 min from timestamp; 30s clock-skew tolerance on future
   rotation: i'll add a second (kid, secret) ~quarterly; old kid stays valid 24h after new one comes online

   reference impl: lib/x402/aeon-gate.ts mintAeonContextToken() in antfleet/antfleet
   ```

4. **After Aaron confirms receipt + integration:** mark OQ-1 RESOLVED in the spec changelog (or follow-up PR if you prefer trackable artifact).

5. **Optional:** also send the smoke-test command Aaron can run from within his runtime to verify HMAC matches:
   ```bash
   node -e '
     const { createHmac } = require("crypto");
     const kid = "aeon-prod-202605-01";
     const secret = process.env.AEON_GATE_SECRET;
     const sessionId = "smoke-test-1";
     const timestamp = Math.floor(Date.now() / 1000);
     const signed = `${kid}:${sessionId}:${timestamp}`;
     const hmac = createHmac("sha256", secret).update(signed).digest("hex");
     console.log(`${signed}:${hmac}`);
   '
   ```
   Then call any AntFleet x402 endpoint with that as `X-Aeon-Context`.

## OQ-5 — CDP API keys

### Why required

`apps/web/lib/x402/env.ts:77-82` enforces:
> CDP_API_KEY_ID and CDP_API_KEY_SECRET are required for Base mainnet x402

Without them the mainnet x402 facilitator (`api.cdp.coinbase.com/platform/v2/x402`) returns 401 on `/verify` and `/settle`. The route handler throws at config load → all x402 requests 5xx.

### CDP signup runbook

**Total time:** ~5 min (browser action required)

1. **Visit https://portal.cdp.coinbase.com/**
   - Sign in with the Coinbase account that owns the AntFleet treasury wallet (or create a fresh CDP account if not yet)

2. **Create a new API key for x402:**
   - Navigate to: "Access" or "API Keys"
   - Click "Create new key"
   - Name: `antfleet-x402-mainnet-prod`
   - Permissions/scope: x402 (look for the x402 scope; if not listed, the legacy "platform" scope works)
   - Copy the resulting:
     - `keyId` (a UUID-shaped string)
     - `apiKeySecret` (typically a long base64-encoded private key — DO NOT close the dialog before saving; CDP only shows this once)

3. **Push to Vercel production:**
   ```bash
   gh auth switch -u antfleet-ops  # if not already
   echo -n '<keyId>' | vercel env add CDP_API_KEY_ID production
   echo -n '<apiKeySecret>' | vercel env add CDP_API_KEY_SECRET production
   vercel env ls production | grep CDP   # verify
   ```

4. **Trigger a fresh production deploy** so the new env vars are loaded:
   ```bash
   # If you push to main, Vercel deploys automatically. Or:
   vercel --prod
   ```

5. **Verify with mainnet-dry smoke (no spending):**
   ```bash
   # In a local checkout with the same env:
   vercel env pull .env.production.local
   pnpm --dir apps/web exec tsx scripts/x402-live-smoke.ts --mode mainnet-dry
   ```
   Expected: facilitator reachable + supported endpoint validation passes.

## AC-1 mainnet smoke (blocked on OQ-1 + OQ-5 + PR #270)

Once all three above resolve:

```bash
# Funded mainnet wallet (small balance ~$5 USDC + ~$0.20 ETH for gas)
export X402_SMOKE_PRIVATE_KEY=<0x-prefixed-64-hex>

# Aaron-confirmed gate secret
export AEON_GATE_SECRET=<the secret you sent Aaron>

# Spec target: a real public PR on a public repo
pnpm --dir apps/web exec tsx scripts/x402-live-smoke.ts \
  --mode settle \
  --allow-mainnet-settle \
  --repo antfleet/x402-fixture \
  --pr 1 \
  --amount-usdc 0.5
```

Expected:
- Signs EIP-3009 authorization with `validAfter=now`, `validBefore=now+600s`
- CDP facilitator `/verify` returns isValid: true
- (Worker would run review then `/settle` for end-to-end; or `--mode worker-e2e` for that)
- $0.50 USDC moves from smoke wallet to ANTFLEET_X402_TREASURY on Base mainnet
- Verifiable on basescan.org

After AC-1 mainnet smoke green → partnership is LIVE. Any aeon agent
with a funded wallet + the gate token can call
`/api/v1/review/x402` on antfleet.dev to review any public PR.

## Co-announcement timing

Per the earlier Telegram exchange, Aaron offered to co-announce when both PRs merge. Recommended flow:

1. Aaron merges aaronjmars/aeon #270
2. AC-1 mainnet smoke runs green
3. Coordinate launch tweet/post timing with Aaron (his channels + AntFleet's)
4. Both post within a small window

Draft launch copy can use the antfeed-voice skill for AntFleet's announcement.
