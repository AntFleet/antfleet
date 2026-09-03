# PoC-executor runner image (sidecar Solidity Phase-2). Pinned Foundry + a pinned,
# TRUSTED forge-std + pre-cached solc, so every run works fully OFFLINE
# (`--network none`), non-root, read-only root. The executor sources the assertion/
# cheat framework ONLY from this image (never the audited repo), so a repo that
# remaps `forge-std/` to a no-op assertEq cannot mint a hollow verdict (§3.4).
# SEPARATE from the patch-verifier repro-exec image by spec (§0).
FROM ghcr.io/foundry-rs/foundry:stable

USER root
# Pinned trusted forge-std at /opt/forge-std (the executor remaps forge-std/ here).
RUN git clone --depth 1 --branch v1.9.4 https://github.com/foundry-rs/forge-std /opt/forge-std \
 && rm -rf /opt/forge-std/.git

# Pre-cache solc (network available at build), then relocate the cache to a fixed,
# WORLD-READABLE home so the non-root runtime user finds it under a read-only root.
RUN for V in 0.8.20 0.8.26 0.8.28; do \
      mkdir -p /tmp/pin-$V/src && \
      printf '[profile.default]\nsrc="src"\n' > /tmp/pin-$V/foundry.toml && \
      printf '// SPDX-License-Identifier: MIT\npragma solidity =%s;\ncontract Pin {}\n' "$V" > /tmp/pin-$V/src/Pin.sol && \
      (cd /tmp/pin-$V && forge build) ; \
    done \
 && mkdir -p /opt/svmhome \
 && cp -r /root/.svm /opt/svmhome/.svm \
 && rm -rf /tmp/pin-* \
 && chmod -R a+rX /opt/svmhome

RUN useradd -m -u 10001 pocrunner || true
