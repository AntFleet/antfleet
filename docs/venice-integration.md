# Venice Integration

Research notes for AntFleet's Venice integration. Section ordering follows the
workstream-A plan: §A.1 (autono interface), §A.2 (Venice docs), §A.3 (on-chain
reverse-engineering of the Autonomopoly reference deployment).

§A.1 and §A.2 are not yet authored at the time of this writing. §A.3 below is
self-contained and references §A.1 / §A.2 by name where a cross-check is owed.

---

## §A.1 — autono deployment interface (TBD)

_Not yet written. Will document the autono CLI / SDK surface used to launch
agent wallets like Autonomopoly. §A.3 owes this section a contradiction check
once it lands._

## §A.2 — Venice protocol docs (TBD)

_Not yet written. Will document the Venice staking / DIEM tokenomics from
official sources. §A.3 owes this section a contradiction check once it lands._

---

## §A.3 — Autonomopoly on-chain reverse-engineering

**Subject wallet:** [`0x8767Df39eCeeaeB11554642237aC4E08660aB6A3`](https://basescan.org/address/0x8767Df39eCeeaeB11554642237aC4E08660aB6A3)
**Chain:** Base mainnet (chainId 8453)
**Data window:** wallet's first observable activity 2026-05-14 → snapshot taken
2026-05-17 at Base block ≈ 46,102,839.
**Snapshot scope:** 20 transactions touch the wallet (18 outgoing, 2 incoming
ETH funding). Account nonce reads 19 via raw `eth_getTransactionCount`, so one
outgoing tx may not yet be reflected in Blockscout's indexer at snapshot time —
called out where it might matter.
**Indexer:** [Blockscout for Base](https://base.blockscout.com) was used for tx
list, decoded calldata, and decoded event logs. Basescan links below are
canonical for human readability; the underlying decoding was cross-checked
against verified-source ABIs returned by Blockscout's API.

### Top-line contradictions with the upstream brief

Two things the upstream prompt asserted do **not** match what's on-chain. Both
are flagged here at the top rather than buried in the relevant subsection
because they affect the framing of the whole document.

1. **DIEM token address.** The brief lists DIEM as
   `0xB3D7e0c3C39A1D3F1B304663065A2F83Ddf56d8e`. The Autonomopoly wallet has
   never called that contract. The token it actually approves, stakes, claims,
   and LPs is
   [`0xF4d97F2da56e8c3098f3a8D538DB630A2606a024`](https://basescan.org/address/0xF4d97F2da56e8c3098f3a8D538DB630A2606a024),
   verified on Basescan with `name() == "Diem"` and `symbol() == "DIEM"`. The
   address `0xB3D7e0c3…` does have bytecode deployed on Base (≈ 12.9 KB), so
   it isn't a typo of an EOA — but it's a different contract, unverified, with
   zero holders, and irrelevant to the Autonomopoly flow. Treat
   `0xF4d97F2d…` as the canonical DIEM until §A.1 / §A.2 disagree on the
   record.

2. **"Stake DIEM on Venice."** The brief asks for the call signature
   Autonomopoly uses to stake DIEM on Venice. The on-chain reality is that
   Venice — contract
   [`0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf`](https://basescan.org/address/0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf),
   verified, `symbol() == "VVV"` — **is itself a token**, not a staking venue
   for DIEM. The wallet stakes **VVV** (the Venice token) on a separate
   `StakingV2` contract behind an ERC-1967 proxy. DIEM is first swapped to VVV
   through the 0x Protocol AllowanceHolder. So there are two distinct stake
   flows on-chain:
   - `Diem.stake(uint256)` — staking DIEM into DIEM's own built-in staking
     module (i.e. into the DIEM token contract itself).
   - `StakingV2.stake(address,uint256)` (via the ERC-1967 proxy) — staking
     **VVV**, sourced by swapping DIEM → VVV on the way in.

   §A.1 should clarify which of these autono's `stake` subcommand wraps. §A.3
   answers both since both are observed.

---

### Deliverable 1 — Contract inventory

Every distinct `to` address the wallet has called between deploy
(2026-05-14T10:13Z) and snapshot (2026-05-17). All eight are verified on
Basescan with one exception (the implementation behind the proxy is verified
separately).

| #   | Address                                      | Basescan name              | Purpose                                                                                                                                                                                                                                                     | Verified    | Basescan                                                                        |
| --- | -------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------- |
| 1   | `0xF4d97F2da56e8c3098f3a8D538DB630A2606a024` | Diem                       | DIEM ERC-20 with built-in staking (`stake`/`unstake`/`totalStaked`) and an LP-fee hook routed through the LiquidFeeLocker. Solidity 0.8.26.                                                                                                                 | yes         | [link](https://basescan.org/address/0xF4d97F2da56e8c3098f3a8D538DB630A2606a024) |
| 2   | `0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf` | Venice                     | VVV ERC-20, the Venice protocol's reward / governance token. Solidity 0.8.26.                                                                                                                                                                               | yes         | [link](https://basescan.org/address/0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf) |
| 3   | `0x321b7ff75154472B18EDb199033fF4D116F340Ff` | ERC1967Proxy               | Upgradeable proxy for the Venice staking module. Delegates to (4).                                                                                                                                                                                          | yes (proxy) | [link](https://basescan.org/address/0x321b7ff75154472B18EDb199033fF4D116F340Ff) |
| 4   | `0xe37A7920dbc11253ac6d031C29f592f71B348DCA` | StakingV2                  | Implementation behind (3). Exposes `stake(address,uint256)` and `claim()`. Solidity 0.8.26.                                                                                                                                                                 | yes         | [link](https://basescan.org/address/0xe37A7920dbc11253ac6d031C29f592f71B348DCA) |
| 5   | `0xF7d3BE3FC0de76fA5550C29A8F6fa53667B876FF` | LiquidFeeLocker            | Custodies LP fees accrued by DIEM-paired Uniswap V3 positions. Exposes `claim(address feeOwner, address token)` and the view `feesToClaim(address,address)`. Solidity 0.8.28.                                                                               | yes         | [link](https://basescan.org/address/0xF7d3BE3FC0de76fA5550C29A8F6fa53667B876FF) |
| 6   | `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1` | NonfungiblePositionManager | Uniswap V3 position-NFT manager (standard deployment). Called for `mint`.                                                                                                                                                                                   | yes         | [link](https://basescan.org/address/0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1) |
| 7   | `0x80d995189ecc593672aD4703b250a5e82672EB1D` | UniswapV3Pool              | The WETH/DIEM 1% pool. Not called directly by the wallet — touched indirectly during `mint` (Deliverable 4) and visible in the pool's `Mint` event. `token0()` returns WETH `0x4200…0006`, `token1()` returns DIEM, `fee()` returns `0x2710` (=10000 = 1%). | yes         | [link](https://basescan.org/address/0x80d995189ecc593672aD4703b250a5e82672EB1D) |
| 8   | `0x0000000000001fF3684f28c67538d4D072C22734` | AllowanceHolder            | 0x Protocol's AllowanceHolder (Settler v2 pull-side). Called for `exec` swaps that route DIEM → VVV through the V3 pool at `0x01271A20…`.                                                                                                                   | yes         | [link](https://basescan.org/address/0x0000000000001fF3684f28c67538d4D072C22734) |

No unverified contracts were called by the wallet — Deliverable 1 contains no
"skip" rows.

### Deliverable 2 — Venice staking call signature

There are two separate stake flows, as called out in the contradictions block.

**Flow A — Stake DIEM into DIEM's own staking module.**

- Selector: `0xa694fc3a`
- Decoded: `stake(uint256 amount)` on
  [`0xF4d97F2da56e8c3098f3a8D538DB630A2606a024`](https://basescan.org/address/0xF4d97F2da56e8c3098f3a8D538DB630A2606a024) (Diem)
- Sample tx: [`0xbf349652…2010`](https://basescan.org/tx/0xbf349652732f2c99faf1cf02110ea22a9e0222ad8f42616963d1f9b128742010)
  (block 45,982,548, 2026-05-14T10:27:23Z)
- Decoded calldata: `stake(234454936558688537)` — i.e. stake ≈ 0.2345 DIEM.
- Emits `Diem.Staked(address indexed user, uint256 amount)` + a `Transfer`
  (DIEM moves from wallet into the Diem contract itself, since the token
  contract holds the staked balance).
- Gas used: 63,316.

**Flow B — Stake VVV (Venice) on Venice's `StakingV2`.**

- Selector: `0xadc9772e`
- Decoded: `stake(address recipient, uint256 amount)` on the ERC-1967 proxy
  [`0x321b7ff75154472B18EDb199033fF4D116F340Ff`](https://basescan.org/address/0x321b7ff75154472B18EDb199033fF4D116F340Ff),
  which delegates to `StakingV2` at
  [`0xe37A7920dbc11253ac6d031C29f592f71B348DCA`](https://basescan.org/address/0xe37A7920dbc11253ac6d031C29f592f71B348DCA).
- Sample tx: [`0xa4bd4234…98cb5`](https://basescan.org/tx/0xa4bd423447a86c6159c4c64e9201d9c2144dec9fbbc9f8880606ebf61da98cb5)
  (block 45,985,058, 2026-05-14T11:51:03Z)
- Decoded calldata:
  `stake(recipient=0x8767Df39…, amount=4539650852268660298)` — i.e. credit
  ≈ 4.5397 **VVV** to the wallet's staking balance.
- Emits `StakingV2.Staked(address indexed user, uint256 amount)` plus three
  `Venice.Transfer` legs (mint or pull of VVV during the deposit) and one
  proxy-side `Transfer` (the proxy mints a receipt token to the staker).
- Gas used: 144,373.

The token being staked here is **VVV**, not DIEM. To convert DIEM into VVV the
wallet had previously (block 45,984,926, ~5 min before this stake) called the
0x Protocol AllowanceHolder:

- [`0x70cfa064…cdb57`](https://basescan.org/tx/0x70cfa064f0bfb76e53e84862880843d2ae6e42385ff2bd99595d40614f8cdb57)
- `AllowanceHolder.exec(operator=0x7747F8D2…, sellToken=DIEM, sellAmount=0.05 DIEM, target=0x7747F8D2…, data=…)`
- Net effect: 0.05 DIEM out, 4.5397 VVV in (after a 0.0068 VVV protocol fee
  paid to `0xaD01C20d…`). Roughly DIEM ≈ 90 VVV at that block.
- Gas used: 283,718.

The "stake DIEM on Venice" phrasing in the brief therefore best maps to **Flow
B with the swap prepended** (`exec` → `approve(VVV → StakingV2)` → `stake`).
§A.1 should make clear whether autono's `stake` subcommand wraps just `stake`
or the full three-call sequence. If §A.1 documents a single-call "stake DIEM"
primitive on Venice that does the swap internally, that's a contradiction with
this evidence — Autonomopoly performs the swap and stake as separate txs.

### Deliverable 3 — DIEM claim call

The "claim fees when balance > 0.1 DIEM" loop maps to `LiquidFeeLocker.claim`.

- Selector: `0x21c0b342`
- Decoded: `claim(address feeOwner, address token)` on
  [`0xF7d3BE3FC0de76fA5550C29A8F6fa53667B876FF`](https://basescan.org/address/0xF7d3BE3FC0de76fA5550C29A8F6fa53667B876FF) (LiquidFeeLocker)
- Sample tx: [`0xacc3ba72…6a25a`](https://basescan.org/tx/0xacc3ba72e2db87e026c74d5808b0660881c93483195c5410c8014ea464e6a25a)
  (block 45,989,876, 2026-05-14T14:31:39Z)
- Decoded calldata: `claim(feeOwner=0x8767Df39… (wallet), token=DIEM)`.
- Emits `LiquidFeeLocker.ClaimTokens(address indexed feeOwner, address indexed token, uint256 amountClaimed)`
  plus a `Diem.Transfer` of the claimed amount (1.9837 DIEM in this sample)
  from the locker to the wallet.
- Gas used: 59,714 (a "no-op-ish" prior claim at block 45,985,066 used 42,614,
  so cost scales with whether anything is actually disbursed).

**Pool / position the fees originate from.** LiquidFeeLocker is the custodian
for fees accrued by the wallet's Uniswap V3 LP NFT (tokenId 5,119,885 in the
WETH/DIEM 1% pool — see Deliverable 4). The Diem token contract appears to
hook V3's `collect()` flow and route fees through the LiquidFeeLocker rather
than handing them straight to the NFT owner — this is why the wallet does not
call `NonfungiblePositionManager.collect` directly.

**Threshold (> 0.1 DIEM).** This is **off-chain**, not enforced by the
contract. Evidence:

- The `claim(address,address)` ABI has no threshold parameter.
- LiquidFeeLocker exposes a view helper
  [`feesToClaim(address feeOwner, address token) returns (uint256)`](https://basescan.org/address/0xF7d3BE3FC0de76fA5550C29A8F6fa53667B876FF#readContract)
  which Autonomopoly almost certainly polls and gates against off-chain before
  spending gas on a claim.
- Observed claim amounts in the snapshot window (1.98 DIEM, 9.74 DIEM, etc.)
  are all comfortably above 0.1 — consistent with an off-chain gate, but the
  contract would happily process a claim of 0.001 DIEM if called.

There is a second "claim" surface — `StakingV2.claim()` (no args, selector
`0x4e71d92d`) on the proxy at `0x321b7ff7…` — which presumably pays out
**staking** rewards (as opposed to LP fees). The wallet has **not** called it
in the snapshot window. If the missing tx (nonce gap, see Deliverable 6) turns
out to be a `StakingV2.claim()`, the picture is consistent; otherwise it's a
flow Autonomopoly hasn't exercised yet. AntFleet's `claim` subcommand should
expect both surfaces and decide which one it's mirroring.

### Deliverable 4 — Uniswap V3 LP deployment

- Selector: `0x88316456`
- Decoded:
  `mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline))`
  on the standard
  [Uniswap V3 NonfungiblePositionManager `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1`](https://basescan.org/address/0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1).
- Sample tx: [`0x1db44f41…b7`](https://basescan.org/tx/0x1db44f41347e86d4b55228d249e41bd26894429027d4fb6ca19c171e789646b7)
  (block 45,990,006, 2026-05-14T14:35:59Z) — the only `mint` observed in the
  window, so this is also _the_ LP-deployment call.

**Decoded params (verbatim):**

| Field            | Value                                        | Interpretation                                            |
| ---------------- | -------------------------------------------- | --------------------------------------------------------- |
| `token0`         | `0x4200000000000000000000000000000000000006` | WETH on Base                                              |
| `token1`         | `0xF4d97F2da56e8c3098f3a8D538DB630A2606a024` | DIEM                                                      |
| `fee`            | `10000`                                      | **1% fee tier** — matches the source-tweet claim          |
| `tickLower`      | `5000`                                       |                                                           |
| `tickUpper`      | `5400`                                       | 400-tick band, ≈ 4.08 % price width                       |
| `amount0Desired` | `0`                                          | **No WETH** — single-sided position                       |
| `amount1Desired` | `1983691479721410419`                        | ≈ 1.9837 DIEM                                             |
| `amount0Min`     | `0`                                          |                                                           |
| `amount1Min`     | `1963854564924196314`                        | ≈ 1.9639 DIEM (~1% slippage floor)                        |
| `recipient`      | `0x8767Df39…aB6A3`                           | wallet keeps the position NFT                             |
| `deadline`       | `1778769957`                                 | Unix; ≈ 2026-05-14T14:45:57Z, i.e. 10 min from submission |

The `Mint` event on the WETH/DIEM 1% pool
([`0x80d995189ecc593672aD4703b250a5e82672EB1D`](https://basescan.org/address/0x80d995189ecc593672aD4703b250a5e82672EB1D))
confirms `tickLower=5000`, `tickUpper=5400`, `liquidity=7.648e19`,
`amount0=0`, `amount1=1.984e18`. The `IncreaseLiquidity` event on the position
manager assigns position **NFT tokenId 5,119,885** to the wallet.

**Reading the params:**

- **Single-sided DIEM.** Pure DIEM, zero WETH. In a V3 pool with `token0=WETH`,
  `token1=DIEM`, a single-sided token1 position requires that the pool's
  current tick is _below_ the range `[5000, 5400]` at mint — and then the
  position earns DIEM as price moves up into and through the range.
- **Tick range is narrow.** 400 ticks ≈ a ~4% price band. That maximizes fee
  yield relative to capital, at the cost of going out-of-range frequently.
  Consistent with the "highest-yield DIEM pool" framing — they're chasing
  concentrated-liquidity APR, not LP'ing wide.
- **No follow-up `increaseLiquidity` was observed in-window.** The LP was set
  up once and left alone; the active loop is claim-and-stake (Deliverables 2
  - 3), not LP rebalancing.

Gas used: 475,393 — the single most expensive op in the window.

### Deliverable 5 — Logging mechanism

There is **no Autonomopoly-owned logger contract**, no custom event, and no
ERC-1967 storage slot that the wallet writes self-state into. The wallet is a
plain EOA (`is_contract == false` on Blockscout, code length zero on RPC).

What plays the role of the "on-chain history of every move" is the union of:

1. The wallet's outgoing transaction list itself (each tx is one "move").
2. The standard events emitted by each downstream protocol contract:
   - `Diem.Staked(user, amount)` — on Diem-staking moves.
   - `StakingV2.Staked(user, amount)` — emitted at the proxy address — on
     Venice staking moves.
   - `LiquidFeeLocker.ClaimTokens(feeOwner, token, amountClaimed)` — on each
     fee claim.
   - `UniswapV3Pool.Mint(sender, owner, tickLower, tickUpper, amount, amount0, amount1)`
     on the WETH/DIEM 1% pool — on each LP deposit.
   - `NonfungiblePositionManager.IncreaseLiquidity(tokenId, liquidity, amount0, amount1)`
     on each LP deposit.
   - ERC-20 `Transfer` legs filling in the value flow.

The narrative ("Autonomopoly logs every move in its own on-chain history")
appears to be a slight overstatement — what's really happening is that every
move is _observable_ on-chain because it's a public tx, and the verified
contracts it calls emit reasonably descriptive events. The wallet itself adds
nothing.

**Implication for AntFleet's SHA-pinned receipts.** This pattern is "implicit
logging by chosen counterparties" — clean when those counterparties are
verified and emit useful events, fragile when AntFleet's receipt shape needs
to span multiple protocols and survive their schema changes. A small
AntFleet-owned `ReceiptAnchor` contract that emits one normalized event per
agent action (e.g. `ReceiptAnchor(bytes32 indexed sha, bytes32 indexed actionTag, bytes context)`)
would give downstream consumers a single event signature to watch, rather
than forcing them to multiplex over Diem / StakingV2 / LiquidFeeLocker /
NonfungiblePositionManager / pool events. Worth the extra ~30k gas per action
given the runway math below.

### Deliverable 6 — Frequency + gas profile

**Activity timeline (snapshot 2026-05-17).** All 18 outgoing transactions
visible at snapshot occurred on the deploy day, **2026-05-14**, within a
~4 h 23 m window from 10:13:33Z to 14:35:59Z. No outgoing activity has been
observed in the ~3 days since. Two incoming ETH funding transfers (0.001 ETH
on deploy day; 0.007 ETH on 2026-05-16) keep gas topped up.

The wallet's `eth_getTransactionCount` reads **19** at snapshot, so one
outgoing tx is unaccounted-for in Blockscout's tx list — either an indexer lag
or a tx pruned from the default response window. Doesn't affect the per-action
gas numbers below; does affect the cadence story (a single missing claim/stake
between 2026-05-14 and 2026-05-17 would change the picture from "burst then
idle" to "burst then weekly tickover").

**Cost per action (gas × price, observed):**

| Action                                 |      Sample gas | Gas price (gwei) |         Cost (ETH) |    Cost @ $2,190/ETH |
| -------------------------------------- | --------------: | ---------------: | -----------------: | -------------------: |
| `Diem.stake`                           |          63,316 |            0.006 |            3.80e-7 |             $0.00083 |
| `StakingV2.stake` (via proxy)          |         144,373 |            0.006 |            8.66e-7 |             $0.00190 |
| `LiquidFeeLocker.claim` (paying)       |          59,714 |            0.006 |            3.58e-7 |             $0.00078 |
| `LiquidFeeLocker.claim` (empty)        |          42,614 |            0.006 |            2.56e-7 |             $0.00056 |
| `AllowanceHolder.exec` (DIEM→VVV swap) | 283,718–388,336 |            0.006 | 1.70e-6 to 2.33e-6 | $0.00373 to $0.00510 |
| `NonfungiblePositionManager.mint`      |         475,393 |            0.006 |            2.85e-6 |             $0.00625 |
| `Diem.approve`                         |   26,003–46,231 |            0.006 | 1.56e-7 to 2.77e-7 | $0.00034 to $0.00061 |

ETH price taken from Blockscout's `exchange_rate` field at snapshot
(`$2,190.21`). Base gas prices during the observation window were a flat ~6
mgwei (`gas_price = 6_000_000` wei) for every outgoing tx — Base baseline
during a non-congested window, the wallet is not bidding above floor.

**Totals across the visible 18 outgoing txs:**

- Gas spent: **0.0000113 ETH ≈ $0.0248**.
- Avg per outgoing tx: **6.3e-7 ETH ≈ $0.00138**.

**Runway implications (for workstream D's policy):**

- A full "claim → swap → stake → maybe LP" cycle = roughly
  `claim` + `approve` + `exec` + `approve` + `stake` ≈
  60k + 26k + 284k + 26k + 144k = ~540k gas ≈ $0.0071 per cycle at
  current Base gas + ETH price.
- An LP redeploy adds the `mint` (~475k gas, $0.0063) on top.
- 0.001 ETH (~$2.19) covers ~350 full cycles or ~700 plain claim/stake pairs
  at observed prices.
- The wallet's current ETH balance (0x1c61480263ca9a wei ≈ 0.00798 ETH ≈
  $17.5) is ~2,500 plain stake/claim ops of runway, or ~2,400 full cycles —
  i.e. years at the observed cadence even if it speeds up 100×.

The gas budget for an AntFleet equivalent on Base is effectively a rounding
error on the LP-fee yield. Sizing decisions in workstream D's policy should
be driven by slippage, MEV exposure on the `exec` swap leg, and Uniswap V3
out-of-range risk — not by gas.

---

### Snapshot metadata

- Source-of-truth indexer: Blockscout for Base (`https://base.blockscout.com`).
- Spot-checked against raw RPC at `https://mainnet.base.org`
  (`eth_getCode`, `eth_getTransactionCount`, `eth_call` for pool
  `token0/token1/fee`).
- All decoded calldata and event params shown were returned by Blockscout's
  decoder using each contract's verified ABI; none of it relies on speculative
  bytecode interpretation.
- Snapshot taken: 2026-05-17, Base block ≈ 46,102,839.
- One outgoing tx (nonce 18 or earlier) was not in Blockscout's tx-list
  response at snapshot time; re-pull after indexer settles if cadence matters.

### Cross-reference obligations

When §A.1 (autono interface) and §A.2 (Venice docs) land, the following
points in §A.3 specifically need to be reconciled:

- §A.1 should clarify whether autono's `stake` primitive wraps Flow A
  (`Diem.stake`), Flow B (`StakingV2.stake` w/ optional swap leg), or both —
  Autonomopoly does both.
- §A.1 should clarify whether `claim` wraps `LiquidFeeLocker.claim`,
  `StakingV2.claim`, or both. Autonomopoly has only exercised the first
  in-window.
- §A.2 should document whether the > 0.1 DIEM threshold is an autono default,
  a Venice recommendation, or a tweet-only heuristic. On-chain it's neither —
  the contract accepts any amount.
- §A.2 should resolve the DIEM-address contradiction: is `0xB3D7e0c3…` an
  abandoned earlier deployment, a different chain's deployment, or simply
  noise in the brief? Until then this document treats `0xF4d97F2d…` as
  canonical.
- The "logs every move in its own on-chain history" framing should be
  softened in §A.1 / §A.2 — there's no Autonomopoly-owned logger contract.
