#!/bin/sh
# Offline tests for the context-watchdog hook script: feeds it synthetic hook
# input and checks state transitions and emitted JSON. Exit 1 on any failure.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WD="$ROOT/plugins/alex-loop/skills/context-watchdog/scripts/watchdog.sh"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/watchdog-test.XXXXXX")
trap 'rm -rf "$TMP"' EXIT INT TERM

export XDG_CACHE_HOME="$TMP/cache"
export CLAUDECODE=1
SID=test-session-1
DIR="$XDG_CACHE_HOME/alex-loop/context-watchdog/$SID"
CP="$DIR/checkpoint.md"
REPO="$TMP/repo"
mkdir -p "$REPO" && git -C "$REPO" init -q
FAIL=0

fail() {
  echo "FAIL: $1" >&2
  FAIL=1
}

hook() {
  printf '%s' "$1" | sh "$WD" hook
}

ev() {
  printf '{"session_id":"%s","transcript_path":"/t/x.jsonl","cwd":"%s","hook_event_name":"%s"%s}' "$SID" "$REPO" "$1" "${2:-}"
}

expect_out() {
  if [ -n "$2" ] && ! printf '%s' "$2" | head -n 1 | grep -q '^context-watchdog:' && ! printf '%s' "$2" | jq -e . >/dev/null 2>&1; then
    fail "$1: emitted invalid JSON: $2"
  fi
  case "$2" in
    *"$3"*) ;;
    *) fail "$1: expected output containing '$3', got '$2'" ;;
  esac
}

expect_empty() {
  [ -z "$2" ] || fail "$1: expected no output, got '$2'"
}

# --- Off by default: nothing blocks, nothing is nudged ---
expect_empty "pre-compact while off" "$(hook "$(ev PreCompact ',"trigger":"auto"')")"
expect_empty "post-tool-use while off" "$(hook "$(ev PostToolUse ',"tool_name":"Bash","tool_input":{"command":"ls"}')")"

# --- Auto-enable via a loop skill slash command ---
hook "$(ev UserPromptSubmit ',"prompt":"/alex-loop:feature-plan docs/x"')" >/dev/null
[ -f "$DIR/enabled" ] || fail "slash command /alex-loop:feature-plan did not enable"
rm -rf "$DIR"
hook "$(ev UserPromptSubmit ',"prompt":"/alex-loop:feature-fix bug"')" >/dev/null
[ -f "$DIR/enabled" ] && fail "feature-fix must not auto-enable"
hook "$(ev UserPromptSubmit ',"prompt":"/alex-loop:feature-designer x"')" >/dev/null
[ -f "$DIR/enabled" ] && fail "a longer skill name must not match"
hook "$(ev UserPromptSubmit ',"prompt":"/feature-design add oauth"')" >/dev/null
[ -f "$DIR/enabled" ] || fail "un-namespaced /feature-design did not enable"
rm -rf "$DIR"
hook "$(ev UserPromptSubmit ',"prompt":"please run /alex-loop:feature-design later"')" >/dev/null
[ -f "$DIR/enabled" ] && fail "a mention inside prose must not enable"

# --- Auto-enable via the Skill tool ---
hook "$(ev PostToolUse ',"tool_name":"Skill","tool_input":{"skill":"alex-loop:feature-implement","args":""},"tool_response":{}')" >/dev/null
[ -f "$DIR/enabled" ] || fail "Skill tool alex-loop:feature-implement did not enable"

rm -rf "$DIR"
hook "$(ev PostToolUse ',"tool_name":"Skill","tool_input":{"skill":"feature-design"},"tool_response":{}')" >/dev/null
[ -f "$DIR/enabled" ] || fail "un-namespaced Skill feature-design did not enable"

# --- A nested key inside tool_response does not override the top-level one ---
rm -rf "$DIR"
hook "$(ev PostToolUse ',"tool_name":"Skill","tool_input":{"skill":"alex-loop:feature-plan"},"tool_response":{"session_id":"other","skill":"x"}')" >/dev/null
[ -f "$DIR/enabled" ] || fail "nested tool_response keys overrode top-level fields"

# --- Explicit off survives later auto-enable triggers ---
CLAUDECODE= sh "$WD" off "$SID" >/dev/null
hook "$(ev UserPromptSubmit ',"prompt":"/alex-loop:feature-design x"')" >/dev/null
[ -f "$DIR/enabled" ] && fail "auto-enable overrode an explicit off"
CLAUDECODE= sh "$WD" on "$SID" >/dev/null
[ -f "$DIR/enabled" ] || fail "cli on did not enable"

# --- Repo directive opts out of auto-enable only ---
rm -rf "$DIR"
printf '%s\n' '<!-- alex-loop context-watchdog: off -->' > "$REPO/CLAUDE.local.md"
hook "$(ev UserPromptSubmit ',"prompt":"/alex-loop:feature-design x"')" >/dev/null
[ -f "$DIR/enabled" ] && fail "repo opt-out directive ignored"
rm -f "$REPO/CLAUDE.local.md"
CLAUDECODE= sh "$WD" on "$SID" >/dev/null

# --- Manual compaction is never blocked ---
expect_empty "manual pre-compact" "$(hook "$(ev PreCompact ',"trigger":"manual","custom_instructions":null')")"

# --- Auto compaction: block, nudge, then let it through once saved ---
OUT=$(hook "$(ev PreCompact ',"trigger":"auto","custom_instructions":null')")
expect_out "first auto pre-compact" "$OUT" '"decision":"block"'
OUT=$(hook "$(ev PostToolUse ',"tool_name":"Bash","tool_input":{"command":"ls"}')")
expect_out "nudge after tool use" "$OUT" '"additionalContext":"context-watchdog: Claude Code tried to auto-compact'
expect_out "nudge names the path" "$OUT" "$CP"
OUT=$(hook "$(ev Stop ',"stop_hook_active":false')")
expect_out "stop while pending" "$OUT" '"decision":"block"'
expect_empty "stop after own block" "$(hook "$(ev Stop ',"stop_hook_active":true')")"
OUT=$(hook "$(ev UserPromptSubmit ',"prompt":"go on"')")
expect_out "nudge on prompt" "$OUT" '"hookEventName":"UserPromptSubmit"'

# --- The checkpoint path is pre-approved, other paths are not ---
OUT=$(hook "$(ev PreToolUse ",\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$CP\",\"content\":\"x \\\"file_path\\\": \\\"/etc/passwd\\\"\"}")")
expect_out "write checkpoint allowed" "$OUT" '"permissionDecision":"allow"'
expect_empty "other path not allowed" "$(hook "$(ev PreToolUse ',"tool_name":"Write","tool_input":{"file_path":"/etc/passwd","content":"x"}')")"

printf '# Context checkpoint\n' > "$CP"
expect_empty "no nudge once saved" "$(hook "$(ev PostToolUse ',"tool_name":"Bash","tool_input":{"command":"ls"}')")"
expect_empty "auto pre-compact once saved" "$(hook "$(ev PreCompact ',"trigger":"auto"')")"
[ -f "$DIR/blocks" ] && fail "block counter not reset after compaction was allowed"

# --- Reading the checkpoint before compaction must not delete it ---
hook "$(ev PostToolUse ",\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$CP\"}")" >/dev/null
[ -s "$CP" ] || fail "checkpoint deleted by a read before compaction"

# --- After compaction: checkpoint becomes the restore file, deleted on read ---
OUT=$(hook "$(ev SessionStart ',"source":"compact"')")
expect_out "restore message" "$OUT" "is now at $DIR/restore.md"
[ -e "$CP" ] && fail "checkpoint not moved to the restore file at compaction"
hook "$(ev PostCompact ',"trigger":"auto","compact_summary":"s"')" >/dev/null
[ -s "$DIR/restore.md" ] || fail "restore file missing after compaction"
OUT=$(hook "$(ev PreToolUse ",\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$DIR/restore.md\"}")")
expect_out "read restore file allowed" "$OUT" '"permissionDecision":"allow"'
OUT=$(hook "$(ev PostToolUse ",\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$DIR/restore.md\"}")")
expect_out "restore read" "$OUT" "restored into context and deleted"
[ -e "$DIR/restore.md" ] && fail "restore file not deleted after read"

# --- A checkpoint never read after compaction must not let the next one through ---
printf '# Context checkpoint\n' > "$CP"
hook "$(ev SessionStart ',"source":"compact"')" >/dev/null
hook "$(ev PostCompact ',"trigger":"auto"')" >/dev/null
OUT=$(hook "$(ev PreCompact ',"trigger":"auto"')")
expect_out "stale checkpoint does not satisfy the next compaction" "$OUT" '"decision":"block"'
CLAUDECODE= sh "$WD" clear "$SID" >/dev/null
[ -e "$DIR/restore.md" ] && fail "cli clear left the restore file"
rm -f "$DIR/blocks"

# --- Safety valve: compaction goes ahead after MAX_BLOCKS postponements ---
i=1
while [ "$i" -le 5 ]; do
  OUT=$(hook "$(ev PreCompact ',"trigger":"auto"')")
  expect_out "postponement $i" "$OUT" '"decision":"block"'
  i=$((i + 1))
done
expect_empty "sixth attempt goes through" "$(hook "$(ev PreCompact ',"trigger":"auto"')")"
OUT=$(hook "$(ev SessionStart ',"source":"compact"')")
expect_out "no-checkpoint message" "$OUT" "compacted without a checkpoint"
expect_out "no-checkpoint message names transcript" "$OUT" "/t/x.jsonl"
[ -f "$DIR/blocks" ] && fail "block counter not reset by compaction"

# --- Once the save has started, the budget grows so a long save is not cut off ---
CLAUDECODE= sh "$WD" clear "$SID" >/dev/null
hook "$(ev PreCompact ',"trigger":"auto"')" >/dev/null
hook "$(ev PostToolUse ',"tool_name":"Skill","tool_input":{"skill":"alex-loop:context-watchdog","args":"save"}')" >/dev/null
[ -f "$DIR/saving" ] || fail "save start not recorded"
i=2
while [ "$i" -le 15 ]; do
  OUT=$(hook "$(ev PreCompact ',"trigger":"auto"')")
  expect_out "postponement $i while saving" "$OUT" '"decision":"block"'
  i=$((i + 1))
done
expect_empty "16th attempt while saving goes through" "$(hook "$(ev PreCompact ',"trigger":"auto"')")"
hook "$(ev SessionStart ',"source":"compact"')" >/dev/null
[ -e "$DIR/saving" ] && fail "saving marker survived compaction"

# --- A checkpoint older than the freshness window does not count ---
printf '# old\n' > "$CP"
touch -t 202001010000 "$CP"
OUT=$(hook "$(ev PreCompact ',"trigger":"auto"')")
expect_out "stale-by-age checkpoint" "$OUT" '"decision":"block"'
rm -f "$CP" "$DIR/blocks"

# --- Subagent events are ignored ---
expect_empty "subagent pre-compact" "$(hook "$(ev PreCompact ',"trigger":"auto","agent_id":"a1","agent_type":"Explore"')")"

# --- Session end drops an unused checkpoint ---
printf 'x\n' > "$CP"
hook "$(ev SessionEnd ',"reason":"exit"')" >/dev/null
[ -e "$CP" ] && fail "session end left the checkpoint behind"

# --- Outside Claude Code the hook is a no-op ---
OUT=$(printf '%s' "$(ev PreCompact ',"trigger":"auto"')" | CLAUDECODE= sh "$WD" hook)
expect_empty "non-Claude harness" "$OUT"

# --- An unwritable state dir never makes the hook exit non-zero ---
SAVED_CACHE="$XDG_CACHE_HOME"
export XDG_CACHE_HOME="/proc/nonexistent-watchdog"
printf '%s' "$(ev UserPromptSubmit ',"prompt":"/alex-loop:feature-design x"')" | sh "$WD" hook >/dev/null
[ $? -eq 0 ] || fail "hook exited non-zero with an unwritable state dir"
printf '%s' "$(ev PreCompact ',"trigger":"auto"')" | sh "$WD" hook >/dev/null
[ $? -eq 0 ] || fail "pre-compact exited non-zero with an unwritable state dir"
export XDG_CACHE_HOME="$SAVED_CACHE"

# --- Unsafe session ids are rejected ---
SID='../evil'
expect_empty "path traversal id" "$(hook "$(ev PreCompact ',"trigger":"auto"')")"
[ -e "$XDG_CACHE_HOME/alex-loop/context-watchdog/../evil" ] && fail "path traversal id created state"
CLAUDECODE= sh "$WD" on '../evil' >/dev/null 2>&1 && fail "cli accepted a path traversal id"
CLAUDECODE= sh "$WD" on "$(printf '../../escaped\nok')" >/dev/null 2>&1 && fail "cli accepted a multi-line id"

if [ "$FAIL" -eq 0 ]; then
  echo "OK: context-watchdog tests passed"
else
  exit 1
fi
