# syntax=docker/dockerfile:1.7

# The host's `bwoc` is a macOS arm64 Mach-O binary and cannot run in a Linux
# container. `bwoc`, `bwoc-agent` and `bwoc-harness` come from the framework's
# Linux release tarball, pinned by BWOC_RELEASE and checked against the
# release's .sha256. The release does not ship `bwoc-mqtt` or `bwoc-a2a`, so
# the transport image still compiles those two from the named build context
# `bwocsrc` (see compose.yaml) — keep that checkout at the same tag.

FROM debian:trixie-slim AS bwoc-release
ARG BWOC_RELEASE=v2026.9.26-0
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$TARGETARCH" in \
      arm64) triple=aarch64-unknown-linux-gnu ;; \
      amd64) triple=x86_64-unknown-linux-gnu ;; \
      *) echo "no bwoc release for TARGETARCH=$TARGETARCH" >&2; exit 1 ;; \
    esac; \
    name="bwoc-${BWOC_RELEASE}-${triple}"; \
    base="https://github.com/bemindlabs/BWOC-Framework/releases/download/${BWOC_RELEASE}"; \
    curl -fsSL -o /tmp/bwoc.tar.gz "$base/$name.tar.gz"; \
    curl -fsSL -o /tmp/bwoc.sha256 "$base/$name.tar.gz.sha256"; \
    echo "$(cut -d' ' -f1 /tmp/bwoc.sha256)  /tmp/bwoc.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/bwoc.tar.gz -C /tmp; \
    mkdir -p /out; \
    cp "/tmp/$name/bwoc" "/tmp/$name/bwoc-agent" "/tmp/$name/bwoc-harness" /out/

# ---- transport binaries not in the release: compiled from `bwocsrc` ----
FROM rust:1-bookworm AS bwoc-src
WORKDIR /src
COPY --from=bwocsrc . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --bin bwoc-mqtt --bin bwoc-a2a \
 && mkdir -p /out \
 && cp target/release/bwoc-mqtt target/release/bwoc-a2a /out/

# ---- UI build ----
FROM node:25-bookworm-slim AS ui
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN pnpm build

# ---- runtime ----
# The release binaries need glibc >= 2.39; bookworm has 2.36, trixie 2.41.
FROM node:25-trixie-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

COPY --from=bwoc-release /out/ /usr/local/bin/
WORKDIR /app
COPY --from=ui /app/dist ./dist
COPY server ./server
COPY package.json ./

ENV NODE_ENV=production \
    SERVE_STATIC=1 \
    PORT=8791 \
    BIND_HOST=0.0.0.0 \
    BWOC_WORKSPACE_ROOT=/workspaces \
    BWOC_BIN=/usr/local/bin/bwoc

EXPOSE 8791
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.mjs"]

# ---- transport-only image: release binaries + bwoc-mqtt/bwoc-a2a, no Node ----
FROM debian:trixie-slim AS transport
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=bwoc-release /out/ /usr/local/bin/
COPY --from=bwoc-src /out/ /usr/local/bin/
ENV BWOC_WORKSPACE_ROOT=/workspaces
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bwoc", "--version"]
