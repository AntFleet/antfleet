# Solidity sidecar — Phase 0: Context assembly (pre-detect ingestion)

## Problem

The refuter reasons only over the on-chain closure. A real on-chain observation
that is actually mitigated **off-chain** (trusted-party policy, a documented trust
model) cannot be killed and surfaces as a PURSUE false-positive. Live example
(Puffer #355): `PufferProtocol.registerValidatorKey` picks the 1-ETH enclave bond
by `raveEvidence.length` with no on-chain RAVE validation — real on-chain, but
guardians validate RAVE off-chain by design (`docs/PufferProtocol.md`,
`docs/README.md`), so it is BY-DESIGN, not a bug. Resolved only by reading sources
OUTSIDE the closure: the project docs and the repo's audit reports.

## Goal

A **Phase 0** that ingests, once per repo (amortized across a sweep), three
off-chain sources and routes them **asymmetrically** into the detect + refute
phases, so the pipeline reasons about off-chain trust the way a human auditor does
(read docs + prior audits first, then audit) — WITHOUT poisoning finder recall.

Sources: (1) repo docs + NatSpec, (2) audit reports (text), (3) operator
`--trust-model` file.

## The one hard rule — asymmetric routing (protects recall)

The finder must NEVER be handed adjudicative conclusions ("X is safe / out of
scope") — that suppresses *discovery* at the worst stage. Split by role:

| Phase | Consumes | Framing |
| --- | --- | --- |
| Finder / Slice / Confirm | `systemBrief` (how the system works, which off-chain actors exist) | **DESCRIPTIVE** — understand the system; still report every on-chain issue; if something may be handled off-chain, report it AND note that. Never "what to dismiss". |
| Refuter | `trustCorpus` (docs + trust-model + audit text) + `knownIssues` | **ADJUDICATIVE** — new kill-grounds `OFF-CHAIN-MITIGATED` and `DOCUMENTED/KNOWN`; a `DUPLICATE` corpus |

## The guardrail — off-chain kills must be grounded (symmetric rigor)

An off-chain/documented kill is only accepted if the refuter cites a **specific
quote** that is **mechanically verified** to exist in `trustCorpus` (same rigor as
on-chain evidence grounding in `scoring.ts`). Unsupported off-chain dismissals are
**flipped to SURVIVED** (fail-safe: keep for human review). A KILLED verdict whose
reason smells off-chain (guardian/paymaster/keeper/off-chain/by-design/documented)
but carries no grounded `offChainEvidence` is likewise flipped. On-chain kills
(PRIVILEGED-GATED / MIS-CITED / RECOVERABLE / OUT-OF-SCOPE by closure reasoning)
are unchanged and need no off-chain evidence.

## Data model (`context-pack.ts`)

```
type ContextSource = { path: string; kind: "doc" | "natspec" | "audit" | "trust-model" };
type ContextPack = {
  systemBrief: string;      // DESCRIPTIVE — for finder/slice/confirm (bounded, lean)
  trustCorpus: string;      // ADJUDICATIVE — for refuter (docs + trust-model + audits)
  knownIssues: string[];    // for refuter DUPLICATE corpus (feeds existing priorFindings hook)
  sources: ContextSource[]; // provenance
};
```

- `buildContextPack(inputs)` — PURE; assembles from {docs, natspecHints, auditTexts,
  trustModelText, budgets}. Bounded by byte budgets (brief lean, corpus larger).
- `collectContextInputs({root, listFiles, readFile, closureFiles})` — FS side:
  lists `docs/**/*.md` + `README*`, extracts NatSpec off-chain-actor hints from the
  closure files.
- `extractNatSpecTrustHints(files)` — PURE; NatSpec `@notice/@dev`/`///` lines
  mentioning off-chain actors (guardian, paymaster, keeper, sequencer, relayer,
  off-chain, attestation, enclave, watchtower, signer, oracle updater, bot).
- `renderSystemBrief(pack)` / `renderTrustCorpus(pack)` — fenced UNTRUSTED-data
  strings for the prompts.
- `groundOffChainClaim(quote, pack)` — PURE; whitespace-normalized substring check
  that a cited quote (>= min length) occurs in `trustCorpus`. The guardrail.

Docs/audits are UNTRUSTED (a repo can lie): fenced like source, and a doc that
merely asserts safety without a mechanism does not ground a kill.

## Wiring

- `prompt.ts`: finder/slice/confirm gain optional `systemContext`; refuter gains
  optional `trustModelContext`, two new kill-grounds, and `offChainEvidence`
  in `REFUTATION_JSON_SHAPE`.
- `refuter.ts`: `RefuteFindingArgs.trustModelContext`; after parse, ground
  off-chain kills and flip ungrounded ones to SURVIVED.
- `run.ts`: `RunFinderInput.systemContext` → slice/finder prompts.
- `sweep.ts` `auditEntry`: `contextPack?` → systemContext into finder/confirm,
  trustCorpus + knownIssues into the refuter callback. Assembled once per repo.
- `cli.ts`: `--docs <dir>` (default auto: `docs/` + `README*`), `--audits <dir of
  .txt/.md>` (operators `pdftotext` PDFs in — the tool stays dependency-free),
  `--trust-model <file>`, `--no-context`. Absent all of these ⇒ pack is empty ⇒
  behavior identical to pre-Phase-0 (fully backward compatible).

## Non-goals

- No LLM call in Phase 0 (pure mechanical assembly — cheap, deterministic).
- No PDF parsing in-process (operators extract audit text; keeps zero new deps).
- Cannot verify off-chain code actually behaves as documented — a finding where the
  off-chain component genuinely fails still (correctly) survives for human review.
