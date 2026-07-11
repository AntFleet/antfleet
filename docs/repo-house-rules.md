# AntFleet org repository house rules

Canonical rulebook: **[antfleet/bench › HOUSE-RULES.md](https://github.com/antfleet/bench/blob/main/HOUSE-RULES.md)**.
Master mirror index: **[antfleet/bench › README.md](https://github.com/antfleet/bench/blob/main/README.md)**.

Quick reference for the rules that come up most:

## Benchmark mirrors

- Name every security-review mirror **`bench-<upstream-repo>`** — prefix, never the
  `<name>-bench` suffix. This keeps all mirrors sorted as one contiguous block in the org.
- Description: `AntFleet benchmark mirror of <owner>/<repo> — two-model security review methodology`.
  Do not copy the upstream's marketing tagline.
- Mirrors stay as **separate repos** — never a monorepo. Receipts pin to the upstream URL,
  and the mirror is AntFleet's immutable copy of exactly what was reviewed.
- Register each new mirror as a row in the [antfleet/bench index](https://github.com/antfleet/bench).
- `bench`-named repos that are products, not mirrors (`open-evmbench`, `aeon-template`),
  are excluded from the index and keep their product names.

## Renames & writes

- Rename with `gh repo rename` (preserves redirects); never delete-and-recreate (404s links).
- All AntFleet org writes go through the `antfleet-ops` account.
- New repos are **private by default**; make public only with explicit intent.

## Receipts

Published findings/receipts are immutable — never rewrite them to match a rename. Renames
are safe: redirects keep old URLs alive and receipts point at the upstream repo anyway.
