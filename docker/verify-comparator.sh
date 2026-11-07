#!/usr/bin/env bash
set -euo pipefail

MATH_DIR="${MATH_DIR:-/work/math}"
COMPARATOR_DIR="${COMPARATOR_DIR:-/opt/comparator}"
EXPORT_DIR="${EXPORT_DIR:-/opt/lean4export}"
CHALLENGE="${CHALLENGE:-ComparatorChallenges/QuasiRiemannHypothesis.json}"

echo "== Comparator Docker verification =="
command -v landrun
landrun --version || true
lake --version

if [ ! -d "$MATH_DIR/math" ] && [ ! -d "$MATH_DIR/.git" ]; then
  echo "No math clone at $MATH_DIR." >&2
  echo "Run the Lean image once with the same volume first: docker run --rm -v opencode-math-lean:/work opencode-math-lean verify-lean.sh" >&2
  exit 1
fi

if [ ! -d "$COMPARATOR_DIR/.git" ]; then
  git clone --depth 1 https://github.com/leanprover/comparator.git "$COMPARATOR_DIR"
fi
if [ ! -d "$EXPORT_DIR/.git" ]; then
  git clone --depth 1 https://github.com/leanprover/lean4export.git "$EXPORT_DIR"
fi

cd "$COMPARATOR_DIR"

echo "== Building Comparator and lean4export =="
if ! lake build lean4export comparator; then
  echo "Comparator build failed. This is expected for some Lean-version/toolchain combinations." >&2
  echo "Do not treat this as a verification pass." >&2
  exit 1
fi

export PATH="$COMPARATOR_DIR/.lake/build/bin:$COMPARATOR_DIR/.lake/packages/lean4export/.lake/build/bin:$PATH"

cd "$MATH_DIR/lean"

echo "== Running challenge: $CHALLENGE =="
lake env comparator "$CHALLENGE"

echo "COMPARATOR_DOCKER_OK"
