# syntax=docker/dockerfile:1
# bitcoind for Mutinynet, a custom signet with 30 s blocks. Stock Bitcoin Core cannot follow it: this is the fork the
# Mutinynet operators run (github.com/benthecarman/bitcoin, release "mutinynet-inq-template-hash", 2026-05-17, the same
# binary MutinyWallet/mutiny-net builds from). The archive is checked against the SHA-256 the release publishes.
ARG BASE_IMAGE=debian:bookworm-slim

FROM ${BASE_IMAGE} AS download
ARG TARGETARCH
ARG MUTINYNET_RELEASE_URL=https://github.com/benthecarman/bitcoin/releases/download
ARG MUTINYNET_RELEASE_TAG=mutinynet-inq-template-hash
ARG MUTINYNET_BITCOIN_VERSION=2fda7bfc027e
ARG BITCOIN_SHA256_AMD64=c76b58a078e3e5fcc4597f50d9f9d15da8d11a5d8cf0831ab62970329bfb6115
ARG BITCOIN_SHA256_ARM64=c18705e9e98202e095e13bbc5546b5f34fbb4df9bf8bc34ef4553f6d2d1d68bc
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) triplet=x86_64-linux-gnu; sha="$BITCOIN_SHA256_AMD64" ;; \
      arm64) triplet=aarch64-linux-gnu; sha="$BITCOIN_SHA256_ARM64" ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    asset="bitcoin-${MUTINYNET_BITCOIN_VERSION}-${triplet}.tar.gz"; \
    curl -fsSL -o "/tmp/$asset" "$MUTINYNET_RELEASE_URL/$MUTINYNET_RELEASE_TAG/$asset"; \
    echo "$sha  /tmp/$asset" | sha256sum -c -; \
    mkdir -p /opt/bitcoin; \
    tar -xzf "/tmp/$asset" -C /opt/bitcoin --strip-components=2 \
      "bitcoin-${MUTINYNET_BITCOIN_VERSION}/bin/bitcoind" "bitcoin-${MUTINYNET_BITCOIN_VERSION}/bin/bitcoin-cli"

FROM ${BASE_IMAGE}
COPY --from=download /opt/bitcoin/bitcoind /opt/bitcoin/bitcoin-cli /usr/local/bin/
RUN groupadd --system bitcoin \
    && useradd --system --gid bitcoin --home-dir /data bitcoin \
    && mkdir -p /data \
    && chown bitcoin:bitcoin /data
USER bitcoin
VOLUME ["/data"]
# Signet RPC, P2P and the ZMQ feeds LND reads.
EXPOSE 38332 38333 28332 28333
ENTRYPOINT ["bitcoind"]
CMD ["-conf=/etc/bitcoin/bitcoin.conf", "-datadir=/data"]
