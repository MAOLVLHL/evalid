#!/usr/bin/env bash
# M3 slice 4 — acceptance demo for the I6d assertion-execution gate.
#
# End-to-end proof, through the real `xflow audit` CLI (not the JS API):
#   RED   — a diff whose new test defines a callback that is never called,
#           so its `assert value == 42` never executes, while the claimed
#           pytest run still passes  -> audit must say mismatch, exit 1.
#   GREEN — a diff whose new assertions all execute, same green claim
#           -> audit must say verified, exit 0.
#
# The gate's job (M3, parent #69): an assertion that never runs must not
# count as green. The RED case is exactly the README gap ("assertions in
# callbacks that never run").
#
# Usage: scripts/demo-i6d-gate.sh
# Everything happens in a throwaway repo under $TMPDIR; nothing is pushed.
# Needs a python with pytest (ambient, else a throwaway venv is built and
# pip installs pytest — same approach as test/xflow-audit.test.js).
set -euo pipefail

EVALID_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/evalid-i6d-demo-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# --- python with pytest -------------------------------------------------
# EVALID_I6D_PYTEST_PYTHON lets a caller (e.g. the node test) hand over an
# already-provisioned interpreter instead of building a second venv.
PY="${EVALID_I6D_PYTEST_PYTHON:-python3}"
if ! "$PY" -c 'import pytest' 2>/dev/null; then
  echo '[demo] no ambient pytest; building a throwaway venv…'
  "$PY" -m venv "$WORK/venv"
  "$WORK/venv/bin/python" -m pip install --quiet pytest
  PY="$WORK/venv/bin/python"
fi
export PYTHON="$PY"
export PATH="$(dirname "$PY"):$PATH"
echo "[demo] pytest python: $PY"

# --- throwaway demo repo (carries the I6d plugin, like a real adopter) ---
DEMO="$WORK/repo"
mkdir -p "$DEMO/xflow/atoms"
cp "$EVALID_ROOT/xflow/atoms/i6d_assertion_execution.py" "$DEMO/xflow/atoms/"
cd "$DEMO"
git init -q -b main
git config user.email 'i6d-demo@example.test'
git config user.name 'i6d-demo'
printf 'def test_normal():\n    assert 1 + 1 == 2\n' > test_dead.py
git add .
git commit -qm base
BASE="$(git rev-parse HEAD)"

run_case() { # $1 = RED|GREEN, $2 = file content, $3 = expected verdict, $4 = expected exit
  local name="$1" content="$2" want_verdict="$3" want_exit="$4"
  printf '%s' "$content" > test_dead.py
  git diff > "$WORK/$name.diff"
  printf 'Tests: `pytest test_dead.py` — 2 tests, all pass.\n' > "$WORK/$name.claims.txt"
  git checkout -q -- test_dead.py
  echo "=== $name case: xflow audit --diff $name.diff --base $BASE ==="
  set +e
  node "$EVALID_ROOT/bin/xflow.js" audit --repo "$DEMO" \
    --diff "$WORK/$name.diff" --base "$BASE" \
    --claims-file "$WORK/$name.claims.txt" --out "$WORK/$name.json"
  local rc=$?
  set -e
  local verdict
  verdict="$(node -p "require('$WORK/$name.json').verdict")"
  local i6d_verdict unexecuted
  i6d_verdict="$(node -p "require('$WORK/$name.json').i6d.verdict")"
  unexecuted="$(node -p "require('$WORK/$name.json').i6d.unexecuted.map(u => u.file + ':' + u.line + ' ' + u.source).join('; ')")"
  echo "[$name] audit exit=$rc verdict=$verdict i6d=$i6d_verdict unexecuted=[$unexecuted]"
  if [ "$verdict" != "$want_verdict" ] || [ "$rc" != "$want_exit" ]; then
    echo "[$name] FAIL: expected verdict=$want_verdict exit=$want_exit" >&2
    return 1
  fi
  echo "[$name] PASS"
}

RED_CONTENT='def test_callback_never_runs():
    def on_done(value):
        assert value == 42
    # on_done is defined but never called: its assert never executes.
    assert True


def test_normal():
    assert 1 + 1 == 2
'

GREEN_CONTENT='def test_normal():
    assert 1 + 1 == 2


def test_new_ok():
    assert 2 + 2 == 4
'

run_case RED "$RED_CONTENT" mismatch 1
run_case GREEN "$GREEN_CONTENT" verified 0

echo
echo '=== M3 acceptance demo: PASS ==='
echo 'RED   diff (dead callback assert) -> mismatch, exit 1 (i6d: unexecuted_assertions)'
echo 'GREEN diff (all asserts execute) -> verified, exit 0 (i6d: pass)'
echo 'A never-executed assertion does not count as green.'
