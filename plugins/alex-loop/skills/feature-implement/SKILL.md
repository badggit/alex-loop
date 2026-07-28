---
name: feature-implement
description: "Step 3/3 of the Alex Loop workflow (design, then plan, then implement). Execute implementation plans by dispatching parallel subagents per task wave, resolving dependencies, validating completion via code-review pass and full-suite tests, and repeating until all tasks are done. Invoke ONLY when the user explicitly names this skill ('/feature-implement', 'use feature-implement') or when feature-plan hands off a saved plan. Do NOT self-trigger on generic requests like 'implement this' or 'execute the plan'."
argument-hint: <plan-document>
---

<!-- Updated: 2026-07-28 -->

**Announce at start:** "Using skill: **Feature Implement** (step 3/3) to execute the plan task by task."

## Delegation Boundary

Only the user-facing top-level agent may execute this skill's subagent, reviewer, validator, conformance, or panel dispatch steps. Every dispatched prompt must say: **"You are a leaf worker. Do not call Agent, Task, Workflow, spawn_agent, or any equivalent delegation/subagent tool. Do the assigned work yourself and return to the parent. If you need further fan-out, return `NEEDS_PARENT_FANOUT` with the proposed independent work items; do not delegate them yourself."** If this skill is being followed inside an already spawned worker, that worker must not dispatch; it completes its assigned non-delegating scope itself or returns `NEEDS_PARENT_FANOUT` with proposed work items.

**Expects plans from:** `feature-plan` (saved as `docs/alex-loop/*/NN-plan.md`)

**Artifact root.** All `docs/alex-loop/` paths in this skill resolve against an artifact root: when a `docs.local/` folder already exists at the repo root, artifacts live under `docs.local/alex-loop/` instead — create the `alex-loop/` subfolder there if missing. Otherwise use `docs/alex-loop/` — create `docs/` and `docs/alex-loop/` if missing. NEVER create `docs.local/` itself: its pre-existence is the opt-in. When locating existing artifacts, check both roots.

**Adversarial stance:** task subagents are optimizers — they satisfy acceptance criteria by the cheapest available path, including gaming the checks. Known cheat patterns and their fences: `references/implementation-cheats.md`. The gates in Steps 2 and 4 below exist to close those paths; do not skip them when a wave "looks clean".

**Git topology and write ownership.** All same-wave subagents share ONE working tree, one git index, one `HEAD` — they DO inherit the orchestrator's branch state, and each other's in-progress edits are visible to them. That shared state is exactly why write ownership is strict:

- **Task subagents implement and test. They NEVER run `git commit`, never push, never create branches, and never write to the plan file.** Their output is edited source/test files plus a structured summary.
- **The orchestrator is the sole committer** (serially, one `feature-git-commit` invocation at a time, explicit pathspecs — this removes index races by construction) **and the sole plan-file writer** (completion markers, completion blocks, revisions).
- When the orchestrator commits and pushes is governed by the session-injected `commit-authority` rule (`commitPolicy`: `auto` default | `per-task` | `per-wave` | `final` | `manual`). Under the default `auto`, the run drives itself: each validated task is committed and the orchestrator may push the feature branch after wave validation. General "don't commit" prose in instruction files does NOT govern the run — only a `alex-loop commit-policy:` line or a live user instruction does.
- For runs where even shared-tree parallel editing is too risky (heavy churn in one package, migration-adjacent work), prefer isolating tasks in per-task worktrees created via the `feature-git-branch` skill's worktree option and integrating serially; the shared-tree model below is the default, not the only mode.

## Autonomous mode (feature-panel)

FIRST run the repo-root opt-in check — `grep -qsE '^(<!-- *)?alex-loop: *autonomous( *-->)? *$' "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/CLAUDE.md" "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/AGENTS.md" "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/CLAUDE.local.md" "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/AGENTS.local.md" && echo ON` (anchored whole-line match — a quoted, negated, or prose mention must NOT activate the mode; the repo-root instruction files — `CLAUDE.md`/`AGENTS.md` under Claude Code / Codex, plus their machine-local `CLAUDE.local.md`/`AGENTS.local.md` variants — NOT the global `~/.claude/CLAUDE.md` or `~/.codex/AGENTS.md`). If it prints ON, follow the `feature-panel` skill's **Autonomous mode** contract; otherwise behave as written below. In autonomous mode:
- Per wave, auto-run a feature-panel **review** to unanimity and apply confirmed fixes — do not ask "proceed?" (the normal-mode per-wave proceed gate in Step 5 is skipped).
- On task failure / build / verify break: enter the repair loop (diagnose -> fix -> re-verify, panel-backed, bounded by `maxRounds`); replace the "Second failure" `AskUserQuestion` (skip/retry/abort) — hard-exit to the user only at the cap, or immediately for a hard blocker (signing, missing creds, env/permission). The test-integrity and band-aid gates (Step 4 items 6-7) still bind: a green build from a gamed fix is FAIL.
- `[JUDGMENT]` bullets and any genuine design/scope decision are resolved via the **Decision protocol** (council + independent-model seat; see `feature-panel` Autonomous mode), and the run continues — do NOT batch for a user gate or interrupt per item. Record each decision's rationale in the plan file. This overrides the inline "present now via `AskUserQuestion`" wording in Step 4.9.
- Step 1 gates: empty-$ARGUMENTS with several unresolved plans — pick the most recent and announce it, no ask; dirty-tree gate — stash dirty files including untracked (`git stash push -u -m "feature-implement pre-run"`), report, restore after the final wave (a conflict on pop is a hard exit; never layer a second `feature-implement pre-run` stash on top of an existing one — that is a resume signal, see Step 1).
- Step 2.5 vibe-criteria gate: do not ask pre-wave — auto-tighten the criterion (add the missing `Run:`/`Expected:` instrument, the recommended option) where it is a mechanical fix; resolve it via the **Decision protocol** only when tightening genuinely needs a judgment call (never a user prompt).
- commitPolicy: autonomous mode resolves it per the `commit-authority` rule like any run; the default `auto` commits validated tasks and pushes the feature branch after wave validation. Under `manual` the run ends with a verified diff and a proposed commit series.

## Step 1: Load Plan

1. Read the plan file from $ARGUMENTS (path or filename under either artifact root — `docs.local/alex-loop/` / `docs/alex-loop/`). Empty $ARGUMENTS: glob `docs.local/alex-loop/*/[0-9][0-9]-plan.md` and `docs/alex-loop/*/[0-9][0-9]-plan.md` and keep plans with unresolved tasks (any task heading without a `[COMPLETE...]` / `[SKIPPED]` marker). Exactly one match — announce it and proceed. Several — confirm the most recent via `AskUserQuestion`. None — route to `feature-plan`.
2. Validate it exists and contains task sections. Check the header's `Design revision:` against the design document's current `Revision:` — a mismatch means the design was amended after planning; surface it and route to `feature-plan` for a re-plan of affected tasks instead of executing a stale plan. If the feature folder holds an `NN-challenge.md` with pre-execution checklist items not yet resolved (no plan task, no design revision, no `accepted risk` mark), warn before launching: the checklist is a commitment, not an archive.
3. **Resolve commitPolicy** per the `commit-authority` rule (in-session instruction > repo-config line > `manual`). Announce it with the plan: "commitPolicy: <value>".
4. Confirm the working tree is on a feature branch — not the repository's default branch (detect via `git symbolic-ref --short refs/remotes/origin/HEAD`, falling back to the `main` / `master` / `develop` guess list). If not, invoke the `feature-git-branch` skill to create one before launching any wave.
5. **Dirty-tree gate (tracked AND untracked).** Check `git status --porcelain` including untracked files, ignoring only untracked files under `docs.local/alex-loop/` and `docs/alex-loop/` (intentionally uncommitted loop artifacts). Any other dirty file at start — tracked edits or stray untracked sources — makes wave diffs and failure-cleanup unreliable (cleanup could not tell run residue from user work): ask via `AskUserQuestion`: commit them first (recommended), stash (`git stash push -u`), or abort.
6. **Create the run directory** — `mktemp -d "${TMPDIR:-/tmp}/feature-implement.<plan-slug>.XXXXXX"` — and record it in the plan file, directly under the header: `> **Run:** <run-dir> — started YYYY-MM-DD HH:MM UTC`. All baselines and snapshots for this run live there (unique per run — no collisions between runs or machines-shared `/tmp` guessing). If the directory is lost (reboot mid-run), recreate it and note "baselines recreated at resume; cross-wave comparison unavailable for earlier waves."
7. **Resume detection.** If the plan already has `[COMPLETE...]` markers alongside unresolved tasks, this is a resumed run, not a fresh one:
   - Tasks without markers are treated as not started — but FIRST check the tree for their traces (`git status --porcelain` filtered by each task's `Files:` list). Traces found → a task died mid-flight; show the files and ask discard (restore from git) or adopt (treat as partial work for the retry prompt). Never silently overwrite.
   - Check for an existing `feature-implement pre-run` stash — if present, warn and do not stack a second one.
   - A `> **Run:**` line pointing at a missing directory → recreate per item 6.
8. Announce: "Executing plan: [plan title] with [N] tasks"

## Step 2: Parse Tasks & Dependencies

1. Find task subsections (e.g., `## Task 1:` or `### Task 1.1:`)
2. For each task, extract:
   - Task ID and name
   - Dependencies — read from the task's `**Wave:** N (depends on: ...)` line first (the format `feature-plan` emits); fall back to explicit `Dependencies: Task 1, Task 3` lines; if neither is present, assume sequential by task number
   - Complexity — the `<!-- Complexity: N -->` comment after the task heading (default 3 when absent)
   - Full content (description, file paths, acceptance criteria, validation commands)
3. Build task dependency tree
4. **Wave overlap check — files AND shared resources.** Same-wave subagents share one working tree — two tasks editing the same file race each other. For every wave: (a) intersect the tasks' `Files:` lists (Create / Modify / Test paths); (b) check for shared-resource conflicts between same-wave tasks in one package/workspace — lockfile writes (dependency installs), build/test config edits (`tsconfig`, `pyproject`, bundler config), generated/codegen outputs, shared mutable fixtures. On any overlap of either kind: merge the overlapping tasks into one subagent, or serialize them (run one after the other within the wave). Report forced serialization or merges in the pre-wave report. Plans from `feature-plan` should already be conflict-free; an overlap is also a plan-quality signal worth noting.
5. **Vibe-criteria gate.** A criterion without an instrument is a vibe — the subagent will declare it met because nothing can tell it otherwise. In plans from `feature-plan`, a task's instruments are its `Run:` commands with `Expected:` outputs, covering its Step-1 behavior bullets. Flag every task that (a) has no runnable `Run:`/`Expected:` validation at all, or (b) has behavior bullets that no listed command can verify and that are not labeled `[JUDGMENT]`. Surface flagged tasks to the user via `AskUserQuestion` BEFORE launching any wave: tighten the criterion (recommended), accept it as judgment-call, or drop the task. Bullets labeled `[JUDGMENT]` (from `feature-plan`) skip the flag; the user verifies them at wave validation (Step 4), never the subagent's self-grade.

## Step 3: Launch Subagents

**Pre-wave baseline (capture BEFORE launching; the Step 4 gates diff against it):**
1. Record the wave-start commit: `git rev-parse HEAD`. Step 4's test-integrity gate diffs test files against this ref.
2. Capture the full-suite failure list: before wave 1, dispatch a leaf subagent with the **Delegation Boundary** clause to run the project's canonical full-suite command and return the failing tests as structured lines — `file :: test-name :: status` (fail / error / skip), so later comparison distinguishes a real failure from an infra error or a skip (raw suite output stays out of orchestrator context); later waves inherit the previous wave's post-validation run as their baseline.
3. **Persist both to `<run-dir>/wave-<N>.baseline`** (wave-start SHA + structured failing-test list). Orchestrator memory does not survive context compaction; Step 4's wave-validator (items 5-6) reads this file and writes the next wave's baseline file.
4. Snapshot the plan file (`cp <plan> <run-dir>/wave-<N>.plan.md`) — the plan is intentionally uncommitted, so `git diff` cannot see edits to it; the Step 4 plan-file sweep diffs against this snapshot.

**Pre-wave report:** Before launching, announce:
```
Wave [N]
| Task | Status    | Blocked by |
|------|-----------|------------|
| 1: … | Launching |            |
| 3: … | Launching |            |
| 4: … | Blocked   | Task 3     |
| 5: … | Blocked   | Task 1, 4  |
```

For each **unblocked** task, launch a subagent with:
- **description**: "Implement task [ID]: [name]"
- **prompt**: Use template below

Launch all unblocked tasks in parallel. A task is unblocked if all IDs in its dependencies list are complete. Where the dispatch surface exposes an effort or model control, route by the task's complexity score: 1-2 low effort, 3 default, 4 high; otherwise ignore the score. Complexity also sets the expected runtime envelope: a subagent that dies, hangs, or vastly overruns the envelope for its score is a **timeout** failure — a distinct failure type whose retry MUST change the decomposition (split the task, narrow its scope), never re-run the same prompt and hope (that is same-knob retry by another name).

### Task Prompt Template

**CRITICAL:** Fill every field below with actual content copied from the plan. NEVER use placeholder references like "[As listed in plan]" or "[See plan]" — the subagent must not depend on reading the plan file for task content, so every detail it needs must be in the prompt.

```
You are implementing a specific task from a development plan.

You are a leaf worker. Do not call Agent, Task, Workflow, spawn_agent, or any equivalent delegation/subagent tool. Do the assigned work yourself and return to the parent. If you need further fan-out, return `NEEDS_PARENT_FANOUT` with the proposed independent work items; do not delegate them yourself.

## Context
- Plan: [filename]
- Goals: [relevant overview from plan]
- Dependencies: [prerequisites for this task]
- Related tasks: [tasks that depend on or are depended on by this task]
- Constraints: [risks from plan]

## Your Task
**Task [ID]: [Name]**

Location: [File paths]
Description: [Full description]

Acceptance Criteria:
[Copy the task's contract and Step-1 behavior bullets from the plan — every bullet, verbatim. These are the behaviors your tests must cover and your implementation must satisfy.]

Validation:
[Copy the task's `Run:` commands and `Expected:` outputs from the plan, verbatim]

## Git Discipline
- **You share the working tree, index, and branch with other task agents.** Branch: [feature-branch-name]. Stay on it — never switch branches, never create branches.
- **You do NOT commit. You do NOT push. You do NOT stage.** No `git commit`, `git add`, `git stash`, `git checkout`/`git restore` of files outside your task. The orchestrator owns all git state changes; your output is edited files plus your summary.
- **Never write to the plan file or any file under `docs.local/alex-loop/` or `docs/alex-loop/`.** Completion status travels in your summary, not in the plan.

## Scope Discipline
- **Do not touch files outside your task's listed paths.** If you believe another file must change to make your task work, report it as drift (see below) — do not silently expand scope.
- **Do not anticipate future tasks.** Do not pre-build scaffolding, helpers, or types for work that belongs to a later task. The next task's subagent will handle it.
- **Do not "improve" unrelated code** you happen to read. Bug fixes, cleanups, and refactors outside your task's scope are out of scope.
[If the plan task carries a `Not in scope:` line, copy it here verbatim.]

## Test Discipline
Tests are the contract, not an obstacle. The orchestrator diffs every test file you touch and will fail the task on any of these:
- **Never weaken a pre-existing test to get green** — no deleted or loosened assertions, widened tolerances, or nerfed fixtures, unless your task explicitly owns that change.
- **Never disable tests** — no `.skip` / `.only` / `.todo` / commented-out assertions / empty test bodies.
- **Never mask instability** — no added `sleep`s, inflated timeouts, or retry wrappers to make a flaky test pass; report flakiness instead.
- **Cover every behavior bullet** from your task's failing-test step with a real assertion. Green-with-gaps is incomplete.
- **No fixture special-casing** — implementation code must not branch on literals from test fixtures, and mocks must not be pinned to environment literals (hostnames, ports, absolute paths).
- **No leftover debug output** — remove `console.log` / `print` debugging from non-test code before yielding.
If a prescribed test seems wrong or unsatisfiable, that is drift — report it; do not route around it.

## Handling Plan Drift
If you discover the plan is wrong while implementing, surface it — do NOT silently work around it.

Drift means any of: the contract in the plan doesn't match reality; a file path or symbol named in the plan doesn't exist or has a different shape; a dependency you expected to be ready is not; an acceptance criterion is impossible as stated; or your implementation reveals that a later task's listed files, contract, or behavior is no longer accurate.

**If you can still complete your task sensibly:** do so, and report the drift in your summary's completion block (status `COMPLETE WITH DRIFT`) explaining exactly what diverged and which later tasks are affected.

**If you cannot complete your task because of the drift:** do NOT guess or fabricate. Stop and return a drift report in your summary describing the mismatch.

Never silently paper over plan mistakes.

## Instructions
1. Examine the plan context above and any relevant or dependent files
2. Implement changes for all acceptance criteria, staying strictly within your listed file paths
3. Keep the work **atomic and committable** — the orchestrator commits it as one unit after validation
4. For each file: read first, edit carefully, preserve formatting
5. Run validation if feasible
6. Return summary — max ~300 words (drift notes exempt from the cap) — containing a completion block the orchestrator will copy into the plan:
   - Status: COMPLETE | COMPLETE WITH DRIFT | INCOMPLETE (+ why)
   - Files: exact list of files modified/created (this is also the orchestrator's commit pathspec — be complete)
   - Changes made and how acceptance criteria are satisfied
   - Validation performed or deferred
   - **Drift, if any** — even if the task still completed, call it out explicitly
```

## Step 4: Validate Wave

After subagents in the current wave complete:

1. Inspect their outputs for correctness and completeness
2. Dispatch a leaf code-review subagent on the changed files (type safety, simplicity, regressions, language-specific anti-patterns), including the **Delegation Boundary** clause in its prompt. Read-only — it returns findings graded must-fix | should-fix | nit; surface them, do not auto-apply.
3. **Must-fix findings only**: re-launch the task subagent with them as error context. This re-launch counts as the task's first retry (item 10) and must carry the same hypothesis / expected-failure-mode / diagnostic fields. Should-fix and nit findings do NOT consume the retry — apply them as orchestrator edits after the wave validates, or carry them into the post-wave report.

**Items 4-8 run inside a single leaf wave-validator subagent — never in the orchestrator.** Raw suite output, gate greps, and diff dumps burn orchestrator context needed for later waves; the orchestrator consumes verdicts, not evidence streams. Dispatch one subagent with the **Delegation Boundary** clause, the plan path and its Step 3 snapshot path, the wave's baseline file path, the canonical full-suite command, and the wave's tasks (touched files, behavior bullets, validation commands, any plan-owned test edits). The validator executes items 4-8 exactly as written, writes the next wave's baseline file itself, and returns ONLY a structured verdict (~300 words max): per-gate PASS/FAIL, new test failures (file + test name), FLAKY findings, gate violations with file:line cites, and verification-command outcomes. The orchestrator acts on the verdict via items 3, 9, and 10, passing the verdict's cites as error context to retries — it never re-runs the suite or the greps itself.

4. **Run the FULL test suite, not a subset.** Task-subagent reports of "all tests green" must be re-validated by the wave-validator running the project's canonical full-suite command (e.g. `bun run test`, `npm test`, `pytest`). Touched-file globs are not sufficient — a refactor in one file can break unrelated tests in any other file that exercises the same code path. The validator's full-suite run is the load-bearing check; the task subagent's targeted run is informational.
5. **Compare the failure list against the pre-wave baseline** (read it from `<run-dir>/wave-<N>.baseline`, not from memory). If failures were stable before the wave (pre-existing), they're acceptable. **Any new failure** in any file (including ones the subagent did not touch) is a regression caused by the wave — with one filter: **flake detection.** Re-run each NEW failure in isolation twice. Fails consistently → regression: surface immediately, do not advance. Passes at least once (unstable) → mark it `FLAKY` in the verdict instead of charging it to the task — it does not consume the task's retry; recommend a follow-up fix task for the flaky test. Write this run's failure list (with statuses) to the next wave's baseline file.
6. **Test-integrity gate.** A green suite proves nothing if the tests were gamed. For every test file the wave touched:
   - `git diff <wave-start-SHA> -- <test-file>` (the SHA from the wave's baseline file). Any weakened pre-existing assertion (deleted assert, exact-match loosened, tolerance widened, fixture nerfed) not explicitly owned by the task's plan = task FAILED, not drift.
   - Grep for disable patterns: `\.skip|\.only|\.todo|xit\(|xdescribe\(` plus commented-out assertions and empty test bodies — zero hits, or each justified by the plan.
   - Grep the diff of touched test files for flake-masking: newly added `sleep`/`setTimeout`/`time.sleep` calls or timeout values inflated 4x+ — each hit needs a plan-side justification, else FAILED.
   - Map each behavior bullet from the task's failing-test step to a landed assertion. An unmapped bullet means the task is incomplete regardless of suite color.
   - Spot-check impl files for branching on literals that appear in the task's test fixtures (lookup table wearing code's clothing), and for mocks pinned to environment literals (hardcoded hostname/port/absolute path that only holds on this machine).
7. **Band-aid and plan-file sweep (every wave, not only refactors).**
   - Grep the wave's touched files for band-aids — JS/TS: `as any|@ts-expect-error|as unknown as`; Python: `# type: ignore|# noqa|cast\(Any`; any language: `TODO|FIXME|HACK` and stub returns (`return true` / `return True` where behavior was required) — zero hits, or each independently justified and pre-existing (cite each). Also sweep the wave's added lines in non-test files for leftover debug output (`console.log`/`console.debug`, bare `print(` outside CLI/logging surfaces) — flag each hit. This list is canonical; `references/implementation-cheats.md` points here.
   - Diff the plan file against the Step 3 snapshot (`diff <run-dir>/wave-<N>.plan.md <plan>` — the plan is uncommitted, so git cannot see edits): task subagents have NO legitimate plan-file writes, so ANY change a subagent made to the plan during the wave = that task FAILED. (Orchestrator-authored edits — markers written in item 9, drift-triage revisions — are recorded by the orchestrator after this sweep, and the snapshot for the next wave is taken after them.)
8. Run remaining verification commands from the plan (linter, build, typecheck). Read the full output and confirm it passes before accepting. No completion claims without fresh evidence.
9. **Orchestrator bookkeeping and policy-gated commit (after the validator's verdict, per validated task):**
   - Write the completion marker to the plan file: append ` [COMPLETE]` (or ` [COMPLETE WITH DRIFT]`) to the task's heading, keeping its level, and add the completion block from the worker's summary (`> **Completed:** ... > **Files:** ... > **Notes:** ... > **Drift notes:** ...`). The orchestrator is the only writer of these.
   - If the task carries `[JUDGMENT]` bullets, present each to the user now via `AskUserQuestion` (with the relevant artifact: screenshot, rendered copy, output sample) — the task is not complete until the user confirms them. (Autonomous mode: resolve via the **Decision protocol**, record the rationale in the plan file, and continue.)
   - Commit per commitPolicy: `auto` / `per-task` — commit this task's `Files:` now via the `feature-git-commit` skill (serial, explicit pathspecs); `per-wave` — batch after the whole wave validates; `final` / `manual` — no commit now (under `manual`, collect the proposed commit series for the final summary). Under `auto`, once the whole wave validates the orchestrator may also push the feature branch (`git push -u origin <feature-branch>` — never the default branch); other policies push only on explicit user request.
10. If a task failed, timed out, or introduced a regression:
   - **First retry**: Re-launch the subagent with error context, including the specific test file(s) that newly failed. Before re-launch, clean the failed attempt's residue: the task was never committed (commits happen only after validation), so restore its `Files:` from the wave-start SHA (`git checkout <wave-start-SHA> -- <files>`; delete files the attempt created) — touching ONLY the task's listed paths, nothing else in the shared tree. Keep sound partial work only by explicit decision, stated in the retry prompt. The retry prompt must also state, before any change: **hypothesis** (why the first attempt failed), **expected failure mode** (how this retry could fail or turn into a cheat), and **diagnostic** (what observation distinguishes success from that failure mode). A **timeout** failure's retry must change the decomposition (split/narrow), not re-run the same prompt.
   - **Stall rule**: a second attempt must be structurally different from the first — different approach, different seam, different diagnosis. Same-knob-harder (same edit but more of it, same command re-run, same assumption retried) is banned; if no structurally different attempt exists, skip straight to the user.
   - **Second failure**: Ask via `AskUserQuestion` with three options — skip / retry-with-different-context / abort — recommending the option grounded in the failure mode (skip when the task is non-blocking and the regression is contained, retry when the failure looks like a missed prompt detail, abort when the wave's premise is broken)
   - **On skip or abort**: restore the failed attempt's residue per its `Files:` list so the tree reflects only validated work. On skip, append ` [SKIPPED]` to the task's heading (keeping its level) in the plan file with a `> **Skipped:** <date> — <reason>` line. If other tasks depend on it, surface them in the same `AskUserQuestion` round — skip those too, or abort; a skipped task's dependents can never unblock on their own.
   - A failed task blocks all tasks that depend on it
11. Ensure the wave's tree state is clean relative to expectations (validated work present; failed-task residue restored) before proceeding

### Conditional verification

These gates fire only when the wave matches the listed shape. If a gate applies and is genuinely impractical (no real-LLM credentials, no UI surface to drive, infra blocker), state the gap explicitly: "wave mechanically complete; <gate> owed before merge."

- **UI-affecting wave** (touched components, layout, styling, accessibility, interactive behavior): drive the running app via agent-browser, observe the rendered change, capture a screenshot. Type-check + unit tests are not sufficient for UI claims.
- **Refactor wave that removes or renames a symbol, type, field, or API surface**: grep the entire repo for each removed identifier — expected zero hits. (Band-aid sweep already runs on every wave in item 7.)
- **Wave introduces a new architectural foundation** (new dispatch path, new storage layer, new wire protocol): run one real path end-to-end against production-equivalent dependencies (real LLM, real DB, real network).
- **Perf gate — only when the design declared performance targets** (design's Non-functional requirements section) and the wave touched the declared hot path: run the stated measurement before/after and compare against the declared target. No declared target = no benchmark; an uninterpreted number proves nothing.
- **Security gate — when the wave's diff touches authn/authz code or adds handling of external input**: the Step 4.2 review subagent gets an explicit security focus (injection, authz bypass, unsafe deserialization, secret handling) for those files, and the wave's added lines are scanned for committed secrets (key material, tokens) before any commit is created.

Include the gate's actual command output (or "zero hits" / "screenshot at <path>") in the post-wave report. Summary alone ("looks clean") is not evidence.

**Post-wave report:** After validation, announce:
```
Wave [N] complete — Progress: [completed]/[total] tasks done
| Task | Result  | Files changed | Notes         |
|------|---------|---------------|---------------|
| 1: … | OK      | 2 files       |               |
| 3: … | DRIFT   | 2 files       | see triage    |
| 4: … | FAILED  | 0 files       | retrying once |
```

## Step 4.5: Drift Triage

Between waves, scan the plan file for any tasks marked `[COMPLETE WITH DRIFT]` in the wave that just finished. For each drift report:

1. **Read the drift notes carefully.** Understand what diverged and which downstream tasks are affected.
2. **Classify the drift and act:**
   - **Mechanical patch** — The fix is a straightforward update to downstream tasks' file paths, type signatures, contracts, or acceptance criteria. Apply the patch directly to the plan file. Annotate each revised task with a `> **Revised:** YYYY-MM-DD — <short reason>` line so the edit history is visible. Continue to the next wave.
   - **Structural rework** — The drift invalidates the shape of multiple downstream tasks, changes wave dependencies, or reveals the plan's architecture was wrong. Do not patch in place. Hand back to `feature-plan` to replan the remainder against the current codebase (or `feature-design` if the design itself is implicated). Report the decision briefly so the user sees what happened — no gating, no waiting for approval. (Autonomous mode: when the patch-vs-replan classification is itself unclear, resolve it via the **Decision protocol**, not a user prompt.)
3. **The plan file is the source of truth.** Any change (revision, drift note, completion marker) must be written to the file — by the orchestrator, its sole writer — before the next wave launches. No in-memory deltas, no "I'll remember this for the next wave."
4. **Drift rate signal.** If more than 30% of completed tasks in the plan so far are marked `[COMPLETE WITH DRIFT]`, the plan is no longer trustworthy as a whole. Hand back to `feature-plan` (or `feature-design` if the design is implicated) to replan the remainder. Report the drift rate and the decision as you make it.

## Step 5: Repeat

1. Re-read the plan file to see which tasks are now marked `[COMPLETE]`, `[COMPLETE WITH DRIFT]`, or `[SKIPPED]`
2. Identify the next wave of unblocked tasks (a task is unblocked when every dependency is `[COMPLETE]` or `[COMPLETE WITH DRIFT]`; `[SKIPPED]` never unblocks a dependent)
3. **Per-wave proceed gate (normal mode).** Before launching the next wave, ask via `AskUserQuestion`: "Wave [N] validated. Launch wave [N+1] ([M] tasks)?" with options: proceed (recommended when the wave was clean), proceed and don't ask again this run, pause here. Skip the gate entirely in autonomous mode and after the user picks "don't ask again."
4. Launch them in parallel (back to Step 3)
5. Repeat until **every** task is resolved — `[COMPLETE]` / `[COMPLETE WITH DRIFT]` validated and working without errors, or `[SKIPPED]` by the user's explicit call

## Step 6: Final Summary

**Plan-conformance gate first.** Dispatch one fresh leaf subagent with the **Delegation Boundary** clause, the full branch diff (`git diff <base-branch>...HEAD` — or the working-tree diff under `manual`/`final` commitPolicy), the plan's Goal and task list, and the plan header's `Verification:` command. It reports: (a) plan requirements with no implementing change in the diff, (b) diff changes no task owns, and (c) the outcome of running the `Verification:` command — the feature-level proof, distinct from per-task greens. Route gaps through Step 4's retry machinery before summarizing; user-approved `[SKIPPED]` tasks are excluded from (a). Include the gate's verdict AND the `Verification:` outcome in the summary.

When every task is resolved, present a summary including:
- Wave breakdown table (wave number, tasks launched, passed, failed, retried, skipped)
- Per-task table (task name, wave, result, files changed)
- Commit list (or, under `manual`/`final` commitPolicy, the proposed commit series: pathspecs + messages, ready to approve)
- FLAKY findings from wave validation (or "None") with the recommended follow-up fix tasks
- Skipped tasks with reasons (or "None") — these are unfinished work, not done work
- Deferred/known issues (or "None")
- Recommended next steps (e.g. push, run full test suite)

## Step 7 (optional): Draft PR

Only on explicit confirmation — PR creation is outward-facing under every commitPolicy (hard-escalation in autonomous mode; a user "yes" here in normal mode). When confirmed:

1. Check `.github/pull_request_template.md` and follow it if present.
2. Assemble the description from run artifacts — plan Goal, task/wave summary, commit list, skipped/deferred items, `Verification:` outcome.
3. Push the feature branch if not already pushed (under `auto` it typically is) and create the PR as **draft**. Never mark it ready for review on the user's behalf.
