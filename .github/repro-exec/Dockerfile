# Sandbox image for the CONTAINED repro-execution step (#145 part 3/3).
#
# This image is the KERNEL-ENFORCED containment boundary that makes it safe to
# execute the model-generated repro verifier (apps/web/scripts/repro-verify-batch.ts
# --phase verify-one). It is BUILT with network available in the workflow's build
# step, then RUN with `--network none` (plus non-root, --cap-drop ALL,
# --security-opt no-new-privileges). Because it is run offline, it MUST be
# entirely self-contained: everything a repro needs is installed HERE at build
# time — there are NO runtime downloads inside the container.
#
# Deliberately minimal: no secrets and NO app code are baked in. The repo is
# bind-mounted read-only at /work at runtime (including the already-installed
# node_modules and the fetch-phase's bare git mirrors), so nothing here needs to
# know about the application.
#
# Base PINNED BY DIGEST (not just the tag): the digest below is the multi-arch
# manifest-list digest for node:22-bookworm-slim, resolved from
# registry-1.docker.io on 2026-07-12 (also matches the Docker Hub API). Pinning by
# digest makes the containment boundary reproducible — a re-tag of 22-bookworm-slim
# upstream cannot silently change the image this security-critical sandbox runs.
# To refresh: re-resolve the tag's Docker-Content-Digest and update BOTH the digest
# and the date in this comment.
FROM node:22-bookworm-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf

# The OFFLINE contract (#145 Part 3, Issue 2) SKIPS the target project's test
# suite — the generated repro IS the regression test — so the image only needs
# what a self-contained node/python repro runs:
#   - node        — the base image already provides it (allowlisted runner).
#   - git         — offline clone from the bind-mounted bare mirror.
#   - python3 (+ pip, venv) — self-contained pytest / python repros and venvs.
#   - ca-certificates — TLS roots (harmless offline; kept for any local tooling).
# pnpm / go are NO LONGER installed: they were only for the now-skipped project
# test suite. corepack (which shipped pnpm) is likewise dropped. Clean the apt
# lists in the same layer so no package index is baked into the image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git \
    python3 \
    python3-pip \
    python3-venv \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /work
