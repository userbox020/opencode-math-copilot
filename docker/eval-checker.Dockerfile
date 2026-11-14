# syntax=docker/dockerfile:1
ARG TOOLCHAIN_IMAGE
ARG BASE_IMAGE
ARG RUNTIME_IMAGE
ARG CORE_IMAGE
FROM ${TOOLCHAIN_IMAGE} AS original
FROM ${BASE_IMAGE} AS builder
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git build-essential libgmp-dev python3
COPY --from=original /root/.elan/toolchains/leanprover--lean4---v4.34.1/ /opt/lean/
ENV PATH=/opt/lean/bin:/usr/bin:/bin
WORKDIR /opt/comparator
RUN git clone https://github.com/leanprover/comparator.git . && git checkout --detach d03acab154d269c06e60e4de7e4cc85deebff94b && test "$(git rev-parse HEAD)" = d03acab154d269c06e60e4de7e4cc85deebff94b
RUN python3 - <<'PY'
from pathlib import Path
p = Path('lakefile.toml')
p.write_text(p.read_text().replace('scope = "leanprover"', 'git = "https://github.com/leanprover/lean4export.git"').replace('rev = "master"', 'rev = "076e8e57707e813375e8f9da8bf989799ace9680"') + '\n[[lean_exe]]\nname = "comparator_check_only"\nroot = "CheckOnly"\n')
Path('lean-toolchain').write_text('leanprover/lean4:v4.34.1\n')
PY
COPY CheckOnly.lean ./CheckOnly.lean
RUN lean --version | grep -F 'version 4.34.1' && lake update && test "$(git -C .lake/packages/lean4export rev-parse HEAD)" = 076e8e57707e813375e8f9da8bf989799ace9680 && lake build comparator_check_only && cd .lake/packages/lean4export && lake build lean4export
RUN mkdir -p /out/rootfs /out/source && cp .lake/build/bin/comparator_check_only /out/ && cp .lake/packages/lean4export/.lake/build/bin/lean4export /out/ && cp -a .lake/packages/lean4export/Export /out/source/ && cp -a Comparator Main.lean lake-manifest.json lakefile.toml CheckOnly.lean /out/source/ && python3 - <<'PY'
import re, shutil, subprocess
from pathlib import Path
for exe in ['/out/comparator_check_only', '/out/lean4export']:
    output = subprocess.check_output(['ldd', exe], text=True)
    Path(exe + '.ldd').write_text(output)
    for lib in re.findall(r'(?:=>\s+)?(/[^\s]+)', output):
        # Ubuntu /lib and /lib64 are symlinks; never COPY directories over them.
        target = Path('/out/rootfs' + str(Path(lib).resolve()))
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(lib, target)
PY

# Build this first, without Mathlib. No solver cache or compiled Comparator reused.
FROM ${BASE_IMAGE} AS checker_core
COPY --from=builder /out/rootfs/ /
COPY --from=builder /out/rootfs/ /usr/share/checker-libs/
COPY --from=builder /out/comparator_check_only /opt/comparator_check_only
COPY --from=builder /out/lean4export /opt/lean4export
COPY --from=builder /out/source/ /usr/share/checker-source/
COPY --from=builder /out/comparator_check_only.ldd /out/lean4export.ldd /usr/share/checker-source/
LABEL org.opencode.eval.checker="core-v1"

FROM ${CORE_IMAGE} AS frozen_core
FROM ${RUNTIME_IMAGE} AS export_worker
USER root
COPY --from=frozen_core /opt/lean4export /opt/lean4export
COPY export-launcher.py /opt/export-launcher.py
COPY roots.json /opt/checker-roots.json
LABEL org.opencode.eval.checker="export-v1"
USER 10001:10001
ENTRYPOINT ["/usr/bin/python3", "/opt/export-launcher.py"]

# Trusted statements are frozen in this operator-only build, before submissions.
FROM export_worker AS challenge_builder
USER root
COPY challenges/ /opt/challenge-source/
RUN mkdir -p /opt/challenges && python3 - <<'PY'
import json, os, subprocess
from pathlib import Path
roots = json.loads(Path('/opt/checker-roots.json').read_text())
env = dict(os.environ, LEAN_PATH=os.environ['LEAN_PATH'] + ':/opt/challenge-source')
for task, names in roots.items():
    source = Path('/opt/challenge-source') / (task + '.lean')
    # One fixed module name; overwrite only build-owned trusted files.
    Path('/opt/challenge-source/Challenge.lean').write_bytes(source.read_bytes())
    subprocess.run(['/opt/lean/bin/lean', '-o', '/opt/challenge-source/Challenge.olean', '/opt/challenge-source/Challenge.lean'], env=env, cwd='/opt/challenge-source', check=True)
    with open('/opt/challenges/' + task + '.export', 'wb') as out:
        subprocess.run(['/opt/lean4export', 'Challenge', '--', *names], env=env, cwd='/opt/challenge-source', stdout=out, check=True)
PY

# B contains only the prebuilt checker, its runtime libraries, frozen data and OS.
FROM ${BASE_IMAGE} AS checker
COPY --from=frozen_core /usr/share/checker-libs/ /
COPY --from=frozen_core /opt/comparator_check_only /opt/comparator_check_only
COPY --from=challenge_builder /opt/challenges/ /opt/challenges/
COPY policies.json /opt/checker-policies.json
LABEL org.opencode.eval.checker="data-only-v1"
ENV PATH=/usr/bin:/bin HOME=/work TMPDIR=/tmp LANG=C.UTF-8
USER 10001:10001
WORKDIR /work
ENTRYPOINT ["/opt/comparator_check_only"]
