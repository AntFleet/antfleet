# Repro-exec runner image (Build 2b). Carries the toolchains the containerized
# repro/test steps need — the base node image alone has only node + git, so a
# pnpm-based repro (the common case) would otherwise fail inside the container.
#
# Built locally in the workflow's exec job (`docker build - < this`), so there
# is no external registry to trust; the supply-chain pin is the digest-pinned
# FROM below (kept in sync with REPRO_EXEC_IMAGE's base in repro-verify-batch.ts
# and the workflow's contract test). git ships in the bookworm node image.
#
# The image is only ever run with `--network none` (no secrets, non-root user),
# so it holds tooling, never credentials. go is a documented follow-up.
FROM node:26-bookworm@sha256:219fc9da91e7f29a9f32290ff598cdf8886fd68f421ff515c8f93434da39a271

RUN npm install -g pnpm@11.1.2 \
 && apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip python3-pytest \
 && rm -rf /var/lib/apt/lists/*
