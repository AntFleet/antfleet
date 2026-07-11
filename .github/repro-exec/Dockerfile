# Sandbox image for the CONTAINED repro-execution step (#145 part 3/3).
#
# This image is the KERNEL-ENFORCED containment boundary that makes it safe to
# execute the model-generated repro verifier (apps/web/scripts/repro-verify-batch.ts
# --phase exec). It is BUILT with network available in the workflow's build step,
# then RUN with `--network none` (plus non-root, --cap-drop ALL,
# --security-opt no-new-privileges). Because it is run offline, it MUST be
# entirely self-contained: everything a repro needs is installed HERE at build
# time — there are NO runtime downloads inside the container.
#
# Deliberately minimal: no secrets and NO app code are baked in. The repo is
# bind-mounted read-only at /work at runtime (including the already-installed
# node_modules and the fetch-phase's bare git mirrors), so nothing here needs to
# know about the application. Base pinned by major tag (node 22, bookworm-slim).
FROM node:22-bookworm-slim

# Only what generated repros actually need to build/run: git (offline clone from
# the bind-mounted bare mirror), a Python toolchain (pytest repros + venvs), and
# CA certs. corepack ships with the node image and provides pnpm without a
# network fetch. Clean the apt lists in the same layer so no package index is
# baked into the image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git \
    python3 \
    python3-pip \
    python3-venv \
    ca-certificates \
  && corepack enable \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /work
