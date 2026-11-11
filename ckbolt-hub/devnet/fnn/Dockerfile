# syntax=docker/dockerfile:1
# Small runtime image for the release (not debug) fnn binary, so devnet timings match testnet and mainnet.
ARG BASE_IMAGE=debian:bookworm-slim

FROM ${BASE_IMAGE} AS download
ARG TARGETARCH
ARG FNN_VERSION=v0.9.1
ARG FNN_RELEASE_URL=https://github.com/nervosnetwork/fiber/releases/download
# SHA-256 of fnn_<version>-<arch>-linux-portable.tar.gz, checked before unpacking.
ARG FNN_SHA256_AMD64=6425bc90ce971a5b8f10bd93667227cc932ee2e50a70f584e2c07590ce446d0d
ARG FNN_SHA256_ARM64=c52c99b06bd954244b3fb91634d5b5031c23170208e46c7738ee308cb0bd3f0c
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) arch=x86_64; sha="$FNN_SHA256_AMD64" ;; \
      arm64) arch=aarch64; sha="$FNN_SHA256_ARM64" ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    asset="fnn_${FNN_VERSION}-${arch}-linux-portable.tar.gz"; \
    curl -fsSL -o "/tmp/$asset" "$FNN_RELEASE_URL/$FNN_VERSION/$asset"; \
    echo "$sha  /tmp/$asset" | sha256sum -c -; \
    mkdir -p /opt/fnn; \
    tar -xzf "/tmp/$asset" -C /opt/fnn fnn fnn-cli

FROM ${BASE_IMAGE}
# ca-certificates: on testnet fnn reaches a public CKB RPC over https.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=download /opt/fnn/fnn /opt/fnn/fnn-cli /usr/local/bin/
COPY docker-entrypoint.sh /usr/local/bin/fnn-entrypoint
COPY healthcheck.sh /usr/local/bin/fnn-healthcheck
RUN chmod +x /usr/local/bin/fnn-entrypoint /usr/local/bin/fnn-healthcheck

ENV FIBER_HOME=/fiber \
    FIBER_CONFIG=/etc/fnn/config.yml
VOLUME ["/fiber"]
EXPOSE 8227 8228
ENTRYPOINT ["fnn-entrypoint"]
