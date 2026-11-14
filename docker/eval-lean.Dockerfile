# syntax=docker/dockerfile:1
# Operator build; compilation runtime, not a proof checker. See build-eval-runtime.ps1.
# The unique local toolchain alias is checked against TOOLCHAIN_IMAGE_ID before and
# after the build. Only the original toolchain subtree is copied, never old caches.
ARG TOOLCHAIN_IMAGE
ARG BASE_IMAGE
FROM ${TOOLCHAIN_IMAGE} AS original_toolchain
FROM ${BASE_IMAGE} AS prepare
ARG TOOLCHAIN_IMAGE
ARG BASE_IMAGE
ARG TOOLCHAIN_IMAGE_ID
RUN printf '%s\n' "$BASE_IMAGE" | grep -Eq '^.+@sha256:[0-9a-f]{64}$' && printf '%s\n' "$TOOLCHAIN_IMAGE_ID" | grep -Eq '^sha256:[0-9a-f]{64}$'
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git curl zstd unzip python3 build-essential libgmp-dev libssl-dev
COPY --from=original_toolchain /root/.elan/toolchains/leanprover--lean4---v4.34.1/ /opt/lean/
ENV PATH=/opt/lean/bin:/usr/bin:/bin MATHLIB_CACHE_DIR=/opt/fresh-mathlib-cache MATHLIB_NO_CACHE_ON_UPDATE=1
RUN /opt/lean/bin/lean --version | grep -F 'version 4.34.1' && test ! -e /opt/fresh-mathlib-cache && mkdir /opt/fresh-mathlib-cache /runtime && mkdir /runtime/metadata && (cd /opt/lean && find . -type f -print0 | sort -z | xargs -0 sha256sum) > /runtime/metadata/toolchain-sha256.txt
WORKDIR /opt/project
RUN <<'SH'
set -eu
printf 'leanprover/lean4:v4.34.1\n' > lean-toolchain
cat > lakefile.toml <<'TOML'
name = "eval_mathlib_runtime"
version = "0.1.0"
[[require]]
name = "mathlib"
git = "https://github.com/leanprover-community/mathlib4.git"
rev = "d13f23b723b8a846827a245b89c10fc7d3f11612"
TOML
# Network/package execution is operator build-time only, never an evaluation call.
unset MATHLIB_CACHE_GET_URL MATHLIB_CACHE_BASE_URL MATHLIB_CACHE_PUT_URL MATHLIB_CACHE_PUT_BASE_URL MATHLIB_CACHE_FROM MATHLIB_CACHE_DEBUG_USE_LEGACY
lake update
SH
RUN <<'SH'
set -eu
python3 - <<'PY'
import json, subprocess
from pathlib import Path
# Pins read from the local pinned Mathlib source manifest, not a corpus cache.
expected = {
 'mathlib': 'd13f23b723b8a846827a245b89c10fc7d3f11612',
 'plausible': '118aa17ee84656b8bd727fef7c458ee8c833385c',
 'LeanSearchClient': 'ddf04cf3949fa556442341e87d47f9f6e6074707',
 'importGraph': 'e928b72544873815af278d38681b31c0293588e3',
 'proofwidgets': '106ff4fafc74ef4ac99d81dbf3ab399118f497a5',
 'aesop': '355695d523e41d0554926416cba2a2b3544fbbc9',
 'Qq': '6a489d9af5d0c47e5b259e2e8bcdfc1811b5a259',
 'batteries': 'f2effa3d803fda822b1f97b806c47cf2adfbcbc2',
 'Cli': 'e92c9f15fdfacc8536f31cfb3b7ad26c3c8cd204',
}
manifest = json.loads(Path('lake-manifest.json').read_text())
actual = {p['name']: p['rev'] for p in manifest['packages']}
assert actual == expected, ('dependency lock mismatch', actual)
for name, rev in expected.items():
    package = Path('.lake/packages') / name
    assert subprocess.check_output(['git', '-C', str(package), 'rev-parse', 'HEAD'], text=True).strip() == rev
assert Path('.lake/packages/mathlib/lean-toolchain').read_text().strip() == 'leanprover/lean4:v4.34.1'
PY
unset MATHLIB_CACHE_GET_URL MATHLIB_CACHE_BASE_URL MATHLIB_CACHE_PUT_URL MATHLIB_CACHE_PUT_BASE_URL MATHLIB_CACHE_FROM MATHLIB_CACHE_DEBUG_USE_LEGACY
lake exe cache get! --cache-from=master Mathlib
# Record downloaded bytes separately from input-hash cache keys. Neither is an
# upstream signature. All inputs here were freshly fetched in this operator build.
find /opt/fresh-mathlib-cache -type f -print0 | sort -z | xargs -0 sha256sum > /runtime/metadata/downloaded-cache-sha256.txt
for package in mathlib plausible LeanSearchClient importGraph proofwidgets aesop Qq batteries Cli; do
  (cd ".lake/packages/$package" && git ls-files -z | sort -z | xargs -0 sha256sum) > "/runtime/metadata/source-$package-sha256.txt"
  (cd ".lake/packages/$package" && git archive --format=tar HEAD | gzip -n) > "/runtime/metadata/source-$package.tar.gz"
done
# Copy only fresh Mathlib/dependency library artifacts, never build cache archives,
# corpus, gold, logs, host directories, Docker socket, or project credentials.
mkdir -p /runtime/mathlib/.lake/build/lib /runtime/mathlib/.lake/packages /runtime/metadata
cp -a .lake/packages/mathlib/.lake/build/lib/. /runtime/mathlib/.lake/build/lib/
for package in plausible LeanSearchClient importGraph proofwidgets aesop Qq batteries Cli; do
  mkdir -p "/runtime/mathlib/.lake/packages/$package/.lake/build/lib"
  if [ -d ".lake/packages/$package/.lake/build/lib" ]; then
    cp -a ".lake/packages/$package/.lake/build/lib/." "/runtime/mathlib/.lake/packages/$package/.lake/build/lib/"
  fi
done
cp lake-manifest.json lean-toolchain /runtime/metadata/
# Content inventory is evidence for operator review, not upstream authentication.
find /runtime/mathlib -type f -exec sha256sum {} + > /runtime/metadata/artifact-sha256.txt
SH

FROM ${BASE_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends libgmp10 libatomic1 python3 python3-sympy && rm -rf /var/lib/apt/lists/*
COPY --from=prepare /opt/lean/ /opt/lean/
COPY --from=prepare /runtime/mathlib/ /opt/mathlib/
COPY --from=prepare /runtime/metadata/ /usr/share/eval-runtime/
RUN chmod -R a+rX /opt/mathlib
RUN dpkg-query -W -f='${Package}\t${Version}\n' > /usr/share/eval-runtime/apt-packages.txt && /usr/bin/python3 -c 'import sys,sympy; print(sys.version); print("SymPy",sympy.__version__)' > /usr/share/eval-runtime/python-sympy.txt
LABEL org.opencode.eval.runtime="mathlib-only-v1"
ENV PATH=/opt/lean/bin:/usr/bin:/bin HOME=/work TMPDIR=/tmp LANG=C.UTF-8
ENV LEAN_PATH=/opt/mathlib/.lake/build/lib/lean:/opt/mathlib/.lake/packages/plausible/.lake/build/lib/lean:/opt/mathlib/.lake/packages/LeanSearchClient/.lake/build/lib/lean:/opt/mathlib/.lake/packages/importGraph/.lake/build/lib/lean:/opt/mathlib/.lake/packages/proofwidgets/.lake/build/lib/lean:/opt/mathlib/.lake/packages/aesop/.lake/build/lib/lean:/opt/mathlib/.lake/packages/Qq/.lake/build/lib/lean:/opt/mathlib/.lake/packages/batteries/.lake/build/lib/lean:/opt/mathlib/.lake/packages/Cli/.lake/build/lib/lean
USER 10001:10001
WORKDIR /work
ENTRYPOINT ["/opt/lean/bin/lean"]
CMD ["--stdin"]
