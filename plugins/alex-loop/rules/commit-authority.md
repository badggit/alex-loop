<!-- Updated: 2026-07-28 -->

# Commit Authority

Who may commit and push during loop runs — and which instructions govern that.

## Scope — loop runs only

This rule governs commits and pushes made WHILE EXECUTING alex-loop skills (`feature-implement`, `feature-fix`, plan task steps, autonomous chains). It does not reach ordinary work: when the user directly asks to commit or push outside a loop run (or after one has finished) — "commit", "commit and push everything" — that is plain git work. Do it directly: no `feature-git-commit`/`feature-git-branch` skill invocation, no `commitPolicy` lookup; the user's live instruction is the authorization, and the usual general instructions apply.

## The policy

`commitPolicy` has five values: `auto` (default) | `per-task` | `per-wave` | `final` | `manual`.

Resolution order, first match wins:

1. An explicit in-session user instruction ("don't commit anything", "commit but don't push", "commit as you go") — overrides everything for this session.
2. A repo-root instruction-file line carrying `alex-loop commit-policy: <value>` — in `CLAUDE.md` / `AGENTS.md` or their machine-local `CLAUDE.local.md` / `AGENTS.local.md` variants; the whole line, optionally wrapped in an HTML comment (same convention as the autonomous directive): `grep -qsE '^(<!-- *)?alex-loop commit-policy: *(auto|per-task|per-wave|final|manual)( *-->)? *$'`. A quoted or negated mention must not activate it. If a checked-in file and a machine-local file disagree, the machine-local value wins.
3. Neither present → `auto`.

## General "don't commit" prose does NOT govern the loop

A general instruction like "never commit on your own" in a global or project `CLAUDE.md`/`AGENTS.md` addresses the agent's ad-hoc work — it does NOT change loop behavior. Running an alex-loop skill is a deliberate opt-in to a managed process whose commit/push behavior is controlled ONLY by the two levers above: a live in-session instruction, or the `alex-loop commit-policy:` line. To stop the loop from committing and pushing, set `alex-loop commit-policy: manual`. Prose prohibitions elsewhere are intentionally ignored by loop runs — and continue to bind all non-loop work as usual.

## What each value means

- **auto** (default) — the classic self-driving behavior: the loop commits exactly where its skills prescribe (each validated task in `feature-implement` / plan Step 5, the verified fix in `feature-fix`), and the orchestrator may push the run's feature branch at the prescribed points (after a wave validates, at the end of a run).
- **per-task** / **per-wave** / **final** — commits at that granularity; pushing requires an explicit user request.
- **manual** — no commits and no pushes. Work ends with a verified diff plus a proposed commit series (paths + messages) the user can apply or approve.

## Invariants that no policy value relaxes

- Leaf workers NEVER commit and NEVER push, under any policy. The orchestrator is the sole committer and commits serially — one `feature-git-commit` invocation at a time, explicit pathspecs only. This removes shared-index races by construction.
- Only the orchestrator pushes, and only the run's feature branch — never the default branch, never a force-push.
- PR creation always requires explicit confirmation, under every policy.
- Failure gates are never weakened: a failing pre-commit check stops the commit under every policy.
- Loop commits happen through the `feature-git-commit` skill, which owns staging discipline, ignore/secret checks, and message format. (Non-loop commits requested directly by the user do not route through the skill — see Scope.)
