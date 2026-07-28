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

# The catalog description is what users see before install — keep it in sync
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
  # openai.yaml short_description length (recommended 25-64 chars) — advisory only,
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

if [ "$FAIL" -eq 0 ]; then
  echo "OK: all plugin validation checks passed (version $V_CLAUDE)"
else
  exit 1
fi
