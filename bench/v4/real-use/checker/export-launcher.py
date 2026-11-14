"""Hostile compile/export worker A. Its stdout is untrusted declaration data, never a verdict."""
import json
import os
import subprocess
import sys
from pathlib import Path

SOURCE_LIMIT = 131072
# Only public root names are in A; trusted challenge exports are exclusively in B.
ROOTS = json.loads(Path('/opt/checker-roots.json').read_text())

def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ROOTS:
        return 64
    source = sys.stdin.buffer.read(SOURCE_LIMIT + 1)
    if not source or len(source) > SOURCE_LIMIT:
        return 65
    Path('/work/Solution.lean').write_bytes(source)
    env = {'PATH': '/opt/lean/bin:/usr/bin:/bin', 'HOME': '/work', 'TMPDIR': '/tmp',
           'LANG': 'C.UTF-8', 'LEAN_PATH': os.environ['LEAN_PATH'] + ':/work',
           'LEAN_ABORT_ON_PANIC': '1'}
    # Compile output is diagnostics, not the export artifact. No Lake is invoked.
    result = subprocess.run(['/opt/lean/bin/lean', '-o', '/work/Solution.olean', '/work/Solution.lean'],
                            cwd='/work', env=env, stdout=sys.stderr, stderr=sys.stderr)
    if result.returncode:
        print(json.dumps({'phase': 'compile', 'returncode': result.returncode}), file=sys.stderr, flush=True)
        return 20
    result = subprocess.run(['/opt/lean4export', 'Solution', '--', *ROOTS[sys.argv[1]]],
                            cwd='/work', env=env, stdout=sys.stdout, stderr=sys.stderr)
    return 0 if result.returncode == 0 else 21

if __name__ == '__main__':
    sys.exit(main())
