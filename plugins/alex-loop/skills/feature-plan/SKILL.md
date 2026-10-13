---
name: feature-plan
description: "Step 2/3 of the Alex Loop workflow (design, then plan, then implement). Break approved saved design documents into bite-sized implementation tasks with exact file paths, test commands, and TDD steps; drafting runs inside a planner subagent so the orchestrator context stays lean. Invoke ONLY when the user explicitly names this skill ('/feature-plan', 'use feature-plan') or when feature-design hands off an approved design. Do NOT self-trigger on generic requests like 'write a plan' or 'break this into tasks'."
---

<!-- Updated: 2026-07-12 11:53:50 UTC -->

# Feature Plan

## Delegation Boundary

Only the user-facing top-level agent may execute this skill's subagent or panel dispatch steps. Every dispatched prompt must say: **"You are a leaf worker. Do not call Agent, Task, Workflow, spawn_agent, or any equivalent delegation/subagent tool. Do the assigned work yourself and return to the parent. If you need further fan-out, return `NEEDS_PARENT_FANOUT` with the proposed independent work items; do not delegate them yourself."** If this skill is being followed inside an already spawned worker, that worker must not dispatch; it completes its assigned non-delegating scope itself or returns `NEEDS_PARENT_FANOUT` with proposed work items.

## Overview

Write comprehensive implementation plans assuming the engineer has zero context for our codebase and questionable taste. Document everything they need to know: which files to touch for each task, what each piece should do, which test cases to cover, how to verify it. Give them the whole plan as bite-sized tasks. DRY. YAGNI. TDD. Frequent commits.

Assume they are a skilled developer, but know almost nothing about our toolset or problem domain. Assume they don't know good test design very well.

**Announce at start:** "Using skill: **Feature Plan** (step 2/3) to break this into implementation tasks."

**Context:** This is typically invoked after `feature-design` produces and saves an approved design.

**Save plans to:** `docs/alex-loop/YYYY-MM-DD-[<ticket>-]<topic>/NN-plan.md` — the same feature folder as the design being planned; `NN` is the next free two-digit prefix among `*-plan.md` files (plans are numbered independently of designs and challenges, so the first plan is `01-plan.md`, a second is `02-plan.md`).

**Artifact root.** All `docs/alex-loop/` paths in this skill resolve against an artifact root: when a `docs.local/` folder already exists at the repo root, artifacts live under `docs.local/alex-loop/` instead — create the `alex-loop/` subfolder there if missing. Otherwise use `docs/alex-loop/` — create `docs/` and `docs/alex-loop/` if missing. NEVER create `docs.local/` itself: its pre-existence is the opt-in. When locating existing artifacts, check both roots.

**Feature folder name.** A new feature folder is `YYYY-MM-DD-<topic>`, or `YYYY-MM-DD-<ticket>-<topic>` when the work is tied to a numbered ticket (`RAM-123` style tracker key kept verbatim, `#123` normalized to `gh-123`), taken from the user's request / skill arguments first (a key presented as the work's ticket or a tracker / GitHub issue URL - `UTF-8`, `SHA-256`, `CVE-...`, "option #2" are not tickets), then from an issue-key segment in the current branch name when that branch is not the default branch and was clearly created for this work. Never invent or ask for a key; an existing feature folder is reused as-is, never renamed. Full rule: `feature-design` -> Saving the Design.

## Execution Model — Planner Subagent

The main agent is a thin orchestrator: it owns user interaction (every `AskUserQuestion` gate in this skill), design location, and the handoffs. ALL heavy lifting — reading the design document, exploring the codebase, scoring and splitting tasks, authoring the plan file — happens inside ONE planner subagent. Raw file reads and drafting must never land in orchestrator context; the orchestrator consumes the planner's summary, not its process.

**Dispatch** one general-purpose subagent (planning is architecture work — it inherits the session model; never downgrade it to a fast tier) with a self-contained prompt containing:

1. This skill's base directory path, with the instruction: read this SKILL.md and follow the drafting rules exactly — **Plans Describe Work, Not Code**, the "Read the codebase before drafting tasks" step, and everything from **Bite-Sized Task Granularity** through **No Instrument-less Criteria**, plus the **Remember** checklist. The `AskUserQuestion` gates and design location in **Preconditions** are the orchestrator's — not the planner's.
2. The design document path — the sole source of truth; pass no conversation context. The planner first reads the design's header: `Status:` must be `approved` (a `draft` or `superseded` design is a returnable condition, not a planning source), and the `Revision:` and `Stakes:` values carry into the plan header. If the plan cannot be drafted from the design alone, that is a returnable condition, not a license to guess.
3. The target plan path per **Save plans to**, plus any constraints the user stated at design location.
4. The no-questions contract: the subagent cannot ask the user anything. Conditions where it must NOT write the plan file and must return the condition instead: a complexity-5 task that cannot decompose (name the task and the missing detail); a task list exceeding the 15-task ceiling after the complexity gate has split everything it can (report N).
5. The leaf-worker contract from **Delegation Boundary**. The planner performs all reading and drafting itself; it never launches explorers or other workers. If it cannot proceed without fan-out, it returns `NEEDS_PARENT_FANOUT` rather than dispatching.
6. The required return, max ~300 words: plan path written (or none + gate condition with specifics); task count and wave count; count of irreducible complexity-4 tasks; whether the plan touches persisted data, external contracts, or migrations (the orchestrator needs these for the challenge recommendation — the same flags are also written into the plan header's `Risks:` line, which outlives the session); and a structured list of assumptions or flagged decisions.
7. No commits — the plan stays uncommitted by design.
8. **Self-lint before returning.** After drafting, the planner mechanically checks its own plan file and fixes what it finds: task numbering unique and sequential; every `Wave:` dependency names an existing task; same-wave `Files:` sets disjoint AND no same-wave shared-resource conflict (see **Waves and Dependencies**); zero angle-bracket placeholders; every `Run:` has an `Expected:`; all required header lines present and filled. The summary states "self-lint passed" or lists what could not be fixed.

**On return**, the orchestrator reads ONLY the summary. A returned gate condition feeds the corresponding `AskUserQuestion` in **Complexity Discipline** or **Plan Size Ceiling** — those asks are the orchestrator's, populated with the planner's specifics. A written plan proceeds to the challenge offer and execution handoff. Spot-checking the plan file (header, one or two tasks) is fine; re-reading it wholesale defeats the delegation.

**Iteration:** user-accepted small edits (rename, drop a task, fix a path) are applied by the orchestrator directly per **Iterating on a Saved Plan**. Structural rework (re-scoping, re-waving, a design-change ripple) re-dispatches the planner with the prior plan path plus the feedback.

## Autonomous mode (feature-panel)

FIRST run the repo-root opt-in check — `grep -qsE '^(<!-- *)?alex-loop: *autonomous( *-->)? *$' "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/CLAUDE.md" "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/AGENTS.md" "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/CLAUDE.local.md" "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/AGENTS.local.md" && echo ON` (anchored whole-line match — a quoted, negated, or prose mention must NOT activate the mode; the repo-root instruction files — `CLAUDE.md`/`AGENTS.md` under Claude Code / Codex, plus their machine-local `CLAUDE.local.md`/`AGENTS.local.md` variants — NOT the global `~/.claude/CLAUDE.md` or `~/.codex/AGENTS.md`). If it prints ON, follow the `feature-panel` skill's **Autonomous mode** contract; otherwise behave as written below.

End gates — skip the ask, proceed:
- "Challenge this plan before implementation?" — skip the ask; auto-run a feature-panel **challenge** to unanimity, apply revisions per the Execution Model's **Iteration** rule (small edits in place; structural rework re-dispatches the planner), then proceed.
- "Shall I continue with implementation?" — skip the ask; invoke `feature-implement` directly with the saved plan path.

Exception stops — do NOT issue the blocking `AskUserQuestion`; route to `feature-design` re-entry instead, which in autonomous mode resolves the decision via the **Decision protocol** (council + independent-model seat; see `feature-panel` Autonomous mode) and continues, escalating to the human approval gate only for an irreversible scope expansion or a high-stakes council deadlock. Each of these means the design is underspecified:
- **Missing approved design** (Preconditions): skip the "Shall I run feature-design?" ask; invoke `feature-design` directly to produce and save one, then resume planning.
- **Complexity-5 task that cannot decompose** (Complexity Discipline): skip the scripted `AskUserQuestion`; hand back to `feature-design` to narrow the underspecified area, then re-plan.
- **Plan exceeds the 15-task ceiling** (Plan Size Ceiling): skip the narrow/split ask. Do NOT pick narrow-vs-split here — hand back to `feature-design`, which presents the re-scoped design (narrow vs split, recommended default flagged) as one worked proposal. Re-plan the remainder once that design is resolved — council-decided in autonomous mode, human-approved otherwise.

## Plans Describe Work, Not Code

**The plan is a directive for an implementer, not the implementation itself.** If a task would require writing out a full function body or a complete test file in the plan, stop — that's code that belongs in the actual file, not in a markdown document.

**Do NOT put in the plan:**
- Full function bodies or implementation code blocks
- Complete test files or `expect(...)` / `assert ...` blocks
- Copy-pasteable multi-line code for the implementer to duplicate

**DO put in the plan:**
- Exact file paths (create / modify / test)
- Prose descriptions of what each piece should do and why
- **Type signatures and interface contracts** — pin the contract so parallel tasks don't drift
- **Short inline snippets** where a name, shape, or call is clearer than prose
- **Test cases as prose**, not as code. List the behaviors to assert — input, expected outcome, and any side effect to check. Never write `it(...)` / `def test_...` blocks. **Default to 3 distinct behaviors per task with tests**: the happy path, one edge case (empty input, missing data, boundary value, or invalid state), and one failure case (error, rejection, or incorrect input handling). Fewer is allowed only when the task's behavior space genuinely holds fewer — state why in the task ("no failure path: pure lookup over a closed enum") instead of padding with a test that asserts nothing.
- Exact commands to run for verification, with expected outcomes
- Wave / dependency structure for parallel execution

## Preconditions

### Approved design file required

This skill requires an approved design document saved under `docs/alex-loop/` (typically from `feature-design`). Conversation-only approval is insufficient. Do NOT fabricate a design, and do NOT dispatch the planner until you have the actual design file path — reading the design is the planner's job, locating it is the orchestrator's.

**Locating the design.** Take the first that applies:

1. A path handed off in-session (from `feature-design`) or named by the user — use it.
2. Glob `docs.local/alex-loop/*/[0-9][0-9]-design.md` and `docs/alex-loop/*/[0-9][0-9]-design.md` yields exactly one document — announce it as the planning source and proceed.
3. Multiple candidates — ask via `AskUserQuestion` which document is the planning source, most recent first, recommending the newest. Never silently pick one.

Autonomous mode: prefer the session handoff path; without one and with multiple candidates, route to `feature-design` re-entry instead of guessing.

If no approved design file exists, stop and use `AskUserQuestion` (or the equivalent available question/prompt tool) to ask: **"No approved design document found in docs/alex-loop/. Shall I run feature-design to create and save one first?"** with options:

1. **Yes, create design first** — Invoke `feature-design`.
2. **No, I'll provide the path** — Wait for the user to provide the exact saved design document path, then read it before continuing.

If the user pastes or describes a design in chat instead of giving a saved path, do not proceed to planning. First write that design to `docs/alex-loop/YYYY-MM-DD-[<ticket>-]<topic>/01-design.md` (folder named per **Feature folder name** above), confirm the saved file, and only then continue.

### Read the codebase before drafting tasks

Before writing any task, the planner subagent reads the saved design document and the files it implies will be touched. Concrete file paths in tasks must come from the actual repo — not guesses. If the design names an unfamiliar subsystem, the planner explores it first. The "No Placeholders" rule below is only enforceable if this step was done. All of this reading happens inside the planner — never in the orchestrator.

## Bite-Sized Task Granularity

### When TDD is mandatory

TDD is mandatory for tasks that introduce or change **behavior**: functions with logic, endpoints, state transitions, parsers, bug fixes, data transformations, migration up/down scripts, anything with branches or side effects.

**TDD sequence for behavioral tasks:**

1. Write the failing test (describe the behavior to assert, in prose)
2. Run it and confirm it fails for the expected reason
3. Implement the minimum behavior to make the test pass
4. Run the tests and confirm they pass
5. Commit (orchestrator, policy-gated per the `commit-authority` rule)

Describe each step in prose with the exact commands to run. Do not embed full test code or full implementation code in the plan.

### When TDD does NOT apply

Tasks that only declare **static structure** with no behavior of their own are exempt from TDD. Writing tests for these tests the language or framework, not your code. Coverage comes from the behavioral tests of the code that *uses* the structure.

**Exempt task types:**
- Pydantic/dataclass/TypedDict field declarations with no custom validators
- Enum definitions and constant declarations
- Type aliases and interface declarations with no logic
- Config key additions (new keys in a config file or schema)
- Dependency installation (`npm install`, `uv add`, etc.)
- Environment variable documentation
- Pure re-exports (`export { Foo } from './foo'`)
- Generated code (schemas, clients, bindings)

**Rule of thumb:** if the only way to "test" the task is to assert that a field exists or an enum has a value, skip TDD. If a Pydantic model gains a custom validator or an enum gains a lookup method, it is no longer static — TDD applies again.

For exempt tasks, the steps collapse to: implement the declaration, run the project's typecheck/lint to confirm it parses, commit (orchestrator, policy-gated — same as Step 5 below).

### Documentation task check

If the feature changes anything the project's documentation describes — CLI flags, config keys, API surface, user-facing processes in README/docs — the plan includes a documentation-update task in the LAST wave (docs describe the outcome, not intermediate states). It is static-structure exempt from TDD; its verification is a `Run:` grep proving the changed surface is mentioned where the docs cover it. This class of work systematically falls out of plans precisely because it has no failing test — hence the explicit check.

### Migrations are not exempt

Static schema *declarations* are exempt, but migration scripts themselves (up/down, data backfill, transforms) have behavior and require TDD. When a task touches persisted state, external contracts, or config schemas, include an inline **Migration notes** paragraph in the task covering forward/backward compatibility, rollout order, and rollback strategy.

**When the plan touches persisted data, one task is mandatory, not discretionary: "migration dry-run + rollback verification."** It runs the migration forward against a representative dataset and runs the rollback path back, each with its own `Run:` / `Expected:` — both directions proven, not described. This task is never TDD-exempt. Data loss is irreversible; proving rollback must not depend on the user opting into a challenge later.

## Complexity Discipline

While drafting tasks, internally score each one on a 1–5 complexity scale. **Scores appear in the plan ONLY as an HTML comment after each task heading (`<!-- Complexity: N -->`) — machine-readable for `feature-implement`'s effort routing, invisible in rendered markdown.** They MUST NOT appear in user-facing prose, task descriptions, or chat; the user reads tasks, not story points.

**Rubric:**
- **1** — Single trivial edit (rename, constant change, one-line fix).
- **2** — Small focused change, one file, clear test cases.
- **3** — Multi-file feature or non-trivial logic, tests straightforward, well-understood domain.
- **4** — Touches multiple subsystems, or has real unknowns, or requires non-obvious test setup.
- **5** — Cross-cutting, unclear scope, or requires research mid-task.

**Gate rules (apply before emitting the plan):**
- **No task may ship at 5.** Decompose it. If it cannot decompose, the design is underspecified — the planner returns this condition (task name + missing detail) without writing the plan; the orchestrator asks via `AskUserQuestion`: **"Task [name] cannot decompose below complexity 5 — the design is underspecified there."** Options: **Return to feature-design** (recommended) — narrow the underspecified area, then re-plan; **Provide the missing detail now** — the user answers inline, then the planner is re-dispatched with the detail. Do not write the plan until resolved.
- **4s must be reviewed.** Try to split into two 3s. If a 4 genuinely cannot be reduced further (e.g. an irreducible contract that must land atomically), let it stand — but only after honestly trying.
- **Prefer 3s.** 3s are the target granularity.
- **1s and 2s are fine.** Do not merge small tasks to pad them; small is good.

Score, split, re-score, repeat until the gate passes. Then write the plan document, emitting each task's final score as the `<!-- Complexity: N -->` comment and nothing else.

## Plan Size Ceiling

A plan that decomposes into **more than 15 tasks** is a signal the feature is too big to plan as a single unit — not a signal to write a bigger plan. Splitting a too-large plan into parts just papers over underspecified design; the correct fix is to decompose the feature itself.

**When the task list exceeds 15 after the complexity gate has already split everything it can** (the planner returns this condition with N instead of writing the plan; the orchestrator runs items 2-4):

1. **The planner does NOT write the plan.** No partial plan, no cutting into parts, no salvaging what it has.
2. **Stop and report to the user.** Say plainly: "This plan decomposes into N tasks, which exceeds the 15-task ceiling. The feature is too broad to plan as a single unit — the design needs to be narrowed or split into smaller features before planning can proceed."
3. **Use `AskUserQuestion` (or the equivalent available question/prompt tool) to offer next steps:**
   - **Narrow the scope** — Return to `feature-design` and reduce the feature's scope to something that fits in ≤15 tasks. Defer the cut work to a follow-up feature.
   - **Split into independent features** — Return to `feature-design` and redesign as two or more independent features, each with its own design, plan, and implementation cycle.
4. **Do not proceed to drafting the plan file until the user has chosen.** Both options hand off to `feature-design`. If the user instead insists via a free-text reply on proceeding with the oversized plan, warn once that large plans drift during execution and the ceiling exists for a reason — then re-dispatch the planner with the explicit override and let it draft.

## Waves and Dependencies

Group tasks into **waves** where tasks in the same wave can run in parallel and later waves depend on earlier ones. State dependencies explicitly (e.g., "Wave 2 depends on Wave 1 because routing needs the resolver contract from Task 1.2"). This is orchestration, not code — keep it in the plan.

**Same-wave tasks MUST have disjoint `Files:` sets.** Wave subagents share one working tree; two tasks touching the same file race each other. If two tasks need the same file, put them in different waves, merge them into one task, or split the file boundary differently.

**Disjoint `Files:` is necessary but not sufficient — shared build resources conflict too.** Two same-wave tasks in the same package/workspace are only parallel-safe if neither touches a shared build artifact: a lockfile (dependency installs), build/test configs (`tsconfig`, `pyproject`, bundler config), generated/codegen outputs, or a shared fixture both suites mutate. `Files:` is a proxy for the real resource — the package's build state. When such a resource is shared, put the tasks in different waves or merge them; `feature-implement`'s pre-wave overlap check enforces the same rule as the backstop.

**Wave size guidance:** a wave of more than 4 tasks — consider splitting in two; more than 6 — the plan must say why the size is safe (e.g. all complexity-1 mechanical edits). Validation cost grows non-linearly with wave size: one must-fix re-opens the whole wave. Defaults, not hard caps.

## Plan Document Header

**Every plan MUST start with this header:**

```markdown
# [Feature Name] Implementation Plan

> Use subagents to implement this plan task-by-task.

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

**Design:** [Markdown link to the design document]

**Design revision:** [the `Revision:` value of the design at planning time]

**Stakes:** [copied from the design header]

**Risks:** [persisted data: yes/no; external contracts: yes/no; migrations: yes/no; irreducible complexity-4 tasks: N — same flags the planner reports in its summary]

**Verification:** [ONE command or short scripted scenario that proves the feature works end-to-end — run by `feature-implement`'s final conformance step]

---
```

All links in the header MUST be markdown links, never bare paths. The `Design` line is required and must point to the saved design file you used as the planning source of truth. `Design revision` pins which version was planned — a later design amendment makes the mismatch visible instead of silent. `Risks:` duplicates the summary flags on purpose: the summary dies with the session, the plan file is what `feature-implement` and `feature-challenge` read. `Verification:` closes the gap between "all tasks green" and "the feature works" — per-task commands prove parts, this line proves the whole.

## Task Structure

Each task is prose with exact paths, a behavior contract, test cases, and verification commands. No code blocks of implementation or test bodies.

````markdown
### Task N: [Component Name]
<!-- Complexity: N -->

**Wave:** N (depends on: list of prior tasks, or "none")

**Files:**
- Create: exact path(s)
- Modify: exact path(s), with a hint of the area within the file
- Test: exact path(s)

**Contract:**
Public surface this task must expose. Type signatures are encouraged to pin parallel work — function shapes, input/output types, error cases.

**Behavior:**
Prose description of what the piece should do. Short inline snippets are fine where a name or call is clearer than prose. Do not inline full function bodies.

**Not in scope:** (optional)
One or two concrete temptations this task must resist — "do not touch the sibling endpoint", "do not refactor utility X while here". Fill only where the boundary is genuinely non-obvious; for trivial tasks the line is noise, omit it.

**Step 1: Write the failing test**

List the behaviors to cover as prose bullets — input, expected outcome, side effects to assert. No `it(...)` / `def test_...` blocks.

**Step 2: Run tests and confirm they fail**

Run: exact test command
Expected: FAIL with the reason (missing function, wrong return, etc.)

**Step 3: Implement the minimum to pass**

Implement the contract. Stay scoped to the listed behaviors.

**Step 4: Run tests and confirm they pass**

Run: exact test command
Expected: PASS for all listed cases.

**Step 5: Commit (orchestrator, policy-gated)**

The ORCHESTRATOR commits this task's files via the `feature-git-commit` skill with an appropriate conventional commit message, as the session's commitPolicy prescribes (`commit-authority` rule; default `auto` = commit once the task validates; `manual` = propose instead of committing). Task subagents never commit.
````

## No Placeholders

NEVER use angle-bracket placeholders like `<route>`, `<existing-file>`, or `<that-route>` in file paths, commands, or contracts. Every task uses concrete paths and names. Inventing a name is allowed ONLY for files this plan creates. For files that already exist, the path must come from the actual repo (the "Read the codebase before drafting tasks" step) — if the planner cannot locate the real file a task must modify, that is a returnable condition like any other underspecification, not a license to write a plausible guess into a task an implementer will execute against the wrong file.

## No Instrument-less Criteria

A criterion without an instrument is a vibe — the implementing agent will declare it met because nothing can tell it otherwise. In the task structure above, the instruments are the `Run:` commands with `Expected:` outputs: every Step-1 behavior bullet must be verifiable by the task's test commands. "Works correctly", "handles errors gracefully", "is performant" do not ship as bullets: restate as the observable a command can verify (which test passes, which grep returns zero hits, which threshold the benchmark prints). If a bullet is genuinely a human judgment call (visual polish, copy tone), label it `[JUDGMENT]` so `feature-implement` routes it to the user instead of a subagent self-grade.

## Remember
- Exact file paths always — no angle-bracket placeholders
- **No full code or test bodies** — contracts, behavior prose, and test-case lists only
- Type signatures and short inline snippets are allowed and encouraged where they clarify
- Exact commands with expected output — no placeholder paths in commands
- Use `feature-git-commit` skill for all commits (never raw git commands)
- DRY, YAGNI, TDD, frequent commits

## Iterating on a Saved Plan

Plans evolve. When the user accepts a "drop X" / "rename Y" / "move Z" edit during iteration on a saved plan, the change is not done until the entire document has been swept for stale references. The visible site of the removal is rarely the only site.

After every structural edit:

1. Apply the named change.
2. Grep the whole plan doc for the removed/renamed identifier and every shadow (e.g. removing a task field also catches the field's mention in dependency lists, verification commands, and risk notes; renaming a task id also catches cross-task `Depends on Task N` references).
3. Inspect each remaining hit. Decide: stale (remove or update) vs. intentional (leave + note why).
4. Report the sweep result before claiming done: "remaining mentions are intentional / all stale references cleaned."

If the user catches a stale reference after you've claimed done, run the sweep before re-claiming.

## Do Not Commit the Plan

The plan document MUST NOT be committed. Leave it unstaged. Only commit plan documents if the user explicitly asks.

## Optional Challenge Before Implementation

Offer a challenge on the plan after saving but before handing off to `feature-implement`. The challenge surfaces execution risks — wave dependency deadlocks, contract drift between parallel tasks, irreducible-4 tasks that hide unknowns, scope creep, sequencing errors that break production between deploys.

Ask via `AskUserQuestion` (or the equivalent available question/prompt tool): **"Challenge this plan before implementation?"** with options:

1. **Yes, challenge first** — Invoke the `feature-challenge` skill on the saved plan. After it produces its report, ask whether to revise the plan based on findings. If so, apply the revisions per the Execution Model's **Iteration** rule (small edits by the orchestrator; structural rework re-dispatches the planner). Proceed to the implementation handoff only once the user is satisfied.
2. **No, implement as-is** — Skip the challenge and proceed to the implementation handoff.

Recommend **yes** when any of these signals are present: the plan has tasks that landed at complexity 4, the plan touches persisted data or external contracts, the plan migrates a load-bearing premise, the plan has more than three waves, or the user has flagged stakes as high. Recommend **no** for small plans (≤3 tasks) with no irreducible 4s and no migration concerns.

Phrase the question with the recommendation in observable terms — never name complexity scores in chat, e.g. "I think yes because the plan has two tasks that could not be split further and a wave dependency on a persisted-state migration — recommend stress-testing before implementation. Confirm or correct?"

## Execution Handoff

After saving the plan (and after the optional challenge step above), ask the user using `AskUserQuestion` (or the equivalent available question/prompt tool): **"Plan saved to [filename](./docs/alex-loop/<feature-folder>/<NN-plan>.md). Shall I continue with implementation?"** (use a real markdown link to the actual file).

If yes, invoke the `feature-implement` skill with the plan file path as argument.
