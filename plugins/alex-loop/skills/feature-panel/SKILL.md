---
name: feature-panel
description: "Multi-agent utility used by the Alex Loop workflow. Run a multi-agent \"fan-out analysts, then verified synthesis\" Workflow over a work-list, in one of four modes (discuss / challenge / gap / review); each analyst returns structured findings, a synthesis pass adversarially re-reads the cited code, and challenge/review modes iterate to a unanimous verifier panel. Invoke ONLY when the user explicitly names this skill ('/feature-panel', 'use feature-panel') or when another alex-loop skill delegates to the panel engine (challenge/review gates, autonomous mode, decision protocol). Do NOT self-trigger on generic requests like 'review this diff' or 'get a second opinion'."
---

<!-- Updated: 2026-07-10 15:24:36 UTC -->

# Feature Panel

## Delegation Boundary

Only the user-facing top-level agent may run this multi-agent workflow. Every analyst, synthesizer, verifier, and council seat is a leaf worker and must receive: **"You are a leaf worker. Do not call Agent, Task, Workflow, spawn_agent, or any equivalent delegation/subagent tool. Do the assigned work yourself and return to the parent. If you need further fan-out, return `NEEDS_PARENT_FANOUT` with the proposed independent work items; do not delegate them yourself."** If this skill is invoked inside an already spawned worker, do not run `Workflow`, `Agent`, a council, or any fallback fan-out; return `NEEDS_PARENT_FANOUT` with the work-list so the top-level caller can run it.

Multi-agent analysis as one reusable Workflow shape: **fan out independent analysts over a work-list, then a synthesis pass that verifies (re-reads cited code) rather than trusts.** Four modes share one engine; only the work-list, the two schemas, the synthesis verb, and whether the result iterates to unanimity differ.

**Announce at start:** "Using skill: **Feature Panel** to fan out + verify."

**Prerequisite:** the Workflow tool must be available (multi-agent orchestration opted in). If it is not, say so and run the **host-neutral fallback** with the same guarantees — do not improvise a weaker protocol:

1. **Analyze** — dispatch the analysts as parallel `Agent` (or equivalent) calls, one per work-list item, same prompts and leaf-worker clause; apply the same retry-then-exclude accounting as the script (a failed analyst gets one retry, then a different agent type, then explicit exclusion with a reason).
2. **Synthesize** — the orchestrator synthesizes INLINE (this is its defining work; do not spawn a synthesis helper), applying the mode's verify-the-citations rule itself.
3. **Verify (challenge/review)** — K=3 sequential independent verifier calls with the VOTE contract; the orchestrator counts rounds manually and enforces `maxRounds` and the exactly-K unanimity rule below by hand.
4. If the host cannot dispatch parallel workers at all, state plainly that the iterate-to-unanimity modes are unavailable in this environment and offer the single-pass modes only — an honest limitation beats a fake unanimity.

## When to use which mode

| Mode | Work-list items | Synthesis verb | Iterate to unanimity | Output consumed by |
|---|---|---|---|---|
| **discuss** | questionable design elements | reconcile -> brief + owner-decisions | no | `feature-design` |
| **challenge** | failure-attack areas | classify must/should/accept + verdict | **yes** | revise design/plan, then re-challenge |
| **gap** | capabilities (reference vs current) | dedupe -> prioritized backlog | no | `feature-plan` |
| **review** | code dimensions of a diff | re-read each cited `file:line`, drop unconfirmed -> confirmed findings + verdict | **yes** | apply fixes, then re-review |

The load-bearing rule for challenge + review: **synthesis verifies every finding against the actual cited code and drops misreads.** Never skip it.

Discuss and gap have no unanimity loop, but they are not exempt from grounding: after synthesis, ONE lightweight read-only subagent re-reads the `file:line` citations in the final brief/backlog and flags misreads; the orchestrator corrects or drops flagged items before relaying. No iteration, no votes — just the misread filter, because the worst deliberative-mode failure is a recommendation confidently built on misread code.

## Inputs (caller supplies; keep the engine project-agnostic)

1. **preamble** — one paragraph: what the system is, the goal, and "ACCEPTED CONSTRAINTS (do not relitigate): ...". Always include "read the cited files on BOTH sides, cite file:line, recommend the smallest correct change. A finding requires a concrete violation with a file:line cite — do not manufacture findings to have something to return; ZERO findings is a valid result."
2. **work-list** — array of `{ key, title, read, question }`. `read` = a single string of exact file/dir paths to read (both reference and current), interpolated verbatim into the analyst prompt (e.g. `"Ref: /a/x.zig:1-90. Current: /b/y.swift"`). `question`/`focus` = the one thing this analyst decides.
3. **mode** — discuss | challenge | gap | review (selects the schemas + synthesis verb + iterate flag below).

Everything project-specific lives in the preamble + work-list. The script template below is the only code.

## Engine — canonical Workflow script

Author this inline and pass to the Workflow tool. Fill `PREAMBLE`, the work-list, and the two schemas from the chosen mode.

```js
export const meta = {
  name: '<topic>-<mode>',
  description: '<one line>',
  phases: [{ title: 'Analyze' }, { title: 'Synthesize' }, { title: 'Verify' }],
}
const MODE = '<discuss|challenge|gap|review>'
const LEAF = `You are a leaf worker. Do not call Agent, Task, Workflow, spawn_agent, or any equivalent delegation/subagent tool. Do the assigned work yourself and return to the parent. If you need further fan-out, return NEEDS_PARENT_FANOUT with the proposed independent work items; do not delegate them yourself.`
const PREAMBLE = `${LEAF}\n\n<project context + accepted constraints + "read both sides, cite file:line">`
const ITEMS = [ { key, title, read, question }, /* ... */ ]
const FINDING = { /* mode's per-analyst JSON schema */ }
const SYNTH   = { /* mode's synthesis JSON schema */ }
const VOTE = { type:'object', additionalProperties:false, required:['mustFixFound','reason'],
  properties:{ mustFixFound:{type:'boolean', description:'true ONLY if a concrete surviving must-fix exists; false when none survive'},
               reason:{type:'string', description:'the surviving must-fix with file:line, or why none survive'} } }

phase('Analyze')
const prompt = (it) => `${PREAMBLE}\n\n=== ${it.title} ===\n${it.question}\n\nREAD: ${it.read}\n\nReturn findings for this item only.`
const raw = await parallel(ITEMS.map((it) => () =>
  agent(prompt(it), { label: `panel:${it.key}`, phase: 'Analyze', agentType: 'Explore', schema: FINDING })))
// null slot = failed/skipped analyst; retry once same type, once via a different agent type,
// then EXCLUDE the item explicitly — never silently drop it, never let it wedge the whole panel
const reports = [], excluded = []
for (let i = 0; i < ITEMS.length; i++) {
  let r = raw[i]
  if (!r) r = await agent(prompt(ITEMS[i]), { label: `panel:${ITEMS[i].key}:retry`, phase: 'Analyze', agentType: 'Explore', schema: FINDING })
  if (!r) r = await agent(prompt(ITEMS[i]), { label: `panel:${ITEMS[i].key}:retry2`, phase: 'Analyze', agentType: 'general-purpose', schema: FINDING })
  if (r) reports.push(r); else excluded.push({ key: ITEMS[i].key, reason: 'unanalyzable after 3 attempts across 2 agent types' })
}
if (excluded.length) log(`EXCLUDED items: ${excluded.map((e) => e.key).join(', ')}`)
const all = reports.flatMap((r) => (r.findings || []).map((f) => ({ ...f, item: r.item })))
log(`collected ${all.length} findings`)

phase('Synthesize')
const synthPrompt = `${PREAMBLE}\n\n<SYNTHESIS INSTRUCTION for the mode>. For each finding RE-READ the cited file:line and confirm (review/challenge); drop misreads with a reason; downgrade confirmed-but-immaterial findings below must-fix. Be decisive; a wrong must-fix wastes a fix cycle.\n\nFINDINGS:\n${JSON.stringify(all, null, 2)}`
let synthesis = await agent(synthPrompt, { label: 'synthesize', phase: 'Synthesize', schema: SYNTH, effort: 'high' })
if (!synthesis) synthesis = await agent(synthPrompt, { label: 'synthesize:retry', phase: 'Synthesize', schema: SYNTH, effort: 'high' })
if (!synthesis) return { error: 'SYNTHESIS_FAILED — no synthesis after retry; do not act on raw findings', reports, excluded }

// Unanimity gate — challenge/review only; fires only on a clean round (zero must-fixes)
const K = 3
let votes = []
const mustFixes = (MODE === 'challenge' ? synthesis.mustFix : MODE === 'review' ? (synthesis.confirmed || []).filter((f) => f.severity === 'must-fix') : []) || []
if ((MODE === 'challenge' || MODE === 'review') && mustFixes.length === 0) {
  phase('Verify')
  const votePrompt = (k) => `${PREAMBLE}\n\nIndependent verifier ${k}: re-read the cited code. Is there ANY surviving must-fix? Set mustFixFound=true only with a concrete file:line cite.\n\nRESULT:\n${JSON.stringify(synthesis)}`
  const rawVotes = await parallel([1, 2, 3].map((k) => () =>
    agent(votePrompt(k), { label: `verify:${k}`, phase: 'Verify', agentType: 'Explore', schema: VOTE })))
  for (let k = 0; k < K; k++) {
    let v = rawVotes[k]
    if (!v) v = await agent(votePrompt(k + 1), { label: `verify:${k + 1}:retry`, phase: 'Verify', agentType: 'Explore', schema: VOTE })
    votes.push(v) // may still be null — a null vote is a FAILED SEAT, never consent
  }
}
return { reports, synthesis, votes, votesRequired: K, excluded }
```

Baked-in defaults (do not drop): `agentType: 'Explore'` for analysts and verifiers — read-only seats; on a host without that agent type substitute its read-only explorer equivalent, or omit the option if none exists (the read-only intent stays binding via the prompt). Also baked in: schema-forced structured output, the analyst retry-then-exclude accounting (a silently dropped analyst fakes completeness; a permanently wedged item fakes rigor — both are banned), the synthesis null-retry + `SYNTHESIS_FAILED` bail-out (never act on raw findings without a synthesis), `effort: 'high'` on synthesis, the conditional Verify phase with exactly-K vote accounting. After it returns, parse `result.synthesis` (it is under `result` in the task output file) and relay only the synthesis + any owner-decisions to the user — never the raw finding dump. Non-empty `result.excluded` means the panel result is PARTIAL: name the excluded items and their reasons in the verdict and the report — the caller decides whether partial scope is acceptable, reruns the excluded items separately, or treats the round as failed. An exclusion is always visible; it is never a silent cap.

## Mode schemas (presets)

`FINDING` and `SYNTH` below describe **literal JSON Schema objects** (`type:'object'`, `additionalProperties:false`, `required:[...]`, `properties:{...}` with enums as written) that you paste into the script's `FINDING`/`SYNTH` constants — not prose. Pick the pair for the chosen mode.

Every mode's FINDING uses one envelope the engine's aggregation line depends on: `{ item, findings: [...] }`, where `item` echoes the work-list item's `key` and `findings` holds that mode's per-finding objects. Do not rename either field — line `const all = ...` reads exactly these.

- **discuss** — FINDING `{ item, findings[{element, recommendation, rationale, tradeoffs, impact, risk(enum low|med|high), needsUserDecision(bool), options[]}] }`; SYNTH `{ brief, decisions[{question,recommendation,options[]}], risks[], sequencing[] }`. Verb: reconcile overlaps into one brief; surface only genuine owner choices with a recommended default each.
- **challenge** — FINDING `{ item, findings[{issue, severity(enum must-fix|should-fix|accept-risk), why, file, line, evidence, suggestedFix}] }` (`file`/`line`/`evidence` carry the citation the contract demands — without these fields the schema's `additionalProperties:false` would silently strip every cite); SYNTH `{ verdict, mustFix[], shouldFix[], acceptedRisks[], edits[] }`. Verb: assume each area already failed; classify; emit concrete edits.
- **gap** — FINDING `{ item, findings[{gap, kind(enum functional|visual), evidence, currentState, severity(enum must|should|nice), effort(enum small|med|large)}] }`; SYNTH `{ summary, backlog[{title,kind,severity,effort,whatToDo}], largeCandidates[], outOfScopeNotes[] }`. Verb: dedupe across items; order by severity then effort; separate large candidates needing a decision. Backlog `kind` carries the finding's `kind` through.
- **review** — FINDING `{ item, findings[{file, line, severity(enum must-fix|should-fix|nit), issue, fix}] }`; SYNTH `{ verdict, confirmed[{file,line,severity,issue,fix,evidence}], rejected[] }`. Verb: RE-READ each cited `file:line`; confirmed needs code evidence; everything else -> rejected with reason.

## Iterate until unanimous (challenge + review)

A single pass is a draft, not a verdict. For challenge and review, loop until the result is provably complete:

1. Run the panel (fan-out + verifying synthesis) -> `confirmed`/`mustFix`.
2. If non-empty, the orchestrator applies the fixes/revisions (in the main loop — analysts are read-only), then re-runs the panel against the updated tree/design.
3. **Unanimity gate:** when a round yields zero must-fixes, the script's Verify phase confirms it with an independent verifier panel — K=3 fresh agents over the result, each asked "is there any surviving must-fix? set mustFixFound=true only if you can cite a concrete one with file:line." **Unanimous = exactly `votesRequired` valid votes, every one `mustFixFound:false`.** A null vote (a seat that failed even after its retry) is a failed seat, NEVER consent — the round did not pass; re-run the Verify phase or treat the null as dissent. Any `mustFixFound:true` with a real cite re-opens the loop. Excluded items make the pass PARTIAL: the verdict must say "unanimous over analyzed scope; excluded: <keys>" — never a bare "complete".
4. Bound the loop: `maxRounds` (default 3). If not unanimous by the cap, STOP and report the residual dissent to the user — do not declare complete.

This loop spans the main loop across turns, not one Workflow call. Concretely:
- **"run the panel"** = invoke the Workflow engine above (Analyze + Synthesize + conditional Verify) again, re-running the FULL work-list against the now-updated tree/design (not just items that had findings — a fix can introduce a new issue elsewhere).
- **applyFixes** = the orchestrator (you, in the main loop, or the calling `feature-implement`) edits the tree per the confirmed must-fixes. Panels never write; they only report. So a round = Workflow returns must-fixes -> you apply them -> you invoke the Workflow again.
- **The unanimity gate** is the script's conditional Verify phase (challenge/review only; see the `VOTE` schema and gate condition in the engine above) — it runs inside the same Workflow invocation, not as a separate call. Complete only when exactly `votesRequired` valid votes exist and all return `mustFixFound:false`. Any `mustFixFound:true` re-opens the loop.
- **Polarity check (mandatory orchestrator step, every Verify round):** before declaring a round unanimous, re-read each vote's `reason` field. A reason that cites a concrete `file:line` must-fix counts as dissent regardless of its boolean — treat it as `mustFixFound:true`. The schema cannot enforce this; you do, every time, not just when something looks off.

State in the report: round count, K and valid-vote count per round, excluded items with reasons, any degradations (failed seats, retries), and the final unanimity or residual dissent. A reader must be able to reconstruct how hard the result was actually tested.

## Orchestration spine (how panels chain with feature-*)

The main loop runs the `feature-*` skills as the Alex Loop backbone; each stage delegates its parallel sub-work to a panel:

- `feature-design` <- **discuss** panel (brief + owner-decisions) -> then **challenge** panel (iterate to unanimity) before saving.
- `feature-plan` <- **gap** panel (backlog) for reference-parity work.
- `feature-implement` -> per wave, a **review** panel (iterate to unanimity) -> apply confirmed fixes.

Panels are read-only analysis; the orchestrator (main loop) owns all writes, fixes, and commits. Do not have a panel mutate the tree.

## Autonomous mode (opt-in)

Purpose: once the design is approved, execute to a panel-verified bar **without per-step user check-ins**. Opt in per project with a directive in a repo-root instruction file — `CLAUDE.md` under Claude Code, `AGENTS.md` under Codex, or their machine-local `CLAUDE.local.md` / `AGENTS.local.md` variants (the opt-in check reads all four; `feature-config` writes to the machine-local file when one exists):

```
<!-- alex-loop: autonomous -->
```

Absent -> the `feature-*` skills behave exactly as shipped (ask at their gates); the global skills stay inert, so non-opted projects are unaffected. Present -> the gated branches below activate.

**Detecting the opt-in (deterministic, repo-root only).** Do NOT rely on noticing the directive in loaded context: the harness also loads a global instruction file (`~/.claude/CLAUDE.md` under Claude Code, `~/.codex/AGENTS.md` under Codex), and a stray directive there would wrongly enable autonomy in every project. As the FIRST step of any `feature-*` skill, scope the check to the repo-root instruction files (checked-in plus machine-local):

```
grep -qsE '^(<!-- *)?alex-loop: *autonomous( *-->)? *$' "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/CLAUDE.md" "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/AGENTS.md" "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/CLAUDE.local.md" "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/AGENTS.local.md" && echo ON
```

`ON` -> autonomous mode for this project; no output -> behave as shipped. This greps only the repo-root `CLAUDE.md` / `AGENTS.md` and their machine-local `CLAUDE.local.md` / `AGENTS.local.md` variants, never the global or any parent-directory file. `-s` suppresses errors for whichever of the files are absent. (Not in a git repo -> the substitution falls back to `/nonexistent`, the grep finds nothing, and you stay in default mode.) The match is an **anchored whole line** — the bare directive or its HTML-comment form, nothing else on the line — so a quoted, negated, or prose mention ("never enable alex-loop: autonomous") cannot activate the mode. The directive is a switch, not a keyword.

**The contract — the orchestrator resolves its own decisions; only hard blockers and irreversible-action authorization reach the user.**

`AskUserQuestion` (and any user-facing prompt or gate) is RESERVED for the hard-escalation list below. A design fork, ambiguous contract, scope question, or "is X still needed after Y" reaching `AskUserQuestion` is itself the defect signal — route it through the Decision protocol instead. Autonomous mode means the orchestrator decides; it does not hand judgment back to the human.

Three mechanisms carry the run:

1. **Decision protocol (council + independent-model seat).** A decision the orchestrator cannot resolve from the plan, the code, or a sensible default — design fork, ambiguous contract, scope expansion within the approved design's intent, "is X still needed after Y", replan-vs-patch — is resolved by a council, not by asking the user. See **Decision protocol** below.

2. **Repair loop (only after bounded autonomy is exhausted).** Never stop on first failure. A build break / failing verify / non-converging review enters a bounded repair loop: diagnose -> fix -> re-verify, panel-backed for hard cases, capped at `maxRounds` (default 3). Surface ONLY when the cap is hit still-failing, reporting what was tried.

3. **Hard escalation (the only thing that reaches the user).** Surface immediately — do not loop, do not council:
   - Hard blockers: signing failures, missing credentials, environment/permission denials, non-fast-forward base, detached HEAD / mid-rebase — anything unresolvable by editing the repo.
   - Irreversible / outward-facing actions lacking durable prior authorization: push (the resolved `commitPolicy: auto` IS durable authorization for pushing the run's feature branch — escalate only under other policies, or for any other ref/force-push), destructive ops, anything that publishes externally (PR creation always confirms).
   - Council deadlock (no majority, contradictory on a load-bearing premise) AND the decision is high-stakes / irreversible. A reversible deadlock is not an escalation — the orchestrator takes the lower-risk option, records it, and continues.

Everything else — loop chaining (design -> plan -> implement), waves, reviews, fixes, re-reviews, policy-permitted commits (per the `commit-authority` rule — autonomy does not upgrade `commitPolicy`), and every decision the council resolves — proceeds automatically.

**Audit artifact (mandatory in autonomous runs).** The autonomous contract works because decisions are auditable afterwards — which is an empty promise unless something durable is written. After a panel's final round, the ORCHESTRATOR (panels never write) saves `docs/alex-loop/<feature-folder>/NN-panel-<mode>.md` (under the artifact root: `docs.local/` when that folder already exists at the repo root — never create `docs.local/` itself — otherwise `docs/`, created as needed) (`NN` = next free prefix among `*-panel-*.md` files): mode, work-list, seats (agent type / model family per seat), per-round findings and verifier votes, excluded items with reasons, degradations (failed seats, single-family fallbacks), and residual dissent. Uncommitted, like the other loop artifacts. In interactive runs the file is optional — the user watched it happen in chat.

**Repair-loop integrity (critical).** An autonomous fix loop's failure mode is papering over the break to "go green." The unanimity gate applies to repairs too: after a repair round builds/tests green, a verifier panel must confirm the fix is REAL — no weakened/deleted tests, no band-aids (`as any` / stub returns / `@ts-expect-error` / commented-out assertions), no fixture special-casing. A green build from a gamed fix counts as FAIL -> keep looping or hard-exit. Autonomy without this gate is just faster breakage.

### Decision protocol (autonomous mode)

Resolve the decision with a council; do not ask the user.

1. **Convene the council.** The top-level agent dispatches 2-3 independent leaf subagents on ONE self-contained brief, each prompt including the **Delegation Boundary** clause and assigning a distinct angle so perspectives diverge — minimalist / correctness / risk (pick the angles that fit the decision). Council is per-decision: skip it when a sensible default is obvious and low-stakes; act on the default and record it.
2. **Add an independent-model seat.** Dispatch one seat through a different model foundation than the orchestrator — a real second opinion, not an echo. Under Claude Code: the `codex:codex-rescue` agent (GPT via Codex, Bash-only — the brief must be fully self-contained; the seat reads code via `grep`/`cat`). Under Codex, or when that agent type is absent: use the Runtime discovery section of the session-injected `model-selection` rule. Cross-family seats are additionally gated by that rule's **Data egress** policy — repo content goes to another provider only with the authorization it defines; without it, skip the seat and record "cross-family seat unavailable (egress not authorized)". If no cross-family seat is reachable or authorized, record "single-family council — correlated-bias risk" with the decision.
3. **Synthesize.** Reconcile council + independent-model outputs: convergent recommendations win; a divergent one gets its cited code re-read before it counts; contradictions the orchestrator resolves on the re-read evidence. Record the decision, the options weighed, each seat's recommendation, and the rationale in the saved plan file — durable, survives compaction.
4. **Continue.** Act on the synthesized decision. Do not surface it as a gate. Escalate only per hard-escalation item 3 (irreversible AND deadlocked).

**Council brief template** — each seat starts with zero context, so make it self-contained:
- **Decision** — one question with enumerable options.
- **Grounding facts** — runtime/architecture constraints, what just changed (commit SHAs), the exact files / functions / line anchors to read.
- **Assigned angle** — minimalist | correctness | risk | open.
- **Deliverable** — a concrete recommendation naming files / functions / mechanism, word-capped, "design opinion only — do not implement or commit."

**How the feature-* skills gate on this** (thin pointers; the contract above is authoritative):
- `feature-design` — owns the initial design-approval gate (the entry into autonomous mode). Its mid-execution re-entry for ambiguity / scope resolves via the Decision protocol; it re-enters the human approval gate ONLY for an irreversible scope expansion beyond the approved design, or a council deadlock on a high-stakes premise.
- `feature-plan` — opted in: skip the "challenge this plan?" and "shall I continue?" asks; auto-run a challenge panel to unanimity, then hand off to `feature-implement`. Underspecification it cannot resolve routes through the Decision protocol (via `feature-design` re-entry), never a user prompt.
- `feature-implement` — opted in: per wave, auto-run a review panel to unanimity + apply confirmed fixes (no "proceed?" ask); on build/verify failure run the repair loop; resolve `[JUDGMENT]` / design / drift decisions via the Decision protocol; surface only on hard escalation.

## Verify before claiming the skill ready

Procedural doc -> cold-start it: the top-level agent dispatches a fresh leaf subagent with the **Delegation Boundary** clause. It reads this file and reports whether a top-level caller could author + run a panel for a given mode from the skill alone (missing inputs, ambiguous steps); it must not actually run a panel. Patch per the report before claiming ready.
