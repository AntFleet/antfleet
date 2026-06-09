# Virtuals Replay Verdict

Pending live probe run.

The implementation is in `apps/web/scripts/probe-virtuals-replay.ts`. Run from
`apps/web` with:

```sh
pnpm exec tsx scripts/probe-virtuals-replay.ts
```

The current migration-0029 token-gated cohort check was rerun before
implementation:

| metric | count |
|---|---:|
| total findings | 34 |
| both proposed | 13 |
| opus only | 8 |
| gpt5 only | 1 |
| neither | 12 |

No Virtuals calls have been made yet in this working tree.
