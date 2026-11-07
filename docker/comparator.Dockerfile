# Comparator/landrun layer for the math corpus.
#
# Build after opencode-math-lean:
#   docker build -f docker/comparator.Dockerfile -t opencode-math-comparator .
#
# Run:
#   docker run --rm -it -v opencode-math-lean:/work \
#     opencode-math-comparator verify-comparator.sh
#
# Comparator and landrun are Linux-only. The standalone Comparator is archived
# and version-sensitive to the project's Lean 4.34.1 pin; the script reports
# build failures instead of claiming verification.

FROM opencode-math-lean

ARG GO_VERSION=1.24.5
ENV PATH=/usr/local/go/bin:${PATH}

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl git build-essential \
    && curl -sSfL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" \
        | tar -xz -C /usr/local \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 https://github.com/ZouUup/landrun.git /opt/landrun \
    && cd /opt/landrun \
    && go build -o /usr/local/bin/landrun cmd/landrun/main.go \
    && landrun --version

COPY docker/verify-comparator.sh /usr/local/bin/verify-comparator.sh
RUN chmod +x /usr/local/bin/verify-comparator.sh

WORKDIR /work
CMD ["bash"]
