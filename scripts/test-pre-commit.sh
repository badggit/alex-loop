#!/bin/sh
# Offline tests for .githooks/pre-commit: commits in a throwaway copy of the
# worktree-add sources and checks which commits the hook lets through.
# Needs node_modules (npm ci). Exit 1 on any failure.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE=plugins/alex-loop/skills/worktree-add/scripts/worktree-add.mjs
TMP=$(mktemp -d "${TMPDIR:-/tmp}/pre-commit-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT INT TERM

REPO="$TMP/repo"
FAIL=0

fail() {
  echo "FAIL: $1" >&2
  FAIL=1
}

g() {
  git -C "$REPO" -c user.name=test -c user.email=test@example.invalid -c core.hooksPath=.githooks "$@"
}

# Commits quietly; the hook's stderr goes to $TMP/err for message checks
try_commit() {
  g commit -q -m "$1" >/dev/null 2>"$TMP/err"
}

mkdir -p "$REPO/scripts" "$REPO/src" "$REPO/$(dirname "$BUNDLE")" "$REPO/.githooks"
cp -R "$ROOT/src/worktree-add" "$REPO/src/"
cp "$ROOT/scripts/buildWorktreeAdd.ts" "$REPO/scripts/"
cp "$ROOT/tsconfig.json" "$ROOT/package.json" "$ROOT/package-lock.json" "$REPO/"
cp "$ROOT/.githooks/pre-commit" "$REPO/.githooks/"
ln -s "$ROOT/node_modules" "$REPO/node_modules"
printf 'node_modules\n' >"$REPO/.gitignore"
git -C "$REPO" init -q
# A fresh build of the copied sources, so the tests do not depend on the
# committed bundle being current
node "$REPO/scripts/buildWorktreeAdd.ts" >/dev/null || fail "initial build failed"
g add -A && g commit -q --no-verify -m init || fail "initial commit failed"

echo note >"$REPO/notes.txt"
g add notes.txt
try_commit unrelated || fail "an unrelated commit was blocked"

SRC="$REPO/src/worktree-add/cli.ts"
printf '\nconsole.log("changed");\n' >>"$SRC"
g add src
if try_commit stale; then
  fail "a source change without a rebuilt bundle was committed"
fi
grep -q 'npm run build' "$TMP/err" || fail "the stale-bundle message does not name npm run build"

node "$REPO/scripts/buildWorktreeAdd.ts" >/dev/null || fail "rebuild failed"
g add "$BUNDLE"
# Unstaged edits must not affect the check: it builds from the index
printf '\nconsole.log("unstaged");\n' >>"$SRC"
try_commit fresh || fail "a source change with a matching staged bundle was blocked"

g add src
if try_commit stale-again; then
  fail "a staged source change was committed while the staged bundle came from older sources"
fi

[ "$FAIL" -eq 0 ] && echo "OK: pre-commit tests passed"
exit "$FAIL"
