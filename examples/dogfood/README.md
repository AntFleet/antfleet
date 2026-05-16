# Dogfood Corpus

Tiny synthetic TypeScript repo used to measure whether Antfeed Fleet's stacked
multi-model review separates signal from noise on a known set of bugs.

Five bugs are intentionally planted across `src/`. They span:

- An obvious null dereference at an HTTP entrypoint.
- A subtle race condition in a shared in-memory counter.
- A SQL injection via string concatenation.
- A missing input-validation gap at an API boundary.
- A deceptive comment that lies about what the code does.

The bugs deliberately vary in difficulty so we can tell whether agreement
across providers helps catch hard bugs or whether it only catches the easy
ones. See `scripts/spike.ts` at the repo root for the runner that emits the
baseline report under `examples/dogfood-results/`.

Do not depend on this corpus from real product code. It is a measurement
artifact, not a library.
