---
name: feature-challenge
description: "Optional gate in the Alex Loop workflow (design, then plan, then implement). Stress-test a proposed design, plan, or finished branch by assuming it has already failed and working backward to find every reason why; surfaces blind spots, hidden assumptions, and concrete revisions before the work commits. Invoke ONLY when the user explicitly names this skill ('/feature-challenge', 'run feature-challenge on this') or when feature-design / feature-plan / feature-implement invoke it at their challenge gates. Do NOT self-trigger on generic phrases like 'challenge this', 'stress test this', or 'what could go wrong'."
---

<!-- Updated: 2026-07-12 11:53:50 UTC -->

**Announce at start:** "Using skill: **Feature Challenge** to stress-test the proposed work."

# Feature Challenge

## Delegation Boundary

Only the user-facing top-level agent may execute this skill's subagent or panel dispatch steps. Every dispatched prompt must say: **"You are a leaf worker. Do not call Agent, Task, Workflow, spawn_agent, or any equivalent delegation/subagent tool. Do the assigned work yourself and return to the parent. If you need further fan-out, return `NEEDS_PARENT_FANOUT` with the proposed independent work items; do not delegate them yourself."** If this skill is being followed inside an already spawned worker, that worker must not dispatch; it completes its assigned non-delegating scope itself or returns `NEEDS_PARENT_FANOUT` with proposed work items.

Stress-test a design, a plan, or a finished branch by assuming it has already failed six months from now. Work backward to find every reason why. Surface blind spots, hidden assumptions, and concrete revisions before the work commits.

Use the reframe as the load-bearing mechanism. Ask "this already failed, explain how" — not "what could go wrong?". Treat the frame as non-negotiable.

**Three artifact types, one engine.** A **design** challenge attacks the framing and assumptions; a **plan** challenge attacks execution risks (sequencing, contracts, waves); a **branch** challenge takes the branch diff (`git diff <base>...HEAD`) plus its plan and attacks the system that is about to ship — operational, migration, and load failure scenarios in the REAL code. A branch challenge is not a code review (that hunts line-level defects; `feature-implement`'s review pass owns it) — it hunts system-level failure stories the diff makes possible. Deep-dive subagents for a branch challenge read the actual diff and cited files; findings flow through the same synthesis, verification, and Step 7 revision machinery.

## Autonomous mode (feature-panel)

Run the repo-root opt-in check — `grep -qsE '^(<!-- *)?alex-loop: *autonomous( *-->)? *$' "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/CLAUDE.md" "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/AGENTS.md" "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/CLAUDE.local.md" "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/AGENTS.local.md" && echo ON` (anchored whole-line match — a quoted, negated, or prose mention must NOT activate the mode; checked-in `CLAUDE.md`/`AGENTS.md` plus their machine-local `CLAUDE.local.md`/`AGENTS.local.md` variants). If it prints ON, follow the `feature-panel` skill's **Autonomous mode** contract; otherwise behave as written below. In autonomous mode this stress-test usually runs as the feature-panel **challenge** engine (fan-out + verifying synthesis, iterated to unanimity), invoked by `feature-design` / `feature-plan`. Either way:

- **Step 7 (apply revisions):** do NOT wait for the user to accept revisions. The orchestrator auto-applies the synthesis's revisions to the design AND plan in lockstep, re-runs the stale-reference sweep, then continues the chain.
- **Design-level scope changes:** a revision that changes the approved design's problem framing or scope routes to `feature-design` (the re-entry point) so it lands at the single approval gate — do not silently auto-apply a scope expansion.

The analysis itself (context gathering, failure-reason generation, deep-dive subagents, synthesis) already runs without user questions, autonomous mode or not.

## Context gathering

Run fully autonomously. Do not ask the user questions.

Derive three things from available sources:

1. **What is it?** Describe the artifact in one sentence (the design or the plan).
2. **What does it touch?** List subsystems, files, contracts, persisted data.
3. **What does success look like?** State the outcome the artifact is meant to produce. Define failure as the inverse.

Pull context from, in order: the saved design or plan document, the conversation transcript, referenced code files, related artifacts in the feature's `docs/alex-loop/` folder. Read aggressively before generating failure reasons.

**Artifact root.** All `docs/alex-loop/` paths in this skill resolve against an artifact root: when a `docs.local/` folder already exists at the repo root, artifacts live under `docs.local/alex-loop/` instead — create the `alex-loop/` subfolder there if missing. Otherwise use `docs/alex-loop/` — create `docs/` and `docs/alex-loop/` if missing. NEVER create `docs.local/` itself: its pre-existence is the opt-in. When locating existing artifacts, check both roots.

**Feature folder name.** A new feature folder is `YYYY-MM-DD-<topic>`, or `YYYY-MM-DD-<ticket>-<topic>` when the work is tied to a numbered ticket (`RAM-123` style tracker key kept verbatim, `#123` normalized to `gh-123`), taken from the user's request / skill arguments first (a key presented as the work's ticket or a tracker / GitHub issue URL - `UTF-8`, `SHA-256`, `CVE-...`, "option #2" are not tickets), then from an issue-key segment in the current branch name when that branch is not the default branch and was clearly created for this work. Never invent or ask for a key; an existing feature folder is reused as-is, never renamed. Full rule: `feature-design` -> Saving the Design.

Infer when a piece is not stated explicitly. Note the inference in the saved report under an **Assumptions** section so the user can correct any wrong call. Proceed without pausing.

## How a challenge runs

### Step 1: Set the frame

State the frame explicitly:

"Context gathered. Running the challenge. Premise: it is six months from now. The [design / plan] has failed. Looking back to understand what went wrong."

Set the frame every time. Skipping it collapses the analysis into polite risk assessment.

### Step 2: Generate failure reasons

Generate every genuine failure reason in one pass. Use no prescribed categories during generation. Make each reason specific to this artifact, ground it in the actual context (files, contracts, dependencies), and confirm it represents a real threat — not a minor inconvenience or a wildly unlikely edge case.

State each reason in one or two sentences. Match the count to the artifact — three, eight, whatever is real. Do not pad to hit a target. Do not stop early.

**Coverage sweep (after free generation, never instead of it).** Check the generated list against this category seed: security; data loss/corruption; concurrency & races; performance degradation; migration & compatibility; operations (rollback, monitoring, incident response); external dependencies; human factor (misuse, onboarding). For each category with no reason, write an explicit "n/a — why" line. Free generation gives depth and specificity; the sweep gives breadth a single model family systematically lacks. The "n/a — why" forces a second's thought per category instead of a silent skip — but never invent a padded reason to fill a category.

**Scoring and deep-dive budget.** Score each surviving reason quickly: likelihood x damage, both low/med/high. Deep-dive allocation follows the design's `Stakes:` field — `high`: deep-dive everything med+; `medium`: top reasons by score; `low`: only high-likelihood x high-damage. Reasons not deep-dived still appear in the report as one-liners marked "not deep-dived" — a silently truncated list reads as "checked everything" when it wasn't.

### Step 3: Deep-dive subagents in parallel

Spawn one subagent per failure reason selected by the Step 2 deep-dive budget. Send all spawn calls in a single message for parallel execution — sequential spawning lets earlier responses bias later ones.

**Subagent prompt template:**

```
Investigate one assigned failure reason from a design or plan stress-test.

You are a leaf worker. Do not call Agent, Task, Workflow, spawn_agent, or any equivalent delegation/subagent tool. Do the assigned work yourself and return to the parent. If you need further fan-out, return `NEEDS_PARENT_FANOUT` with the proposed independent work items; do not delegate them yourself.

The artifact:
---
[full context: what it is, what it touches, what success looks like, plus relevant workspace context — design doc path, plan doc path, code references]
---

FRAME: Assume it is six months from now and this artifact has failed.

ASSIGNED FAILURE REASON: [the specific reason from step 2]

Go deep on this one failure. Write the story of how it played out. Use details from the artifact. Make it read like a case study of something that happened.

Produce three sections:

1. **Failure story** — Write a 2-3 paragraph narrative. Name specific moments, files, or commits where things went wrong and explain why. Mark invented specifics honestly: a real file/contract you read is cited as fact; a commit, incident, or metric you are imagining for the story is marked hypothetical ("(hypothetical)"). The story's value is the mechanism, not fabricated evidence.
2. **Underlying assumption** — Identify the one thing the user was taking for granted that made this failure possible. State it in one sentence.
3. **Early warning signs** — List 1-2 concrete observable signals that would indicate this failure mode is starting. Pick things you can see or measure, not vague feelings.

Keep total response under 300 words. Be direct. Do not hedge.
```

**Cross-family seat (if available and authorized).** Every deep-dive above runs on the host's model family, so a single-family blind spot survives no matter how many you spawn. Route at least one deep-dive through a different model family to break correlated bias. Runtime discovery, key safety, per-provider invocation patterns, AND the **Data egress** gate are governed by the session-injected `model-selection` rule — sending the artifact or code excerpts to another provider requires the egress authorization that rule defines (in-session permission or the repo-config allowlist); without it, treat cross-family as unavailable and note it. Seat mechanics:

- Send the Step 3 subagent template verbatim, prefixed: "You are an independent critic from a different model family. Investigate this failure on your own, with no deference to other analyses." Keep the same three-section output.
- Inline the artifact content — external curl/MCP seats cannot read local files; file paths work only for seats with local execution (CLI harnesses).
- Fold the output back as one more Step 3 deep-dive in the Step 4 synthesis. A finding only the cross-family seat raised is high-signal — surface it explicitly.
- A dead harness: skip it and continue; never fail the challenge over a missing external model. If nothing cross-family is reachable, note "single-family challenge — correlated bias risk" in the Step 4 synthesis.

### Step 4: Synthesize

Read every deep-dive. **Verify before synthesizing:** deep-dive narratives are generated under an "it already failed" frame and can hallucinate specifics. For each deep-dive, re-read the files, contracts, and commits its failure story cites and check the load-bearing claim against the actual artifact. A reason contradicted by the code (the cited contract doesn't exist, the file already handles the case, the sequencing it attacks isn't in the plan) is dropped or downgraded — record each drop with its reason in the saved report under a **Dropped findings** section. Only verified reasons feed the synthesis; hallucinated findings must not flow into applied revisions.

Produce the synthesis report:

1. **Most likely failure** — Identify the most probable scenario given the context. Explain why. Address it first.
2. **Most dangerous failure** — Identify the scenario that causes the most damage if it lands, even if less likely. Insure against it.
3. **Hidden assumption** — Surface the single biggest unquestioned assumption across all analyses. Treat this as the highest-value finding.
4. **Revised artifact** — Specify concrete changes that make the design or plan more resilient. Map each revision to a specific failure scenario. Write in actionable terms — "run the migration against a 100-row staging sample with rollback before applying to production," not "consider testing the migration."
5. **Pre-execution checklist** — List 3-5 things to verify, test, or put in place before executing. Map each to a failure mode identified above.

### Step 5: Save the report

Save the full output to the challenged artifact's feature folder as `docs/alex-loop/YYYY-MM-DD-[<ticket>-]<topic>/NN-challenge.md` (`NN` = next free two-digit prefix among `*-challenge.md` files; challenges are numbered independently of designs and plans, so the first is `01-challenge.md`. When challenging a pre-save design, create the feature folder now — the challenge is `01-challenge.md` and the design saves as `01-design.md` independently) containing:

- The context gathered (what, what it touches, success criteria)
- An **Assumptions** section listing any inferences made during context gathering
- The raw failure reasons from step 2
- All subagent deep-dives
- The **Dropped findings** from step 4's verify pass (each with the code evidence that contradicted it)
- The synthesis from step 4
- A markdown link back to the design or plan that triggered the challenge. When the artifact is not saved yet (a design challenged pre-save from `feature-design`), write "challenged pre-save" plus the intended save path instead — `feature-design` replaces it with the real link when it saves.

Do NOT commit the challenge document. Leave it unstaged.

### Step 6: Report concisely in chat

Summarize in chat: most likely failure, hidden assumption, single most important revision. Keep it to three sentences. Point to the saved file for full detail.

### Step 7: Apply revisions to design AND plan in lockstep

Challenges run against a design (saved or presented pre-save) and often a saved plan. The synthesis report's "Revised artifact" section typically calls for changes that ripple into BOTH documents (pre-save: apply to the in-conversation design; the sweep below runs when it saves):

- A revision that names a missing assumption usually changes the **design** (its problem framing, areas affected, migration considerations, testing strategy).
- A revision that names a missing task, sweep, or sub-step usually changes the **plan** (task list, acceptance criteria, verification commands).
- A revision that names a missing concept (e.g. a new shadow source-of-truth, a new persistence boundary) usually changes BOTH — the design's problem framing AND the plan's task structure.

When the user accepts revisions (or, in autonomous mode, on auto-apply per **Autonomous mode** above), classify each one and apply it to the right document(s). Do not patch only the plan when the design's load-bearing assumption was the thing that failed. Apply both edits in lockstep, then sweep each affected document for stale references:

1. Apply the named change.
2. Grep the whole document for every removed/renamed identifier and its shadows (aliases, cross-section examples, dependency mentions, verification commands that still reference it).
3. Inspect each remaining hit: stale (remove or update) vs. intentional (leave, note why).
4. Report the sweep result before claiming the revision applied — "all stale references cleaned / remaining mentions intentional."

**Close the pre-execution checklist — no dangling items.** The checklist is a commitment, not an appendix: each item either becomes a concrete change (a plan task, a design revision — applied through the lockstep mechanics above) or is explicitly marked in the saved `NN-challenge.md` as `accepted risk — by whom / why`. No third state. `feature-implement` checks for unresolved checklist items at plan load and warns before launching.

Only after both documents reflect the revised understanding should the next skill in the chain (typically `feature-implement`) be invoked.

Diagnostic signal: an implementation that "discovers" a load-bearing assumption mid-execution — surfacing it as drift — is usually a sign Step 7 was skipped, and a design-level revision was patched only into the plan.

## Output format

Produce one file per challenge:

```
docs/alex-loop/YYYY-MM-DD-[<ticket>-]<topic>/NN-challenge.md
```

Plus a three-sentence chat summary so the user sees the headline without opening the file.

## Example: challenging a refactor plan

**Artifact:** A plan to consolidate three per-call-site retry helpers into one centralized retry middleware. Plan has 8 tasks across 5 files.

**Raw analysis identifies 5 failure reasons:**

1. The middleware assumes all three call sites share the same idempotency contract; one of them does not, and a retry on it double-charges users.
2. The middleware lives at the request boundary, but one call site invokes the retried function from a background worker — wrong layer, retries never trigger.
3. The new middleware adds a hidden 30-second timeout the original helpers did not have; one call site's slow path now fails where it used to succeed.
4. The migration sequencing is wrong — Wave 2 deletes the old helpers before Wave 3 finishes wiring the last call site, leaving production broken between deploys.
5. The contract pinned in Task 1 does not surface the original retry-budget parameter; existing call sites silently drop their per-call budgets and inherit a single global one.

**5 subagents go deep on each reason in parallel** — failure stories, underlying assumptions, early warning signs.

**Synthesis:** Most likely failure is the wrong-layer call site (the background worker). Most dangerous is the idempotency mismatch — silent double-charges are far worse than a noisy retry-not-firing bug. Hidden assumption: that "retry helper" means the same thing at all three call sites; it does not. Revised plan: add Task 0 to audit each call site's retry contract, add a parallel task to keep the old helpers for one release after the new middleware ships, defer the deletion to a follow-up plan.

## Notes

- **Treat the synthesis as the product.** Most readers skim the deep-dives and read the synthesis. Make it specific and actionable.
- **Do not soften.** Surface what the user does not want to hear before reality does. Say it directly.
- **Write revisions as concrete actions.** Map each one to a specific failure scenario the user can act on this week.
