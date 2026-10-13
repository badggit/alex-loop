---
name: feature-config
description: "Interactive configurator for the plugin's repo-level settings. Reviews every recognized alex-loop directive (autonomous mode, commit policy, external-model egress, design-interview depth, context-watchdog auto-enable) with its current value, asks one question per setting with skip and unset options, and writes anchored directive lines into the repo-root instruction file (CLAUDE.md under Claude Code, AGENTS.md under Codex; a machine-local CLAUDE.local.md/AGENTS.local.md is preferred when present). Invoke ONLY when the user explicitly names this skill ('/feature-config', 'use feature-config', 'configure Alex Loop'). Do NOT self-trigger on generic requests like 'turn on autonomous mode' or 'change the commit policy' — handle those as ordinary instruction-file edits unless the user asks for this skill."
---

<!-- Updated: 2026-07-28 -->

## Core principle

The loop is steered by a small set of anchored directive lines in the repo-root instruction file. This skill is the guided way to review and change them: it shows the current value of every recognized setting, asks one question per setting (every question skippable), and writes only whole-line anchored directives that the skills' deterministic greps will actually match. It never invents a directive that nothing consumes.

## Settings registry

The canonical list of repo-level settings. A future directive is added HERE first; a directive not in this table must not be offered or written.

| Setting | Directive line | Values | Default when absent | Consumed by |
|---|---|---|---|---|
| Autonomous mode | `alex-loop: autonomous` | present / absent | interactive — every skill asks at its gates | every alex-loop skill's opt-in check; contract in `feature-panel` |
| Commit policy | `alex-loop commit-policy: <value>` | `auto`, `per-task`, `per-wave`, `final`, `manual` | `auto` | `commit-authority` rule — loop runs only |
| External models | `alex-loop external-models: <providers>` | comma-separated providers (e.g. `openai, google`) or `none` | no standing egress authorization — cross-family seats need an in-session grant | `model-selection` rule's Data egress policy; cross-family seats in `feature-challenge` / `feature-panel` |
| Design questions | `alex-loop design-questions: <value>` | `auto`, `few`, `medium`, `many` | `auto` — adaptive interview depth | `feature-design` interview (a live plain-language hint overrides it; autonomous mode ignores it) |
| Context watchdog auto-enable | `alex-loop context-watchdog: off` | present / absent | absent - `feature-design`, `feature-plan`, `feature-implement` switch the watchdog on for their session | `context-watchdog` hook script (an explicit `/alex-loop:context-watchdog on` still works) |

Directive form: the whole line, bare or HTML-comment-wrapped (`<!-- alex-loop: autonomous -->`), nothing else on it. Detection everywhere in the plugin is an anchored whole-line grep, so a directive embedded in prose is dead — this skill must never produce one.

## Workflow

### Step 1 - Locate the target file

1. Repo root: `git rev-parse --show-toplevel`. Not a git repo → use the current directory and say so.
2. Base file by harness: `CLAUDE.md` when running under Claude Code, `AGENTS.md` under Codex or any other harness.
3. Prefer the machine-local variant: check whether a `.local.md` counterpart exists at the repo root — first the harness-matching one (`CLAUDE.local.md` / `AGENTS.local.md`, typically gitignored), then the other harness's. If one exists, it is the target: decided settings are written there, NOT into the checked-in file. Only when no `.local.md` file exists is the checked-in base file the target. The user can override either way by naming a file explicitly.
4. Never target the global `~/.claude/CLAUDE.md` / `~/.codex/AGENTS.md` — always a repo-root file.
5. Target file missing → plan to create it; announce this in the Step 2 summary, but do not create it until a setting is actually written.

### Step 2 - Read the current state

Detect each registry row in ALL FOUR repo-root files (the skills grep them all):

```bash
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
grep -hsE '^(<!-- *)?alex-loop: *autonomous( *-->)? *$' "$ROOT/CLAUDE.md" "$ROOT/AGENTS.md" "$ROOT/CLAUDE.local.md" "$ROOT/AGENTS.local.md"
grep -hsE '^(<!-- *)?alex-loop commit-policy: *(auto|per-task|per-wave|final|manual)( *-->)? *$' "$ROOT/CLAUDE.md" "$ROOT/AGENTS.md" "$ROOT/CLAUDE.local.md" "$ROOT/AGENTS.local.md"
grep -hsE '^(<!-- *)?alex-loop external-models: *[A-Za-z0-9][A-Za-z0-9, _-]*( *-->)? *$' "$ROOT/CLAUDE.md" "$ROOT/AGENTS.md" "$ROOT/CLAUDE.local.md" "$ROOT/AGENTS.local.md"
grep -hsE '^(<!-- *)?alex-loop design-questions: *(auto|few|medium|many)( *-->)? *$' "$ROOT/CLAUDE.md" "$ROOT/AGENTS.md" "$ROOT/CLAUDE.local.md" "$ROOT/AGENTS.local.md"
grep -hsE '^(<!-- *)?alex-loop context-watchdog: *off( *-->)? *$' "$ROOT/CLAUDE.md" "$ROOT/AGENTS.md" "$ROOT/CLAUDE.local.md" "$ROOT/AGENTS.local.md"
```

Show a one-block summary before asking anything: each setting, its current effective value (or "not set — default: X"), and which file carries it.

Anomalies to surface in the same block:

- **Files disagree** on a setting (e.g. `CLAUDE.md` says `manual`, `CLAUDE.local.md` says `auto`). A machine-local `.local.md` value overrides a checked-in one; a `CLAUDE.md` vs `AGENTS.md` split is genuinely ambiguous. Surface the conflict either way — resolving it becomes the first question.
- **A near-miss line** the anchored grep does NOT match (prose mention, trailing text on the line, unknown value). Point at it, explain it is inert, and offer to normalize or remove it.
- A directive present only in the OTHER harness's file — it still works (all four files are grepped); just note where it lives.

### Step 3 - Interview

Follow the session-injected `asking-questions` rule: use `AskUserQuestion` or the host harness's equivalent, one setting per question, recommendation first, at most 4 questions per call. Every question carries:

- the current effective value, marked as such;
- a **Skip** option — leave the setting exactly as it is (always present; skipping every question ends the run with no changes);
- an **Unset** option whenever the directive is currently present — remove the line and return to the default.

Question shapes:

1. **Autonomous mode** — keep current (recommended unless the user asked to change it) / switch on / switch off (unset) / skip.
2. **Commit policy** — coarse choice first: `auto` / `manual` / narrower granularity / skip-or-unset. If "narrower granularity" is picked, follow up with `per-task` / `per-wave` / `final`. Five values plus skip exceed one question's option budget — split it, one concern per question.
3. **External models** — `none` (explicitly forbid egress) / a provider allowlist (offer the common ones, free-text for others) / unset (no standing authorization; in-session grants remain possible) / skip.
4. **Design questions** — coarse choice first: `auto` / a fixed level / skip-or-unset. If "a fixed level" is picked, follow up with `few` / `medium` / `many`. Same split rationale as commit policy.
5. **Context watchdog auto-enable** - keep current (recommended) / opt out (`off`: the loop skills stop switching it on) / unset (back to auto-enable) / skip. Session-level `on` / `off` is not a repo setting - point the user at `/alex-loop:context-watchdog` for that.

Recommendations are grounded in state: keep what is already set; for unset settings recommend the default unless the user's request indicates otherwise. Never recommend enabling `autonomous` or an egress allowlist cold — both widen what the loop may do without asking, so the user must reach for them.

### Step 4 - Apply

Touch only the settings the user actually decided — a skipped setting's lines are untouched, byte for byte.

- **Change an existing directive** — edit that line in place, in whichever file carries it, preserving its form (bare stays bare, comment-wrapped stays comment-wrapped).
- **Set a new directive** — write it in HTML-comment form (`<!-- alex-loop commit-policy: manual -->`) so rendered markdown stays clean. Placement is the Step 1 target: the `.local.md` variant when one exists, the checked-in file otherwise; write to the checked-in file despite an existing `.local.md` only when the user explicitly asked for a committed setting. Keep all alex-loop directives in one contiguous block: adjacent to an existing directive if one exists, otherwise a new block at the end of the target file, preceded by a blank line.
- **Unset** — delete the directive line (from every file that carries it), and only the line.
- **Conflict resolution** (from Step 2) — make the files agree: the chosen value stays in the file the user picked, every contradicting line is removed.
- Target file missing → create it containing only the directive block.

Never write a directive with prose on the same line, never write a value outside the registry, never touch any other content in the instruction file.

### Step 5 - Verify and report

1. Re-run the Step 2 greps: every written setting must now match its anchored pattern, every unset one must no longer match. A written line that fails its own grep is a defect in the edit — fix it before reporting.
2. Show `git diff -- <files>` (or the new file's full content) so the user sees exactly what changed.
3. Report the final state of all registry settings, including the skipped ones, and remind the user the change is uncommitted — committing the instruction file is their call (a `.local.md` target is typically gitignored, so there is usually nothing to commit).

## What this skill will not do

- Commit or push anything.
- Edit global instruction files (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`).
- Write a directive absent from the Settings registry, or a value outside a setting's list.
- Rewrite, reorder, or reformat any other content in the instruction file.
- Apply a setting the user skipped.

## Autonomous mode (feature-panel)

This skill is inherently interactive — the questions ARE the task. The `alex-loop: autonomous` directive does not silence them, no alex-loop skill invokes this one at a gate, and a council must never answer a configuration question: every setting change requires the user's explicit choice in this session. Its one autonomy-adjacent duty runs the other way: it is the recommended path for granting or revoking the autonomy directive itself.
