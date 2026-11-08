#!/usr/bin/env bash
set -euo pipefail

MATH_DIR="${MATH_DIR:-/work/math}"
COMPARATOR_DIR="${COMPARATOR_DIR:-/opt/comparator}"
COMPARATOR_TAG="${COMPARATOR_TAG:-v4.34.0}"
COMPARATOR_TOOLCHAIN="${COMPARATOR_TOOLCHAIN:-leanprover/lean4:v4.34.1}"
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

# The corpus pins rellich-kondrachov at a Lean 4.29-era revision while building
# it with Lean 4.34.1/Mathlib. Apply the checked-in compatibility patch once.
RELLICH_DIR="$MATH_DIR/lean/.lake/packages/rellich-kondrachov"
RELLICH_PATCH="/usr/local/share/math-toolkit/rellich-kondrachov-lean4341.patch"
if [ -d "$RELLICH_DIR/.git" ] && [ -f "$RELLICH_PATCH" ]; then
  if git -C "$RELLICH_DIR" apply --reverse --check "$RELLICH_PATCH" 2>/dev/null; then
    echo "== rellich-kondrachov compatibility patch already applied =="
  elif git -C "$RELLICH_DIR" apply --check "$RELLICH_PATCH" 2>/dev/null; then
    echo "== Applying rellich-kondrachov Lean 4.34 compatibility patch =="
    git -C "$RELLICH_DIR" apply "$RELLICH_PATCH"
  else
    echo "Could not apply $RELLICH_PATCH: the package source differs from the pinned revision." >&2
    echo "Restore the pinned checkout or update the patch deliberately." >&2
    exit 1
  fi
fi

if [ ! -d "$COMPARATOR_DIR/.git" ]; then
  git clone --branch "$COMPARATOR_TAG" --depth 1 https://github.com/leanprover/comparator.git "$COMPARATOR_DIR"
else
  if ! git -C "$COMPARATOR_DIR" rev-parse --verify --quiet "refs/tags/$COMPARATOR_TAG" >/dev/null; then
    git -C "$COMPARATOR_DIR" fetch --tags --quiet
  fi
  git -C "$COMPARATOR_DIR" checkout --quiet "$COMPARATOR_TAG"
fi

cd "$COMPARATOR_DIR"

# Comparator v4.34.0 pins Lean 4.34.0; the corpus uses 4.34.1. Building the
# standalone release with the corpus toolchain is the compatibility test.
BUILD_STAMP="$COMPARATOR_DIR/.lake/math-toolkit-build"
WANT="$COMPARATOR_TAG $COMPARATOR_TOOLCHAIN"
if [ -x "$COMPARATOR_DIR/.lake/build/bin/comparator" ] \
  && [ -x "$COMPARATOR_DIR/.lake/packages/lean4export/.lake/build/bin/lean4export" ] \
  && [ -f "$BUILD_STAMP" ] \
  && [ "$(cat "$BUILD_STAMP")" = "$WANT" ]; then
  echo "== Reusing Comparator $COMPARATOR_TAG build for $COMPARATOR_TOOLCHAIN =="
else
  echo "$COMPARATOR_TOOLCHAIN" > lean-toolchain
  echo "== Building Comparator $COMPARATOR_TAG with $COMPARATOR_TOOLCHAIN and lean4export =="
  rm -rf .lake
  if ! lake build lean4export comparator; then
    echo "Comparator build failed. This is expected for some Lean-version/toolchain combinations." >&2
    echo "Do not treat this as a verification pass." >&2
    exit 1
  fi
  mkdir -p .lake
  echo "$WANT" > "$BUILD_STAMP"
fi

export PATH="$COMPARATOR_DIR/.lake/build/bin:$COMPARATOR_DIR/.lake/packages/lean4export/.lake/build/bin:$PATH"

cd "$MATH_DIR/lean"

echo "== Running challenge: $CHALLENGE =="
lake env comparator "$CHALLENGE"

echo "COMPARATOR_DOCKER_OK"
