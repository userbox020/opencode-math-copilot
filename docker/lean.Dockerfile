# Reproducible Linux Lean environment for the OpenAI math corpus.
#
# Build:
#   docker build -f docker/lean.Dockerfile -t opencode-math-lean .
#
# Run (persist the clone/cache in a named volume):
#   docker volume create opencode-math-lean
#   docker run --rm -it -v opencode-math-lean:/work opencode-math-lean verify-lean.sh
#
# The container uses its own Linux filesystem, avoiding the NTFS-invalid
# AINTLIB path that blocks a native Windows dependency checkout.

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV ELAN_HOME=/root/.elan
ENV PATH=/root/.elan/bin:${PATH}

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        build-essential \
        zstd \
        unzip \
        xz-utils \
        python3 \
        python3-pip \
        libgmp-dev \
        libssl-dev \
        pkg-config \
    && rm -rf /var/lib/apt/lists/*

RUN curl -sSfL https://elan.lean-lang.org/elan-init.sh -o /tmp/elan-init.sh \
    && sh /tmp/elan-init.sh -y --default-toolchain leanprover/lean4:v4.34.1 \
    && rm -f /tmp/elan-init.sh \
    && lean --version \
    && lake --version

COPY docker/verify-lean.sh /usr/local/bin/verify-lean.sh
RUN chmod +x /usr/local/bin/verify-lean.sh

WORKDIR /work
CMD ["bash"]
