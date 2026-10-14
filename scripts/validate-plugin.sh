#!/bin/sh
# Validates the alex-loop plugin: manifests, version parity, skill
# frontmatter portability, and hook health. Exit 1 on any failure.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN="$ROOT/plugins/alex-loop"
FAIL=0

fail() {
  echo "FAIL: $1" >&2
  FAIL=1
}

# --- JSON manifests parse ---
for f in "$PLUGIN/.claude-plugin/plugin.json" "$PLUGIN/.codex-plugin/plugin.json" \
         "$ROOT/.claude-plugin/marketplace.json" "$ROOT/.agents/plugins/marketplace.json"; do
  [ -f "$f" ] || { fail "missing manifest: $f"; continue; }
  jq -e . "$f" >/dev/null 2>&1 || fail "invalid JSON: $f"
done

# --- Version parity between the two plugin manifests ---
V_CLAUDE=$(jq -r .version "$PLUGIN/.claude-plugin/plugin.json" 2>/dev/null)
V_CODEX=$(jq -r .version "$PLUGIN/.codex-plugin/plugin.json" 2>/dev/null)
[ "$V_CLAUDE" = "$V_CODEX" ] || fail "version mismatch: claude=$V_CLAUDE codex=$V_CODEX"

# --- Marketplace manifests: identity, source paths, version hygiene ---
MP_CLAUDE="$ROOT/.claude-plugin/marketplace.json"
MP_CODEX="$ROOT/.agents/plugins/marketplace.json"
PLUGIN_NAME=$(jq -r .name "$PLUGIN/.claude-plugin/plugin.json" 2>/dev/null)
PLUGIN_DESC=$(jq -r .description "$PLUGIN/.claude-plugin/plugin.json" 2>/dev/null)

# The marketplace manifest version tracks the single plugin it ships
V_MARKET=$(jq -r '.version // .metadata.version // "unset"' "$MP_CLAUDE" 2>/dev/null)
[ "$V_MARKET" = "$V_CLAUDE" ] || fail "marketplace version '$V_MARKET' != plugin version '$V_CLAUDE'"

# A version inside the marketplace entry is silently shadowed by plugin.json
for mp in "$MP_CLAUDE" "$MP_CODEX"; do
  [ -f "$mp" ] || continue
  jq -e '[.plugins[] | select(has("version"))] | length == 0' "$mp" >/dev/null 2>&1 ||
    fail "$(basename "$(dirname "$mp")")/marketplace.json: plugin entry declares 'version' (plugin.json always wins; drop it)"
  entry_name=$(jq -r '.plugins[0].name' "$mp" 2>/dev/null)
  [ "$entry_name" = "$PLUGIN_NAME" ] || fail "$mp: plugin entry name '$entry_name' != plugin.json name '$PLUGIN_NAME'"
done

# Marketplace-relative source paths must resolve to the plugin directory
SRC_CLAUDE=$(jq -r '.plugins[0].source' "$MP_CLAUDE" 2>/dev/null)
[ -d "$ROOT/$SRC_CLAUDE" ] || fail "claude marketplace source '$SRC_CLAUDE' does not resolve to a directory"
SRC_CODEX=$(jq -r '.plugins[0].source.path' "$MP_CODEX" 2>/dev/null)
[ -d "$ROOT/$SRC_CODEX" ] || fail "codex marketplace source '$SRC_CODEX' does not resolve to a directory"

# The catalog description is what users see before install - keep it in sync
MP_DESC=$(jq -r '.plugins[0].description // "unset"' "$MP_CLAUDE" 2>/dev/null)
[ "$MP_DESC" = "$PLUGIN_DESC" ] || fail "claude marketplace entry description differs from plugin.json description"

# --- Skills: frontmatter name matches directory; description has no '->' ---
for skill_dir in "$PLUGIN"/skills/*/; do
  name=$(basename "$skill_dir")
  md="$skill_dir/SKILL.md"
  [ -f "$md" ] || { fail "missing SKILL.md in $name"; continue; }
  fm_name=$(awk -F': *' '/^name:/{print $2; exit}' "$md")
  [ "$fm_name" = "$name" ] || fail "$name: frontmatter name '$fm_name' != directory name"
  if awk '/^description:/{print; exit}' "$md" | grep -q -- '->'; then
    fail "$name: description contains '->' (breaks strict Codex frontmatter validation)"
  fi
  # openai.yaml short_description length (recommended 25-64 chars) - advisory only,
  # description quality wins over the recommended range
  yaml="$skill_dir/agents/openai.yaml"
  if [ -f "$yaml" ]; then
    len=$(grep 'short_description' "$yaml" | sed 's/^[^:]*: *//' | tr -d '"' | awk '{print length}')
    if [ "${len:-0}" -gt 64 ] || [ "${len:-0}" -lt 25 ]; then
      echo "WARN: $name: short_description is $len chars (recommended 25-64)" >&2
    fi
  fi
done

# --- Hook: syntax, executable bit, smoke run produces the index header ---
HOOK="$PLUGIN/hooks/inject-rules.sh"
if [ -f "$HOOK" ]; then
  sh -n "$HOOK" || fail "hook has shell syntax errors"
  [ -x "$HOOK" ] || fail "hook is not executable"
  OUT=$(CLAUDE_PLUGIN_ROOT="$PLUGIN" sh "$HOOK" 2>/dev/null)
  echo "$OUT" | grep -q 'alex-loop-rules' || fail "hook smoke run produced no rules index"
  # every rules/*.md must appear in the index
  for r in "$PLUGIN"/rules/*.md; do
    echo "$OUT" | grep -qF "$(basename "$r")" || fail "hook index misses rule $(basename "$r")"
  done
else
  fail "missing hook: $HOOK"
fi

# --- Context watchdog: syntax, executable bit, offline behavior tests ---
WATCHDOG="$PLUGIN/skills/context-watchdog/scripts/watchdog.sh"
if [ -f "$WATCHDOG" ]; then
  sh -n "$WATCHDOG" || fail "context-watchdog script has shell syntax errors"
  [ -x "$WATCHDOG" ] || fail "context-watchdog script is not executable"
  # Claude Code only: registered through the Claude manifest, never through
  # the hooks file Codex shares
  WD_HOOKS="$PLUGIN/$(jq -r '.hooks // ""' "$PLUGIN/.claude-plugin/plugin.json" 2>/dev/null)"
  jq -e '[.hooks[][] .hooks[] | select(.command | contains("context-watchdog/scripts/watchdog.sh"))] | length > 0' \
    "$WD_HOOKS" >/dev/null 2>&1 || fail "the Claude manifest's hooks file does not register the context-watchdog script"
  if grep -q 'context-watchdog' "$PLUGIN/hooks/hooks.json"; then
    fail "hooks/hooks.json (shared with Codex) must not register context-watchdog hooks"
  fi
  sh "$ROOT/scripts/test-context-watchdog.sh" >/dev/null || fail "context-watchdog tests failed (run scripts/test-context-watchdog.sh)"
else
  fail "missing context-watchdog script: $WATCHDOG"
fi

# --- worktree-add: toolchain checks, shipped bundle, invocation policy ---
WTA_SKILL="$PLUGIN/skills/worktree-add"
WTA_BUNDLE="$WTA_SKILL/scripts/worktree-add.mjs"
WTA_BUNDLE_REL="plugins/alex-loop/skills/worktree-add/scripts/worktree-add.mjs"
# The validator is a development tool: the TypeScript toolchain must be installed
WTA_TOOLCHAIN=1
if ! command -v node >/dev/null 2>&1 || [ ! -d "$ROOT/node_modules" ]; then
  fail "worktree-add: development dependencies missing; run npm ci first"
  WTA_TOOLCHAIN=0
fi
if [ "$WTA_TOOLCHAIN" -eq 1 ]; then
  npm --prefix "$ROOT" run --silent check >&2 ||
    fail "worktree-add type check, lint or tests failed (run npm run check)"
fi
if [ ! -f "$WTA_BUNDLE" ]; then
  fail "worktree-add bundle is missing: $WTA_BUNDLE_REL (run npm run build)"
else
  [ -x "$WTA_BUNDLE" ] || fail "worktree-add bundle is not executable (missing executable bit)"
  [ "$(head -n 1 "$WTA_BUNDLE")" = '#!/usr/bin/env node' ] ||
    fail "worktree-add bundle does not start with #!/usr/bin/env node"
  # A commit from a machine with core.fileMode=false would store 100644
  WTA_INDEX=$(git -C "$ROOT" ls-files -s -- "$WTA_BUNDLE_REL" 2>/dev/null)
  if [ -n "$WTA_INDEX" ]; then
    case "$WTA_INDEX" in
      100755\ *) ;;
      *) fail "worktree-add bundle is not committed as executable (100755)" ;;
    esac
  fi
  if LC_ALL=C grep -q "$(printf '\r')" "$WTA_BUNDLE"; then
    fail "worktree-add bundle has CR line endings; check .gitattributes"
  fi
  if [ "$WTA_TOOLCHAIN" -eq 1 ]; then
    if WTA_TMPD=$(mktemp -d) && [ -n "$WTA_TMPD" ]; then
      if node "$ROOT/scripts/buildWorktreeAdd.ts" "$WTA_TMPD/worktree-add.mjs" >/dev/null; then
        cmp -s "$WTA_TMPD/worktree-add.mjs" "$WTA_BUNDLE" ||
          fail "worktree-add bundle is stale; run npm run build and commit it"
      else
        fail "worktree-add fresh build failed (run npm run build)"
      fi
      rm -rf "$WTA_TMPD"
    else
      fail "worktree-add: cannot create a temporary folder for the fresh build"
    fi
  fi
fi
WTA_EXTRA=$(ls -A "$WTA_SKILL/scripts" 2>/dev/null | grep -vx 'worktree-add.mjs')
[ -z "$WTA_EXTRA" ] ||
  fail "worktree-add scripts folder holds more than worktree-add.mjs: $(printf '%s' "$WTA_EXTRA" | tr '\n' ' ')"
WTA_MD="$WTA_SKILL/SKILL.md"
grep -qx 'disable-model-invocation: true' "$WTA_MD" 2>/dev/null ||
  fail "worktree-add SKILL.md lacks disable-model-invocation: true"
grep -qxF 'allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/skills/worktree-add/scripts/worktree-add.mjs *)' "$WTA_MD" 2>/dev/null ||
  fail "worktree-add SKILL.md lacks the allowed-tools line for scripts/worktree-add.mjs"
WTA_YAML="$WTA_SKILL/agents/openai.yaml"
grep -q 'allow_implicit_invocation: false' "$WTA_YAML" 2>/dev/null ||
  fail "worktree-add agents/openai.yaml lacks allow_implicit_invocation: false"
# Directive comments only: the lint config may mention the word in prose.
# grep exits 1 only when nothing matched; 2 (an unreadable path) must not pass silently
grep -rnE '(//|/\*)[[:space:]]*eslint-(disable|enable)' "$ROOT/src" "$ROOT/tests" \
  "$ROOT/scripts/buildWorktreeAdd.ts" "$ROOT/eslint.config.mjs" >&2
[ $? -eq 1 ] || fail "eslint-disable comments are not allowed in the TypeScript sources (or a checked path is missing)"
WTA_NON_ASCII=$(printf '[^\t -~]')
LC_ALL=C grep -rln "$WTA_NON_ASCII" "$ROOT/src/worktree-add" "$ROOT/tests/worktree-add" \
  "$ROOT/scripts/buildWorktreeAdd.ts" "$ROOT/eslint.config.mjs" "$WTA_MD" "$WTA_YAML" >&2
[ $? -eq 1 ] || fail "worktree-add files hold bytes outside printable ASCII and TAB, or a checked path is missing (see above)"

if [ "$FAIL" -eq 0 ]; then
  echo "OK: all plugin validation checks passed (version $V_CLAUDE)"
else
  exit 1
fi
