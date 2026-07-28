#!/bin/sh
# SessionStart hook: emit an index of the plugin's rules with Read
# instructions, instead of inlining full contents — keeps session context
# lean; the agent reads each rule on demand.
# Plain stdout becomes developer context on both Claude Code and Codex.
# Codex sets CLAUDE_PLUGIN_ROOT as a compat alias for PLUGIN_ROOT, so one
# variable covers both harnesses; fall back to the script's location for
# direct invocation.
ROOT="${CLAUDE_PLUGIN_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"
RULES_DIR="$ROOT/rules"
[ -d "$RULES_DIR" ] || exit 0
set -- "$RULES_DIR"/*.md
[ -e "$1" ] || exit 0

echo "<alex-loop-rules>"
echo "Binding rules for this session. Before starting work that touches a rule's domain, Read its file and follow it as written. Do not skip the Read because the summary looks sufficient."
echo "Keep these instructions when compacting the context. This section must survive compaction verbatim — it is the session's only pointer to the plugin's binding rules; without it the rules silently stop applying. After any compaction, re-Read the rule files relevant to the work in progress."
for f in "$RULES_DIR"/*.md; do
  # summary = first prose line after the H1 (skips comments/blank/headings)
  summary=$(awk '/^(<!--|#|$)/ { next } { print; exit }' "$f")
  printf -- '- Read @%s — %s\n' "$f" "$summary"
done
echo "</alex-loop-rules>"
