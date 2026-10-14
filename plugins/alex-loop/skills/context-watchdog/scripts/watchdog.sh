#!/bin/sh
# Context watchdog: postpones auto-compaction until the agent has written a
# checkpoint, then hands the checkpoint back after compaction.
#
#   watchdog.sh hook                                - hook entry point, JSON on stdin
#   watchdog.sh on|off|status|path|clear <session-id>
#
# Claude Code only: registered from .claude-plugin/plugin.json, never from the
# hooks file Codex shares, and the hook path is a silent no-op outside Claude
# Code as a second fence.
# Pure POSIX sh with no jq dependency: hook input is matched with grep/sed.
# A "key": pair can only be a real key, because quotes inside JSON string
# values are always escaped.

# Postponements before the agent starts saving, then the total once it has
MAX_BLOCKS=5
MAX_BLOCKS_SAVING=15
# A checkpoint older than this no longer counts as saved for the next compaction
CHECKPOINT_MAX_AGE_MIN=30
LOOP_SKILL_NAMES='feature-(design|plan|implement)'

# Deliberately outside ~/.claude: Claude Code treats writes there as
# sensitive and refuses them even when a PreToolUse hook allows the write
state_base() {
  printf '%s/alex-loop/context-watchdog' "${XDG_CACHE_HOME:-$HOME/.cache}"
}

valid_session() {
  case "$1" in
    '' | *[!A-Za-z0-9_-]*) return 1 ;;
  esac
  return 0
}

# String value of the first "key": "value" pair in the hook input. Common
# fields and tool_input precede tool_response, so the first match is the
# top-level or tool_input value. Values with JSON escapes yield nothing.
field() {
  printf '%s' "$IN" | grep -o "\"$1\" *: *\"[^\"\\\\]*\"" | head -n 1 | sed 's/.*: *"//; s/"$//'
}

has_key() {
  printf '%s' "$IN" | grep -qE "\"$1\" *:"
}

json_escape() {
  printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

emit_context() {
  printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"%s"}}\n' "$1" "$(json_escape "$2")"
}

emit_block() {
  printf '{"decision":"block","reason":"%s"}\n' "$(json_escape "$1")"
}

ensure_dir() {
  mkdir -p "$DIR" 2>/dev/null || return 1
  chmod 700 "$BASE" "$DIR" 2>/dev/null
  return 0
}

is_enabled() {
  [ -f "$DIR/enabled" ]
}

has_fresh_checkpoint() {
  [ -s "$CHECKPOINT" ] && [ -n "$(find "$CHECKPOINT" -mmin "-$CHECKPOINT_MAX_AGE_MIN" 2>/dev/null)" ]
}

is_pending() {
  [ -f "$DIR/blocks" ] && ! has_fresh_checkpoint
}

# At compaction the checkpoint becomes the restore file, so it can never let
# a later compaction through (Claude Code re-attaches recently written files
# after compaction, so the agent may never Read it explicitly)
take_checkpoint() {
  rm -f "$DIR/blocks" "$DIR/saving"
  if [ -s "$CHECKPOINT" ]; then
    mv -f "$CHECKPOINT" "$RESTORE"
  fi
  return 0
}

# Repo-level opt-out of the automatic enable by the loop skills
repo_opted_out() {
  cwd=$(field cwd)
  root=$(git -C "${cwd:-.}" rev-parse --show-toplevel 2>/dev/null) || return 1
  grep -qsE '^(<!-- *)?alex-loop context-watchdog: *off( *-->)? *$' \
    "$root/CLAUDE.md" "$root/AGENTS.md" "$root/CLAUDE.local.md" "$root/AGENTS.local.md"
}

prune_old_sessions() {
  [ -d "$BASE" ] && find "$BASE" -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} + 2>/dev/null
  return 0
}

enable() {
  ensure_dir || return 1
  rm -f "$DIR/disabled"
  touch "$DIR/enabled" || return 1
  prune_old_sessions
}

# Loop skills switch the watchdog on unless the user switched it off for this
# session or the repo opted out
auto_enable() {
  is_enabled && return 0
  [ -f "$DIR/disabled" ] && return 0
  repo_opted_out && return 0
  enable
}

nudge_text() {
  n=$(cat "$DIR/blocks" 2>/dev/null)
  printf '%s' "context-watchdog: Claude Code tried to auto-compact this conversation and the watchdog postponed it (attempt ${n:-1}) so a checkpoint can be saved first. Before continuing the task, invoke the alex-loop:context-watchdog skill with argument save and write the checkpoint to $CHECKPOINT. Keep the save lean - batch status updates into parallel tool calls - and avoid large reads and high-output commands until it is saved. Compaction goes ahead on its own once the file exists, and the checkpoint is handed back for restore right after it."
}

on_pre_compact() {
  is_enabled || return 0
  [ "$(field trigger)" = auto ] || return 0
  if has_fresh_checkpoint; then
    rm -f "$DIR/blocks" "$DIR/saving"
    return 0
  fi
  n=$(cat "$DIR/blocks" 2>/dev/null)
  n=$(( ${n:-0} + 1 ))
  max=$MAX_BLOCKS
  [ -f "$DIR/saving" ] && max=$MAX_BLOCKS_SAVING
  # Safety valve: never hold compaction off indefinitely, the context could
  # hit the hard model limit and fail the request
  [ "$n" -le "$max" ] || return 0
  printf '%s\n' "$n" > "$DIR/blocks" || return 0
  emit_block "context-watchdog: checkpoint not saved yet (attempt $n of up to $max)"
}

on_session_start() {
  [ "$(field source)" = compact ] || return 0
  take_checkpoint
  transcript=$(field transcript_path)
  if [ -s "$RESTORE" ]; then
    echo "context-watchdog: the conversation was just compacted. The checkpoint written before compaction is now at $RESTORE. Before doing anything else, invoke the alex-loop:context-watchdog skill with argument restore and follow it: Read that file in full even if its content already appears attached above (the Read is what lets the watchdog delete it), reconcile it with the summary, then continue the task where it stopped. The watchdog deletes the file once you have read it. Full pre-compaction transcript, to search only if something is still missing: $transcript"
  elif is_enabled; then
    echo "context-watchdog: the conversation was compacted without a checkpoint (none was saved in time). If the summary leaves gaps, the full pre-compaction transcript is at $transcript - search it (grep) for the user's exact wording and decisions instead of reading it whole."
  fi
}

on_pre_tool_use() {
  path=$(field file_path)
  [ "$path" = "$CHECKPOINT" ] || [ "$path" = "$RESTORE" ] || return 0
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"context-watchdog checkpoint file"}}\n'
}

on_post_tool_use() {
  tool=$(field tool_name)
  if [ "$tool" = Skill ]; then
    skill=$(field skill)
    if printf '%s' "$skill" | grep -qE "^(alex-loop:)?$LOOP_SKILL_NAMES\$"; then
      auto_enable
    elif printf '%s' "$skill" | grep -qE '^(alex-loop:)?context-watchdog$' && is_pending; then
      touch "$DIR/saving"
    fi
  fi
  if [ "$tool" = Read ] && [ -f "$RESTORE" ] && [ "$(field file_path)" = "$RESTORE" ]; then
    rm -f "$RESTORE"
    emit_context PostToolUse "context-watchdog: checkpoint restored into context and deleted from disk."
    return 0
  fi
  if is_enabled && is_pending; then
    emit_context PostToolUse "$(nudge_text)"
  fi
}

on_user_prompt_submit() {
  # Keeps the session directory's mtime fresh for pruning
  [ -d "$DIR" ] && touch "$DIR"
  # Slash commands may drop the plugin namespace when the name is unambiguous
  if printf '%s' "$IN" | grep -qE "\"prompt\" *: *\" */(alex-loop:)?$LOOP_SKILL_NAMES([^a-z-]|\$)"; then
    auto_enable
  fi
  if is_enabled && is_pending; then
    emit_context UserPromptSubmit "$(nudge_text)"
  fi
}

on_stop() {
  # stop_hook_active: this stop already follows a block of ours, let it end
  printf '%s' "$IN" | grep -qE '"stop_hook_active" *: *true' && return 0
  if is_enabled && is_pending; then
    emit_block "$(nudge_text)"
  fi
}

on_session_end() {
  # A checkpoint never consumed by a compaction is stale once the session ends
  rm -f "$CHECKPOINT" "$RESTORE" "$DIR/blocks" "$DIR/saving"
}

dispatch_hook() {
  IN=$(cat)
  sid=$(field session_id)
  valid_session "$sid" || return 0
  # Subagents compact and call tools on their own; only the main
  # conversation owns the checkpoint
  has_key agent_id && return 0
  BASE=$(state_base)
  DIR="$BASE/$sid"
  CHECKPOINT="$DIR/checkpoint.md"
  RESTORE="$DIR/restore.md"
  case "$(field hook_event_name)" in
    PreCompact) on_pre_compact ;;
    PostCompact) take_checkpoint ;;
    SessionStart) on_session_start ;;
    PreToolUse) on_pre_tool_use ;;
    PostToolUse) on_post_tool_use ;;
    UserPromptSubmit) on_user_prompt_submit ;;
    Stop) on_stop ;;
    SessionEnd) on_session_end ;;
  esac
}

run_hook() {
  [ "${CLAUDECODE:-}" = 1 ] || exit 0
  # Subshell plus forced exit 0: a shell error must never turn into exit 2,
  # which would block compaction or swallow the user's prompt
  ( dispatch_hook ) 2>/dev/null
  exit 0
}

run_cli() {
  cmd="$1"
  sid="${2:-}"
  if ! valid_session "$sid"; then
    echo "context-watchdog: missing or invalid session id (expected the current Claude Code session id)" >&2
    exit 2
  fi
  BASE=$(state_base)
  DIR="$BASE/$sid"
  CHECKPOINT="$DIR/checkpoint.md"
  RESTORE="$DIR/restore.md"
  case "$cmd" in
    on)
      enable || { echo "context-watchdog: cannot write state under $BASE" >&2; exit 1; }
      echo "context-watchdog: ON for session $sid"
      ;;
    off)
      ensure_dir || { echo "context-watchdog: cannot write state under $BASE" >&2; exit 1; }
      rm -f "$DIR/enabled" "$DIR/blocks" "$DIR/saving"
      touch "$DIR/disabled"
      echo "context-watchdog: OFF for session $sid"
      ;;
    status)
      if is_enabled; then echo "context-watchdog: ON for session $sid"; else echo "context-watchdog: OFF for session $sid"; fi
      if [ -s "$CHECKPOINT" ]; then echo "checkpoint: $CHECKPOINT (saved, waiting for compaction)"; else echo "checkpoint: none"; fi
      [ -f "$DIR/blocks" ] && echo "postponed auto-compact attempts: $(cat "$DIR/blocks")"
      [ -f "$RESTORE" ] && echo "restore pending: $RESTORE (read it to finish)"
      ;;
    path)
      ensure_dir || { echo "context-watchdog: cannot write state under $BASE" >&2; exit 1; }
      echo "$CHECKPOINT"
      ;;
    clear)
      rm -f "$CHECKPOINT" "$RESTORE"
      echo "context-watchdog: checkpoint cleared"
      ;;
    *)
      echo "usage: watchdog.sh hook | watchdog.sh on|off|status|path|clear <session-id>" >&2
      exit 2
      ;;
  esac
}

case "${1:-}" in
  hook) run_hook ;;
  *) run_cli "$@" ;;
esac
