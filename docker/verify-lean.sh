#!/usr/bin/env bash
set -euo pipefail

MATH_DIR="${MATH_DIR:-/work/math}"
TARGET="${TARGET:-OAI.Analysis}"
SKIP_BUILD="${SKIP_BUILD:-0}"

echo "== OpenCode Math Copilot: Lean Docker verification =="
lean --version
lake --version

if [ ! -d "$MATH_DIR/.git" ]; then
  echo "== Cloning openai/math into $MATH_DIR =="
  git clone --depth 1 https://github.com/openai/math.git "$MATH_DIR"
else
  echo "== Reusing $MATH_DIR =="
fi

cd "$MATH_DIR/lean"

echo "== Fetching Mathlib cache =="
lake exe cache get

cat > /tmp/MathCopilotCheck.lean <<'LEAN'
import Mathlib

example : 1 + 1 = 2 := by norm_num
#check Nat
LEAN

echo "== Checking a Mathlib-backed Lean snippet =="
lake env lean /tmp/MathCopilotCheck.lean

if [ "$SKIP_BUILD" != "1" ]; then
  echo "== Building $TARGET =="
  lake build "$TARGET"
fi

echo "LEAN_DOCKER_OK"
