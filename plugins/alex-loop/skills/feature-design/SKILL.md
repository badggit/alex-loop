---
name: feature-design
description: "Step 1/3 of the Alex Loop workflow (design, then plan, then implement). Collaborative design exploration before coding: explores intent through clarifying questions, proposes approaches with trade-offs, and produces an approved design before any code is written. Invoke ONLY when the user explicitly names this skill or Alex Loop ('/feature-design', 'use feature-design', 'start Alex Loop'), or when another Alex Loop skill routes here (feature-fix escalation, re-entry from feature-plan / feature-implement). Do NOT self-trigger on generic requests like 'build a feature', 'I want to add X', or 'refactor Y' — and never for bug-shaped work with a known end-state (that is feature-fix, also explicit-only)."
argument-hint: "<idea or request> [interview depth hint, e.g. 'ask more questions' / 'keep questions minimal']"
---

<!-- Updated: 2026-10-14 00:48:00 UTC -->

**Announce at start:** "Using skill: **Feature Design** (step 1/3) to explore your idea before writing code."

# Feature Design

## Delegation Boundary

Only the user-facing top-level agent may execute this skill's subagent or panel dispatch steps. Every dispatched prompt must say: **"You are a leaf worker. Do not call Agent, Task, Workflow, spawn_agent, or any equivalent delegation/subagent tool. Do the assigned work yourself and return to the parent. If you need further fan-out, return `NEEDS_PARENT_FANOUT` with the proposed independent work items; do not delegate them yourself."** If this skill is being followed inside an already spawned worker, that worker must not dispatch; it completes its assigned non-delegating scope itself or returns `NEEDS_PARENT_FANOUT` with proposed work items.

## Overview

Turn ideas into fully formed designs through collaborative dialogue. Understand the project context, ask questions one at a time to refine the idea, then present the design and get user approval.

**CRITICAL GATE: Do NOT write any code or take any implementation action until you have presented a design and the user has approved it.** This applies to EVERY project regardless of perceived simplicity.

**Skip this skill entirely if an approved design already exists.** If the user points to an existing design doc under `docs/alex-loop/`, a prior approved design in this session, or otherwise signals that the design phase is already done, do NOT re-run brainstorming. Instead, confirm briefly that you will use the existing design and hand off directly to `feature-plan`. Only re-enter brainstorming if the user explicitly asks to revise the design.

**Route out if this is a fix, not a design.** If the request is a bug, a regression, or a mechanical change with a known intended end-state (rename, bump a value, correct wrong output), it does not need a design — hand to `feature-fix` and stop. Stay in `feature-design` only when the correct behavior itself needs a decision. A change that turns out mid-investigation to need a design decision routes back here from `feature-fix`.

**No feature is too small to skip this.** A one-function utility or a config-shaped feature still gets a one-sentence design, presented and approved — unexamined assumptions cause the most wasted work exactly where the change looks trivial. But this applies only to *new or changed behavior that needs a decision*. A bug fix, regression, or mechanical change with a known intended end-state is not a design — route it to `feature-fix`.

**Stay in design exploration until the design is saved and approved.** Do NOT slide into task scoping, wave decomposition, file-path enumeration, or implementation breakdown mid-skill. Those are downstream concerns owned by `feature-plan` and `feature-implement`. If the user has invoked `feature-design`, they want the abstract design — not a task list. Stay abstract: problem framing, proposed behavior, areas affected, data flow. The moment you catch yourself writing "Task 1: ...", stop and return to design-level prose.

**FIRST, before running the Process below:** run the autonomous opt-in check (see **Autonomous mode** near the end of this file). If it is on, the per-step user gates in Sections 1, 3a, and 4 — the one-question-at-a-time interview, the echo-back confirmation, and the section-by-section "looks right?" asks — do NOT run as separate blocking prompts. They collapse into the single design-approval gate as that section describes.

## Tool Usage

**Use `AskUserQuestion` for ALL clarifying questions, or the equivalent available question/prompt tool if `AskUserQuestion` is unavailable.** Never ask in plain text. Prefer multiple-choice options (2-4 plus automatic "Other").

## The Process

### 1. Understanding the idea

> Interview the user relentlessly about every aspect of the design until shared understanding is reached. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide a recommended answer. Ask the questions one at a time. Before any question, comb the codebase for traces of the answer; ask only what code cannot reveal.

**How to apply:**

- Treat the design as a **tree of decisions**: scope -> success criteria -> hard constraints -> non-functional requirements (when applicable) -> proposed behavior -> data flow -> error handling -> testing strategy -> migration (when applicable). Walk it in dependency order.
- **The non-functional node is conditional — open only the sub-branches the feature actually touches:** performance targets when the change sits on a hot path; security & privacy when it handles user data, auth, or external input; accessibility & i18n when it has a UI surface; observability when it adds a service, background process, or new failure mode worth monitoring. A feature touching none of these skips the node entirely. An NFR that first surfaces at challenge or implement costs a design revision cycle — one interview question here is cheaper.
- **Watch for a multi-feature request while resolving scope.** If the request spans several independent user scenarios or several subsystems that share no core (the cheap heuristic: the scenarios would not reuse each other's behavior), propose splitting into 2-3 features with separate `docs/alex-loop/` folders and an execution order — before any of them is designed in depth. The 15-task ceiling in `feature-plan` remains the downstream backstop; catching the split here saves a full planner run.
- **Comb the codebase first.** Before each question, search code, docs, configs, and recent commits for traces of the answer. Reserve questions for what the codebase cannot reveal: intent, preferences, business constraints.
- **Ask one question at a time** via `AskUserQuestion` (or the equivalent available question/prompt tool). Never batch.
- **Every question carries a recommended answer.** Phrase as `"I think X because Y. Confirm or correct?"` — never ask cold. The recommendation must be grounded in what you read or what is conventional in this project. If you have no basis for one, say so and ask outright rather than fabricating a default.
- **One decision per question.** Multi-part questions hide disagreements. Split them.
- **Multi-choice when the answer space is small and enumerable** (2-4 options plus automatic "Other"); open-ended when it genuinely isn't.
- **Resolve upstream before downstream.** Do not interview about a downstream branch (e.g. error handling) until upstream branches it depends on (e.g. proposed behavior) are settled. If a later answer would change an earlier one, surface that and revisit the earlier decision before continuing.
- **Stop only when every branch in the tree is resolved.** Resolved = answer recorded, user confirmed (or codebase-confirmed via a fetched / read source), no surfaced dependency still open. Do not stop early because a question feels obvious; do not pad with questions whose answers would not change the design.
- **Stay in scope.** A relentless walk does not mean inventing branches. If a branch is not in the user's request, do not graft it on; record it under **Out of scope** in the design instead of interviewing about it.

**Interview depth.** Question volume is resolved once, before the first question, and honored for the whole interview. Resolution order, first match wins:

1. A plain-language hint in the invocation or conversation ("ask more questions", "the task is vague — dig deep", "keep questions minimal") — overrides everything for this run.
2. A repo-root `alex-loop design-questions:` directive — anchored whole-line match, same file set and convention as the autonomous check: `grep -hsE '^(<!-- *)?alex-loop design-questions: *(auto|few|medium|many)( *-->)? *$' "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/CLAUDE.md" "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/AGENTS.md" "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/CLAUDE.local.md" "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/AGENTS.local.md"` (a machine-local value wins over a checked-in one on conflict).
3. Neither present → `auto`.

The levels (hints map onto them: "more questions" → `many`, "keep minimal" → `few`):

- **`many`:** walk secondary branches too (naming, UX details, error handling, migration); prefer asking over inferring even where the codebase hints at an answer.
- **`medium`:** ask the primary-branch decisions (scope, success criteria, hard constraints, proposed behavior); infer secondary branches from code and conventions, asking only where inference has no basis; record every inference under **Assumptions** in the design.
- **`few`:** ask only decisions that block the design; infer the rest from code and conventions, recording every inference under **Assumptions** in the design so the approval gate reviews them.
- **`auto`:** default adaptive behavior — stop when every branch is resolved.

Autonomous mode supersedes this setting: its interview does not run interactively at all (see **Autonomous mode**), whatever `design-questions` says.

### 2. Research

Ground yourself in reality before proposing approaches. Scale effort to complexity.

- **Read relevant files, configs, and recent commits** in the affected area.
- **Consult current docs** for any library, API, or CLI involved — do not rely on memory.
- **The top-level agent dispatches one leaf exploration subagent** for complex or cross-cutting work (touches 3+ subsystems, unfamiliar domain, or user flags complexity), including the **Delegation Boundary** clause in its prompt.
- Form a short internal research brief (findings, constraints, unknowns). Do not save it as an artifact unless asked.

### 3. Exploring approaches

- Propose 2-3 different approaches with trade-offs
- Present options conversationally with your recommendation and reasoning
- Lead with your recommended option and explain why
- Example: "I see three approaches here: 1) [Recommended] Use X because... 2) Use Y but it has downside Z... 3) Use W but..."
- **Record the outcome for the document.** Each approach NOT chosen becomes one line in the design's **Alternatives considered** section: name + the reason it lost. Full trade-off discussion stays in the chat; the document keeps just enough that a later reader (re-entry, challenge, a future you) does not re-propose an already-rejected approach.

### 3a. Echo back before designing

Before presenting any design, you MUST echo the user's intent back for confirmation. Use `AskUserQuestion` (or the equivalent available question/prompt tool) with a single summary of the problem, constraints, and success criteria as you understood them, and ask the user to confirm or correct. Do not skip this step — it is the last chance to catch a wrong premise before the design is written. If the user corrects any item, update your understanding and echo again. Only proceed to the design once the echo is confirmed.

### 4. Presenting the design

- Present the design section by section. Scale each section to complexity (a sentence to 200-300 words).
- Ask after each section whether it looks right.
- Cover relevant aspects: problem, current state, proposed behavior, data flow, areas affected, error handling, testing strategy.
- Go back and clarify whenever something doesn't make sense.

### The design is abstract, not technical

The design is the ideation output, not an implementation plan. It describes *where we are* and *where we want to be* — not how to get there file-by-file.

**Do NOT include:** file paths, concrete class/function/command names from the codebase, concrete store identifiers, implementation code blocks, type signatures, interfaces, schemas.

**DO include:** the problem and why it matters; just enough current-state to motivate the change; roles and responsibilities described abstractly (what each piece is *for*, not what it's *called*); user-facing syntax, formats, or interaction examples; data flow described in prose or ASCII; an **Areas affected** section naming coarse subsystems — never file paths.

The "user-facing" allowance is broader than it is sometimes read: a textual UI sketch (screens, states, what the user sees and does — no component names, no CSS) and a user-facing API or data contract (the wire format a consumer sees — no internal type names) are *behavior*, not implementation, and belong in the design when the feature has such a surface. Leaving them out does not make the design more abstract — it makes the implementer invent them.

Rule of thumb: a reader should understand **what the system will do** without learning **how the code is organized**. Identifier choices, file layout, and APIs are decisions for the plan and the implementer.

### Stay in scope (YAGNI)

Do not silently add features, subsystems, persistence layers, telemetry, sync, or integrations that the raw request did not ask for. If you believe an addition is necessary to make the feature work, surface it explicitly under an **Assumptions** section at the top of the design, or under an **Out of scope** section at the bottom. Never invent scope in the middle of the design as if it were part of the original ask. When in doubt, prefer the smaller design — the user can always ask for more.

### Design sections to consider

**For most projects, cover:**
- **Problem**: What's broken or missing and why it matters
- **Current state** (optional): Only as much as needed to motivate the design
- **Proposed behavior**: What the system will do, described abstractly
- **Data flow**: How information moves through the system (prose, no function names)
- **Areas affected**: Coarse subsystems touched — never file paths
- **Alternatives considered**: One line per rejected approach from Section 3 — name + why it lost. Omit only when a single approach was ever on the table.
- **Non-functional requirements** (when applicable): The perf targets, security/privacy constraints, accessibility/i18n expectations, or observability needs surfaced by the interview's NFR node. Skip when the node was skipped.
- **Migration considerations** (when applicable): If the change touches persisted data, config formats, external contracts, or existing user-facing behavior, cover forward/backward compatibility, data backfill, rollout order, and rollback strategy. For a user-visible behavior change, also state the rollout mechanism when one is warranted — feature flag, canary/staged enablement, enable order across surfaces — and how the behavior is rolled back if it misfires. Skip this section entirely when nothing stateful or contractual is changing — do not manufacture migration work.
- **Error handling**: How failures are detected and handled
- **Testing strategy**: How you'll verify it works

**Scale to fit:** A simple script might only need 1-2 sections. A complex feature needs all of them.

## Autonomous mode (feature-panel)

FIRST run the repo-root opt-in check — `grep -qsE '^(<!-- *)?alex-loop: *autonomous( *-->)? *$' "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/CLAUDE.md" "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/AGENTS.md" "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/CLAUDE.local.md" "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/AGENTS.local.md" && echo ON` (anchored whole-line match — a quoted, negated, or prose mention must NOT activate the mode; the repo-root instruction files — `CLAUDE.md`/`AGENTS.md` under Claude Code / Codex, plus their machine-local `CLAUDE.local.md`/`AGENTS.local.md` variants — NOT the global `~/.claude/CLAUDE.md` or `~/.codex/AGENTS.md`). If it prints ON, follow the `feature-panel` skill's **Autonomous mode** contract; otherwise behave as written below.

The design-approval gate is the one human checkpoint and is never skipped. Everything that would otherwise interrupt before it collapses INTO it — the user sees one worked proposal, not a stream of prompts:

- **Section 1 (interview):** do NOT ask one question at a time. Comb the codebase, docs, configs, and commits aggressively and infer every answer code can reveal. Reserve only genuinely blocking decisions code cannot resolve; carry them into the approval proposal as flagged options with a recommended default each — never as separate `AskUserQuestion` prompts.
- **Section 3a (echo-back):** do NOT issue a separate confirmation ask. Fold the intent summary (problem, constraints, success criteria, inferred answers, assumptions) into the single approval proposal.
- **Section 4 (presenting):** do NOT ask after each section. Present the complete design once, at the approval gate.
- **Optional Challenge:** skip the "Challenge this design before saving?" ask; auto-run a feature-panel **challenge** to unanimity before requesting approval.
- **After Design Approval:** skip the "Shall I continue with the implementation plan?" ask; on approval, invoke `feature-plan` directly with the saved design path.

This skill is also the **re-entry point** when downstream execution (feature-plan / feature-implement) hits a genuinely ambiguous requirement or a scope question. In autonomous mode it resolves the decision itself via the **Decision protocol** (council + independent-model seat; see `feature-panel` Autonomous mode) — discuss + challenge panels supply the council — records the rationale in the plan/design file, and continues; it re-enters the human approval gate ONLY for an irreversible scope expansion beyond the approved design, or a council deadlock on a high-stakes premise. Non-autonomous: run discuss + challenge panels to produce a concrete proposal (options + recommended default, assumptions flagged), then request approval — never a cold question.

## Optional Challenge Before Save

Offer a challenge before saving, once the design is presented and the user is ready to approve. The challenge stress-tests the design while it can still change cheaply.

Ask via `AskUserQuestion` (or the equivalent available question/prompt tool): **"Challenge this design before saving?"** with options:

1. **Yes, challenge first** — Invoke the `feature-challenge` skill on the current design. After it produces its report, ask whether to revise the design based on the findings, then loop back to "Presenting the design" if so.
2. **No, save as-is** — Skip the challenge and proceed to save.

Recommend **yes** when the document's `Stakes:` field (see **Saving the Design**) is `high`, or when any of its signals are present: the design touches persisted data, changes external contracts, modifies a load-bearing premise, blocks rollback, affects security or auth. Recommend **no** for trivial reversible changes (rename, single-file utility, cosmetic tweak) — the cost outweighs the benefit. Downstream consumers (`feature-plan`, `feature-challenge`) read the same `Stakes:` field instead of re-deriving stakes on their own.

Phrase the question with the recommendation, e.g. "I think yes because this design changes the persisted shape of X — recommend stress-testing before save. Confirm or correct?"

## Iterating on a Saved Design

Designs evolve. When the user accepts a "drop X" / "rename Y" / "move Z" edit during iteration on a saved design, the change is not done until the entire document has been swept for stale references. The visible site of the removal is rarely the only site.

After every structural edit:

1. Apply the named change.
2. Grep the whole design doc for the removed/renamed identifier and every shadow (e.g. removing `Foo` also catches `FooType`, `FooKind`, `is_foo`, `foo_value` — and any cross-section example or migration note that still references it).
3. Inspect each remaining hit. Decide: stale (remove or update) vs. intentional (leave + note why).
4. Report the sweep result before claiming done: "remaining mentions of X are intentional / all stale references cleaned."

The user catching a stale reference after you've claimed done means the sweep wasn't run — run it before re-claiming. The sweep is mandatory for any structural removal or rename during design iteration.

## Amending an Approved Design

Design approval is the loop's one mandatory human checkpoint — silently mutating the document afterwards devalues the gate. Once `Status: approved`:

- Section bodies are never edited in place. A change lands as a dated block appended to the document — `## Amendment N — YYYY-MM-DD (source: challenge | re-entry | decision-protocol | user)` — with a short description of what changed and why. Bump the header's `Revision:` with each amendment.
- **Material amendments** (changed behavior, contracts, data shapes, migration approach) require re-approval — in autonomous mode this is one of the asks that does reach the user. **Cosmetic amendments** (wording, stale-reference cleanup from the sweep above, added clarifying examples) do not.
- A design whose direction is being replaced outright is not amended — mark it `Status: superseded` and write a new `NN-design.md`.

Downstream artifacts note which revision they were built from, so a later reader can see whether a plan predates an amendment.

## Saving the Design

Write every approved design to `docs/alex-loop/YYYY-MM-DD-[<ticket>-]<topic>/NN-design.md` before handing off to planning. A conversation-only design is not enough for `feature-plan`; the saved document becomes the source of truth for the plan.

**Artifact root.** All `docs/alex-loop/` paths in this skill resolve against an artifact root: when a `docs.local/` folder already exists at the repo root, artifacts live under `docs.local/alex-loop/` instead — create the `alex-loop/` subfolder there if missing. Otherwise use `docs/alex-loop/` — create `docs/` and `docs/alex-loop/` if missing. NEVER create `docs.local/` itself: its pre-existence is the opt-in. When locating existing artifacts, check both roots.

**Feature folder name.** `YYYY-MM-DD-<topic>` by default; `YYYY-MM-DD-<ticket>-<topic>` when the work is tied to a numbered ticket (e.g. `2026-10-13-ABC-123-oauth-provider`). Ticket sources, first hit wins: (1) the user's request or skill arguments, where the key is presented as the work's ticket - a tracker key matching `[A-Z][A-Z0-9]+-[0-9]+` (e.g. `ABC-123`) named as the ticket / issue / task or given as a tracker URL, a GitHub ref (`#123` / `gh-123`) used as an issue reference, or a GitHub issue URL (`.../issues/123` means `gh-123`); (2) an issue-key segment in the current branch name (`git branch --show-current`), only when that branch is not the default branch and was clearly created for this work (its slug matches the request) - a branch left over from earlier work does not count. Standards and identifiers that merely share the shape are not tickets: `UTF-8`, `SHA-256`, `ISO-8601`, `HTTP-2`, `CVE-2024-...`, `RFC-...`, and `#2` meaning "option 2" or "step 3". Normalization matches `feature-git-branch`: a tracker key keeps its casing verbatim, `#123` becomes `gh-123`. A reference without a number (a bare tracker name, a ticket title) is not a ticket. Never invent a key and never ask for one just to name the folder - no ticket means the plain form. `<topic>` is a short kebab-case slug that does not repeat the key. Announce the folder name, and where the key came from, before the first save so the user can correct it; once created, an existing feature folder is reused as-is, never renamed.

**Document header.** Every saved design starts with four identity lines — a file's existence must never be mistaken for its approval:

```
**Status:** approved            (draft | approved | superseded)
**Approved:** 2026-07-28        (blank while draft)
**Revision:** 1                 (incremented by each amendment)
**Stakes:** high — touches persisted billing data   (low | medium | high, one-line justification)
```

`Stakes` is assessed at the end of the interview: what the feature puts at risk — persisted data, external contracts, security surface, reversibility. It is the single stakes source for the whole loop: the challenge recommendation here, panel sizing in `feature-challenge`, and risk framing in `feature-plan` all read this field instead of re-deriving it (and possibly disagreeing). A design saved without approval (rare — e.g. handed off for async review) carries `Status: draft`; `feature-plan` must refuse to plan from a draft.

The dated topic folder is the feature's artifact home — designs, plans, challenges, and fix records for one feature all live in it. Create it on first save. **Each document type is numbered independently:** `NN` is the next free two-digit prefix among files *of that type* (`01-design.md` for the first design; a feature that outgrows one design gets `02-design.md`). Plans, challenges, and fixes each keep their own count starting at `01` (`01-plan.md`, `01-challenge.md`, `01-fix.md`), regardless of how many designs exist.

When saving:

- **Do NOT commit the design document.** Leave it unstaged. Only commit design docs if the user explicitly asks.
- Any links to other documents (plans, related designs, issues) must be written as **markdown links**, e.g. `[the plan](01-plan.md)` within the feature folder, or a relative path across folders. Never paste bare paths.
- If a pre-save challenge produced a report in the feature folder, replace its "challenged pre-save" placeholder with a markdown link to the just-saved design.

## After Design Approval

Once the user approves the design, save it per **Saving the Design** above, confirm the saved path to the user, and then use `AskUserQuestion` (or the equivalent available question/prompt tool) to ask: **"Design approved and saved. Shall I continue with the implementation plan?"** with options:

1. **Yes, write the plan** — Invoke the `feature-plan` skill to break the design into tasks.
2. **No, stop here** — Leave the design as-is; the user will drive next steps.
