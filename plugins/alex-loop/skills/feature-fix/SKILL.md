---
name: feature-fix
description: "Fast path for scoped changes with a KNOWN intended end-state — bug fixes, regressions, chores, small tweaks — that do NOT need a design decision. Reproduce, root-cause, minimal fix, verify; commits are policy-gated; no design or plan phase. Invoke ONLY when the user explicitly names this skill ('/feature-fix', 'use feature-fix') or when feature-design routes a bug-shaped request here. Do NOT self-trigger on generic requests like 'fix this bug' or 'X is broken' — handle those as ordinary debugging unless the user asks for this skill."
argument-hint: "<bug report or scoped change request>"
---

<!-- Updated: 2026-07-12 12:05:33 UTC -->

**Announce at start:** "Using skill: **Feature Fix** to reproduce, root-cause, and land a minimal verified fix."

# Feature Fix

## Delegation Boundary

Only the user-facing top-level agent may execute this skill's investigation, verification, or panel dispatch steps. Every dispatched prompt must say: **"You are a leaf worker. Do not call Agent, Task, Workflow, spawn_agent, or any equivalent delegation/subagent tool. Do the assigned work yourself and return to the parent. If you need further fan-out, return `NEEDS_PARENT_FANOUT` with the proposed independent work items; do not delegate them yourself."** If this skill is being followed inside an already spawned worker, that worker must not dispatch; it completes its assigned non-delegating scope itself or returns `NEEDS_PARENT_FANOUT` with proposed work items.

The scoped-change path. The intended end-state is already known, so there is no design or plan phase — restore intended behavior (or make a mechanical change) with the smallest correct diff, proven by a check that was red before and green after.

**This skill restores intended behavior; it never decides new behavior.** When the correct behavior is itself the question — the "bug" is a contested or unspecified spec, or the fix forces a choice between viable alternatives — that is a design decision. Route to `feature-design` (Step 1, and the 3-strike rule).

**Adversarial stance:** a fixer is an optimizer — it will patch the symptom, weaken a test, or declare success by the cheapest path. The gates below (red check before fix, root-cause before edit, full-suite + integrity verify) fence that. Do not skip them because the fix "looks obvious." Known cheat patterns and fences: [feature-implement/references/implementation-cheats.md](../feature-implement/references/implementation-cheats.md).

**Branch discipline.** Before editing any code, confirm you are on a feature branch — not the repository's default branch (detect via `git symbolic-ref --short refs/remotes/origin/HEAD`, falling back to the `main` / `master` / `develop` guess list). If you are on the default branch, invoke the `feature-git-branch` skill first. Never edit or commit a fix on the default branch. Commits go through the `feature-git-commit` skill (Step 6), which stages by explicit path — a fix never sweeps unrelated dirty files into its commit. When Step 6 commits is governed by the session-injected `commit-authority` rule: the default `auto` policy commits the verified fix as written below; a `alex-loop commit-policy: manual` line (or a live user instruction) turns Step 6 into a verified diff plus a proposed commit instead.

**Artifact root.** All `docs/alex-loop/` paths in this skill resolve against an artifact root: when a `docs.local/` folder already exists at the repo root, artifacts live under `docs.local/alex-loop/` instead — create the `alex-loop/` subfolder there if missing. Otherwise use `docs/alex-loop/` — create `docs/` and `docs/alex-loop/` if missing. NEVER create `docs.local/` itself: its pre-existence is the opt-in. When locating existing artifacts, check both roots.

**Attempt hygiene.** Before the first edit of each fix attempt, snapshot your starting point (`git diff > <scratch>/attempt-N.patch` plus the list of files you are about to touch). A failed attempt is rolled back by restoring exactly those files — never by a blanket revert of the working tree, which cannot distinguish your edits from the user's parallel work.

## Autonomous mode (feature-panel)

FIRST run the repo-root opt-in check — `grep -qsE '^(<!-- *)?alex-loop: *autonomous( *-->)? *$' "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/CLAUDE.md" "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/AGENTS.md" "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/CLAUDE.local.md" "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/AGENTS.local.md" && echo ON` (anchored whole-line match — a quoted, negated, or prose mention must NOT activate the mode; the repo-root files — `CLAUDE.md`/`AGENTS.md` plus their machine-local `CLAUDE.local.md`/`AGENTS.local.md` variants — never the global). If it prints ON, follow the `feature-panel` skill's **Autonomous mode** contract; otherwise behave as written below. In autonomous mode: resolve the classify/escalate decision (Step 1) and any `[JUDGMENT]` call via the **Decision protocol** (council + independent-model seat) instead of asking; run the Step 5 verify gate through a review panel; surface only on hard escalation (signing, missing credentials, or a genuine design decision that expands scope beyond a fix).

## Step 1: Triage & Classify

The front-door decision — is this skill the right home?

1. **State the known end-state.** In one line, say what "fixed" means: the intended behavior being restored, or the mechanical change requested. If you cannot state it without choosing between viable alternatives, this is a design decision — STOP and hand to `feature-design`.
2. **Establish the intended behavior.** A bug is reality diverging from *intended* behavior, so you cannot classify or fix one until you know what was intended. Take the richest source available — this step is never skipped, only its source changes:
   - **Loop artifacts first.** If `docs/alex-loop/` holds a design, plan, or challenge for the affected area, read the relevant parts — they are the spec, they answer "was this ever meant to work this way?", and they record the assumptions the defect may have violated. Check the design's `Status:` header before trusting it: a `superseded` design is history, not spec; an amended one may postdate the code.
   - **Prior fix records too.** Grep `docs.local/alex-loop/*/[0-9][0-9]-fix.md` and `docs/alex-loop/*/[0-9][0-9]-fix.md` for the affected subsystem or a matching symptom. A hit may mean this is a RECURRENCE — read the record; the prior fix's root cause becomes Step 3's first hypothesis, and a recurrence of a "fixed" bug is itself evidence the prior fix was symptomatic.
   - **No such docs → read the code for the same signal.** Derive intended behavior from tests and their assertions, type signatures, docstrings and comments, adjacent call sites, and recent commit/PR history. Missing loop docs mean no doc-based shortcut — NOT "skip establishing intent." Go find the evidence in the codebase yourself.
3. **Classify the defect** and record it in one line:
   - **Logic error / regression** — code contradicts its own intended behavior → fix here, red-test-first (Step 2 default path).
   - **Mechanical change** — rename, value bump, config tweak with a known end-state and no behavioral question → fix here, but Step 2 takes the structural-verification path (an artificially red test for "rename X" proves nothing a before/after check doesn't).
   - **Production incident** — the defect is actively breaking production NOW (confirmed incident, not subjective urgency) → fix here on the inverted order: minimal diagnosis → smallest reversible containment fix → hands-on verification. The Step 2 red regression test is then written IMMEDIATELY AFTER as a mandatory follow-up — the fix is not closed until that test is in the suite. The entry bar is a confirmed incident; "this feels urgent" does not invert the order.
   - **Spec gap / context mismatch / contested behavior** — intended behavior is unspecified or disputed → escalate to `feature-design`; this is not a fix.
4. **Scope check.** If restoring the behavior obviously spans multiple subsystems or needs a coordinated multi-task rollout, it is a feature, not a fix — route to `feature-design` -> `feature-plan`.

Do not touch code until the classification is "logic error" or a mechanical change with a known end-state.

## Step 2: Reproduce — write the failing (red) test

Turn the symptom into a **TDD red test**: a new test in the project's own suite that fails under the *same conditions* as the reported bug and will pass once the behavior is restored. This is the default and strongly preferred path — the test is both the reproduce artifact and the permanent regression guard that stays in the suite after the fix, so the bug cannot silently return.

- **Author the test now, before touching production code.** Assert the *intended* behavior established in Step 1, so red→green traces exactly the bug being fixed.
- Run it and confirm it fails **for the reported reason** — not an unrelated error (wrong import, broken setup, missing fixture). A test that goes red for the wrong reason proves nothing.
- **One-off command only when a test genuinely cannot express the condition** (environment-specific, timing/flaky, data-shaped, external-service-bound): use the tightest runnable command or script that goes red on the symptom, and state why a test was impractical. This is the exception, not the default.
- **Mechanical changes take structural verification instead of a red test:** capture the before state (grep count of the old name, the old value in config), apply, verify the after state (zero hits of the old name / new value present / typecheck clean). Same red→green evidence discipline, honest instrument.
- If the symptom can be neither captured as a failing test nor otherwise made to fail on demand, STOP and report to the user what you tried — do not ship an unprovable change.

## Step 3: Root-Cause — no fix before cause

**No edit to production code until the root cause is identified.** Trace to the original trigger, not the line where the error surfaces.

- Read the code paths the red check exercises. For a non-trivial trace, the top-level agent dispatches ONE leaf investigation subagent with the **Delegation Boundary** clause (keep deep tracing and raw output out of orchestrator context; route effort by difficulty per the `model-selection` rule) that returns the cause plus file:line evidence, not a transcript.
- **For a regression with a known good point, `git bisect` is the fastest locator:** the Step 2 red test is a ready-made predicate for `git bisect run`. The first-bad commit is INPUT to the hypothesis — it shows where, not why; the cause statement below is still required.
- State a **hypothesis** with a **testable prediction**: "if the cause is X, changing Y flips the red check and nothing else." A hypothesis that predicts nothing observable is discarded.
- Keep investigation scratch — probes, logging, instrumentation — OFF the eventual fix commit.

## Step 4: Minimal Fix

The smallest correct change that makes the red check green by addressing the **cause**, not the symptom.

- **One change.** No "while I'm here" cleanups, no bundled refactors, no unrelated improvements. A second concern is a second task.
- **Blast-radius trip-wire.** If the minimal fix starts touching more than a couple of files or crossing a subsystem boundary, stop and re-check Step 1 — a fix that sprawls is usually a mis-classified design change. Escalate to `feature-design` rather than growing the diff.
- Keep the safety carve-outs intact (input validation, error handling, authz, sanitization); minimalism never removes those.

## Step 5: Verify

1. **Red check goes green.** Run the Step 2 check; confirm it passes for the right reason.
2. **Full suite, not a subset.** Run the project's canonical full-suite command. A fix in one path can break another; any new failure in any file is a regression caused by the fix — surface it, do not ship.
3. **Integrity gates (same fences as `feature-implement`).** No weakened or deleted pre-existing assertions, no `.skip` / `.only`, no band-aids (`as any`, `@ts-expect-error`, stub returns, `# type: ignore`) unless independently justified and pre-existing. A green suite from a gamed fix is FAIL.
4. **Same-class sweep.** State the defect's cause PATTERN in one line (the misused API call, the bypassed validation, the copy-pasted bug) and grep the repo for other instances of that pattern. Each hit is either fixed by the same change in this pass, or explicitly listed in the Summary as separate work — never silently left. (This operationalizes the verify-before-completion rule; the blast-radius trip-wire still bounds what this fix itself may touch.)
5. **Conditional verification.** UI-affecting fix → drive the running app and observe the rendered change (typecheck is not evidence for UI). Removed or renamed symbol → grep the repo for zero orphan hits. New architectural path → exercise one real end-to-end path.
6. For a non-trivial fix, the top-level agent dispatches the verify pass as a leaf subagent with the **Delegation Boundary** clause, returning a structured verdict (mirrors `feature-implement`'s wave-validator) so raw suite output stays out of orchestrator context.

## Step 6: Commit & Record

- **Policy gate** (`commit-authority` rule): under the default `auto`, commit right away as below; under `manual` (repo-config line or in-session instruction), present the verified diff and the proposed commit (paths + message) and stop.
- Commit the fix with the `feature-git-commit` skill — surgical diff (the fix plus the Step 2 red test, which now ships as the regression guard), explicit paths, conventional message. The commit body carries the record: symptom, root cause, and how it was verified. **For most fixes this is the only record needed — do not write a separate document.**
- **Fix record (escalation only).** When the fix is complex enough that the commit body cannot hold it — multi-file root cause, a subtle regression, a security-relevant path, or a fix that revised an assumption recorded in a design doc — write a lean `NN-fix.md` in the feature's `docs/alex-loop/YYYY-MM-DD-<topic>/` folder (`NN` = next free prefix among `*-fix.md` files): symptom, root cause, diff summary, verification, and a markdown link to the design or plan it relates to. **Commit this record WITH the fix.** Unlike design, plan, and challenge documents (kept uncommitted for the loop's plan-diffing mechanism), a fix record has no such mechanism and belongs in history as part of the discrete, already-shipping fix.

## The 3-strike rule — escalate, don't thrash

If three structurally different fix attempts fail to make the red check green without breaking the suite, STOP. Three failed fixes signal the cause is architectural or the intended behavior is genuinely unclear — a design problem, not a fixing problem. Before escalating, roll back the failed attempts using the **Attempt hygiene** records: restore exactly the files each attempt touched (from its patch/file list) and remove investigation scratch, so `feature-design` starts from a tree holding only what was there before — NEVER a blanket revert of uncommitted changes, which would destroy any parallel user work the records don't cover. Then hand to `feature-design` with the hypotheses tried and why each failed. Same-knob-harder retries (the same edit with more of it, the same command re-run) are not structurally different and do not reset the count.

## Summary

Report: classification, the red check used, root cause, files changed, verification evidence (full-suite result plus any conditional gate), commit(s), and whether a fix record was written. If escalated at any gate, report where and to which skill.
