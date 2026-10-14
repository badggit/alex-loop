<!-- Updated: 2026-10-14 00:48:00 UTC -->

# Verify Before Completion

Evidence before claims, always. No completion claims without fresh verification evidence.

## Diagnosis: full evidence before naming a root cause

A non-success surface signal is not itself proof of the cause. A non-200 / timeout / circuit-breaker from a long-running or streamed endpoint can mean the work succeeded but the response missed a deadline, the transport framing hid the status, or an unrelated gate fired — not that the underlying logic failed. Before attributing a build/test/deploy failure to a specific cause:

- Pull the full underlying evidence (per-item completion records, per-task stop reasons, the actual response body) — not just the top-level status code.
- Do not lead with a confident single root cause that deeper logs can reverse. If the evidence is still partial, say what is proven vs. inferred and keep digging.
- The diagnostic signal that this was skipped: the stated root cause flips two or three times as more logs are pulled. Pull the decisive evidence first, state the cause once.
- **Confirm the environmental premises against ground truth first.** Which instance, provider, session, and datastore are actually in play — read it from the system itself (the running config, the actual DB file, the external store's real contents), do not assume. A diagnosis built on the wrong instance or the wrong database is wrong no matter how careful the rest is.
- **Fix the root cause, not the symptom.** When a complaint survives a surface patch, or blocks the user's verification surface, trace the shared component or mechanism producing it. Do not pin values, re-patch call sites one at a time, or route around via a side channel — those leave the cause live to resurface elsewhere.

## Fix the reported issue, not an adjacent one

A fix to a nearby bug is not a fix to the one the user reported. Before claiming a reported issue resolved:

- **Rerun the user's exact original repro** — their stated steps, not your reconstruction. "Verified live" against a repro you invented can pass while the user's path still fails.
- **Sweep sibling surfaces for residual artifacts of the same root cause.** The same defect often shows on more than one surface; clearing one and declaring victory leaves the others for the user to find.
- The diagnostic signal this was skipped: the user replies that this is a different problem and the original one is still present, or finds a leftover artifact of the same cause immediately after your "fixed" claim.

## The Gate Function

BEFORE claiming any completion status:

1. **IDENTIFY**: What command proves this claim?
2. **EXECUTE**: Run the FULL command (fresh, not from memory)
3. **READ**: Review full output, check exit code, count failures
4. **VERIFY**: Does output confirm the claim?
   - If NO: State actual status with evidence
   - If YES: State claim WITH evidence
5. **ONLY THEN**: Make the claim

Skipping any step = making unverified claims.

## Required Evidence

| Claim | Requires | Not Sufficient |
|-------|----------|----------------|
| "Tests pass" | Test command output showing 0 failures | Previous run, "should pass" |
| "Linter clean" | Linter output showing 0 errors | Partial check, extrapolation |
| "Build succeeds" | Build command with exit code 0 | Linter passing, "looks good" |
| "Bug fixed" | Test demonstrating fix works | Code changed, assumed fixed |
| "Feature complete" | All requirements verified | Tests passing |
| "Ready to commit" | All verification steps passed | Work looks right |
| "UI fix verified" | Live app driven via agent-browser, observed change | Code reading, type-check passing |

## UI fixes need live verification

For any change that affects rendered UI — components, layout, styling, accessibility, interactive behavior — reading code and passing typecheck is **not** verification. Drive the running app through agent-browser, observe the actual rendered change, and confirm it matches the request before reporting completion. The user should not have to ask "did you actually check?" after a UI claim.

- If the dev server isn't running, start it (or ask the user to). Don't claim a UI fix while reading static source.
- If agent-browser isn't available for a given UI surface (e.g. native mobile, IDE plugin), state that explicitly and request manual confirmation. Don't substitute "I think this looks right" for evidence.
- Type errors, lint errors, and unit-test passes are necessary but not sufficient for UI claims. They prove the code compiles and units behave; they don't prove the user sees what they asked for.

## Test against the real app, the documented way

When asked to run or test the app, the deliverable is the real application exercised the project's prescribed way — not a stand-in that looks like progress.

- **Follow the project's documented test procedure verbatim** — the test doc (TESTING.md), the designated test provider/model, the real data. Never substitute a synthetic harness, fabricated fixtures, or an ad-hoc server and present it as the deliverable. The diagnostic signal: the user rejects the substitute as not what was asked for.
- **Keep one persistent smoke/dev server up for the whole session.** Run all smokes and follow-up tests against that same instance, and never tear it down (or leave it down) when reporting status — the user inspects results there. If a status report would otherwise leave the server down, restart it and include the URL.

## Procedural docs need cold-start verification

Procedural docs (BDD smoke guides, repro recipes, runbooks, agent-browser test guides, on-call playbooks) are claims that "an operator following these steps verbatim reaches the stated outcome." Author self-review does not validate that claim — the author has session context the cold reader does not.

- After authoring or substantially revising a procedural doc, the top-level agent dispatches a fresh leaf subagent with a self-contained prompt that points to the doc and instructs it to follow the steps verbatim, capturing observed outputs and any deviations. Include the mandatory no-delegation clause from `use-subagents.md`.
- The subagent's friction points (missing prerequisites, wrong commands, stale env vars, missing testids, SQL queries that return wrong values, ambiguous wording) are the only reliable signal of guide quality.
- Patch the doc per the subagent's report before claiming the guide ready.
- The verifying subagent must run as a fresh leaf agent with no shared session context — it cannot inherit "I know what they meant" from this conversation and must not dispatch any further agents.
- This applies whether the guide is consumed by a human operator or an LLM operator; the cold-start dispatch is the load-bearing check.

## Red Flags -- STOP and VERIFY

Stop if you're about to say:
- "Should work now"
- "Looks correct"
- "Seems to pass"
- "Probably fixed"
- "Great!" / "Perfect!" / "Done!" (before verification)
- "I'm confident this works"

These phrases mean: "I haven't verified, but I'm hoping."

## Reporting Honestly

After running the gate, report what actually happened -- not what you hoped happened.

- REPORT outcomes as they actually happened. If a check failed, say so with the relevant output. If you skipped a verification, say you skipped it rather than implying it passed.
- NEVER claim green results when output shows failures.
- NEVER weaken, silence, or skip a failing test/lint/type check to manufacture a pass.
- NEVER label broken or incomplete work as done.
- FIX known defects and same-class instances in the current pass. Do not park them in a "known issues / deferred" list, relabel report-and-acknowledge as "escalated", or advance past visible breakage — without explicit user approval to defer.
- When a check genuinely passed or a task is genuinely complete, state it plainly -- no hedging, no downgrading finished work to "partial", no re-verifying things already verified.
- When evidence is genuinely ambiguous, say so explicitly -- name the competing explanations and what would distinguish them. Do not lead with a confident single-cause diagnosis and bury alternatives.
- If asked for certainty the evidence cannot support, state the ambiguity rather than manufacturing conviction.

Goal: accurate reporting -- not defensive, not overconfident.

## Long-running processes need substrate verification

When a long-running task (real-LLM smoke, multi-minute build, container-bound integration test, real-network sync) is in flight, "no error in stdout" is not evidence of progress.

Run before claiming a long-running task is "still running" or "in progress":

- **Process check** — confirm the host process is alive: `ps -ef | grep <pattern>` or the platform equivalent. A vanished process with truncated stdout looks identical to a slow one.
- **Substrate check** — for tasks bound to docker / kubernetes / a database / an external service, query that substrate directly: `docker ps --filter ...`, `kubectl get pods`, a direct DB query for the row the task should be writing. Stale/dead containers tell a different story than missing log lines.
- **Log tail** — read the last N lines of the actual log file (not just the buffer captured by the orchestrator). Most long-running tasks emit periodic activity; their absence over a substantial window is itself evidence.

Lead the next status report with the substrate check the user would otherwise have to ask for. "Process alive, container running, last log line at t+Xs" beats "no error so far" every time.

## Capture baseline before phase work begins

When kicking off multi-task work on a feature branch (a phase, a wave-structured plan, a multi-day refactor), capture the parent branch's verify-chain baseline before the first task lands. Without it, pre-existing failures get mistaken for regressions, and the verify-chain comparisons in `Phase-end verification` have nothing to compare against.

Run once, before the first task:

- The same chain that phase-end runs: format/lint, typecheck, full unit tests, e2e, smokes — in that order.
- Record exact pass/fail counts per stage, plus the names of any failing test/spec files.
- Persist the baseline somewhere durable (a `tmp/baseline-<date>.txt`, a `docs/notes/<date>-baseline.md`, or the plan file itself). Memory is not durable enough across compactions.

When phase-end verification runs the chain again, compare against the captured baseline. **New failures in stages that were green at baseline are regressions.** Pre-existing failures stay tolerated until a separate task addresses them — call them out explicitly so the user knows what's carryover vs. what's new.

If the baseline run itself surfaces failures the user wasn't aware of, surface them immediately — don't bury "by the way, 2 e2e tests were already broken on main" inside a phase-end report.

## Phase-end verification

A "phase" is a multi-task plan landing as a unit (typically one feature-implement run, one branch's work, or one architectural migration). Phase-end verification is heavier than per-claim verification — it answers "is this safe to merge / continue building on?" rather than "did this one test pass?"

Run before claiming a phase complete:

1. **Full-suite tests** — `bun test` / `npm test` / `pytest` from repo root, NOT just touched-file globs. Compare counts against the pre-phase baseline. Any new failure in any file (even files you didn't touch) is a regression — surface, do not advance.
2. **Typecheck** — `bun run typecheck` / equivalent — clean across all packages.
3. **Lint** — clean on touched files; pre-existing baseline warnings tolerated, new warnings investigated.
4. **UI surface verification** — for any phase that affects rendered UI, drive the live app through agent-browser, capture a screenshot. Per the per-claim rule above; phase-end repeats it for the integrated UI, not just the components in isolation.
5. **End-to-end smoke** — for phases that introduce new architectural foundations (new dispatch path, new storage layer, new wire protocol), run ONE real path end-to-end against production-equivalent dependencies (real LLM, real DB, real network) before declaring done. If the smoke is genuinely impractical (no credentials in CI, infra blockers), say so explicitly: "phase mechanically complete; real-LLM smoke owed before merge." Do NOT absorb the gap silently.
6. **Foundation-validation when the phase ships a new architectural layer** — list the load-bearing assumptions of that layer (e.g. "DB persistence survives runtime restart", "mid-iteration gate paths exercise correctly", "child sessions get parent linkage") and confirm each was actually exercised, not inferred from unit tests.

When the user asks "is it safe to continue?" after a phase, treat the question as a request for the phase-end verification status, not a request for reassurance. Lead with what was proven end-to-end vs. what is inferred from unit tests; do not extrapolate green test counts into "everything works."

## Phase-end refactor verification: removed-symbol grep + band-aid sweep

When a phase removes or renames a symbol, type, or API surface, the completion claim must include positive evidence that no orphan references or transitional shims survived.

Run before claiming the refactor done:

1. **Removed-symbol grep — zero hits required.** For each removed identifier (the type alias, the function, the discriminator field, the export), grep the entire repo: `grep -rn "<identifier>\b" packages/ apps/ src/ ...`. Expected: zero hits. If any survive, fix them before claiming done.
2. **Band-aid sweep on touched files — zero hits required.** Refactors that hold a broken intermediate typecheck through multiple file edits attract band-aids: `as any`, `@ts-expect-error`, `as unknown as <T>`, stub `return true`, `// TODO/FIXME/HACK` lines. After the refactor, grep the touched files for these patterns: `grep -nE "as any|@ts-expect-error|as unknown as|TODO|FIXME|HACK" <touched-files>`. Expected: zero hits, OR every hit is independently justified and pre-existing (cite each).
3. **Test-file scope sweep.** Refactors that change a load-bearing type's shape ripple into test files that build literal fixtures of that shape. Grep for the old field/discriminator name in test files; rewrite stale literals before claiming green.

Reporting: include the three grep commands and their actual output (or "zero hits") in the completion summary. Do not summarize as "swept clean" — show the evidence.

## Surface known blockers before recommending repro steps

Before recommending the user run a setup-block to verify a feature (boot runtime, paste input, click button, observe), confirm prerequisite blockers are resolved:

- Any infrastructure piece you've already informed the user is broken (image build failures, missing credentials, hook misconfigurations) must be re-flagged in the same response that proposes the repro.
- "Try this and let me know" is not acceptable when "this" requires a step the user already told you is blocked.
- A user reply pointing out that they already told you about the blocker means you skipped this gate. Repair: lead the next response with the blocker + the alternative path (escape-hatch test, follow-up phase to unblock first, manual workaround).
