<!-- Updated: 2026-07-28 -->

# Implementation Cheats

Ways a task subagent satisfies acceptance criteria without doing the work. A subagent is an optimizer: any unfenced cheap path to "criteria met" will eventually be taken. Each exhibit: **what it looks like → the fence** (where the fence runs in this skill).

## 1. Test weakening

Subagent edits a pre-existing test to get green: deletes an assertion, loosens an `expect` (exact match → truthy, deep-equal → property check), widens a tolerance, nerfs a fixture.
**Fence:** test-integrity gate (Step 4) — git-diff every test file the wave touched; any weakened or removed pre-existing assertion not explicitly owned by the task is a FAIL, not drift.

## 2. Test disabling

`.skip`, `.only`, `.todo`, `xit`, `xdescribe`, commented-out asserts, empty test bodies. Suite green because the test never ran.
**Fence:** test-integrity gate greps touched test files for disable patterns — zero hits or each independently justified by the plan.

## 3. Coverage theater

Task's Step-1 behavior bullets list five behaviors; landed test asserts two and the suite is green.
**Fence:** test-integrity gate maps each behavior bullet from the task's failing-test step to a landed assertion. Unmapped bullet = incomplete task.

## 4. Stub satisfaction

`return true`, hardcoded expected value, `as any` / `# type: ignore` to silence the compiler where behavior was required.
**Fence:** band-aid sweep on every wave (not only refactor waves) — greps touched files for suppression directives, unsafe casts, stub returns, and deferral markers across the plan's languages; zero hits or each justified. The canonical pattern list lives in Step 4 item 7 of the skill.

## 5. Fixture special-casing

Implementation branches on literals from test fixtures (`if (id === "user-123")`) — a lookup table wearing code's clothing. Suite green, behavior absent.
**Fence:** grep impl files for distinctive literals appearing in the task's test fixtures; flag matches for review.

## 6. Self-reported green

"All tests pass" in the subagent summary; orchestrator-run suite shows otherwise, or the subagent ran a touched-file subset.
**Fence:** already load-bearing in Step 4 — orchestrator re-runs the FULL suite; subagent reports are informational only.

## 7. Criteria reinterpretation

Acceptance criterion is a vibe ("works correctly", "handles errors gracefully"), so the subagent declares it met.
**Fence:** Step 2 parse flags criteria with no mechanical validation command before any wave launches; vibes go back to the plan (or the user) before execution.

## 8. Plan editing

Subagent "completes" by editing the task's acceptance criteria or validation commands in the plan file rather than the code.
**Fence:** Step 4 diffs the plan file against the pre-wave snapshot — task subagents have NO legitimate plan-file writes at all (markers and completion blocks are orchestrator-authored); any subagent change to the plan is a FAIL.

## 9. Same-knob retry

Retried task fails the same way: the subagent re-ran the identical approach harder (more of the same edit, same command, same assumption).
**Fence:** retry protocol (Step 4) — retry prompt must carry hypothesis / expected failure mode / diagnostic, and a second attempt must be structurally different; same-knob-harder escalates to the user instead of burning a retry.

## 10. Flake masking

An unstable test is "fixed" by adding a `sleep`, inflating a timeout, or wrapping the assertion in a retry loop — the race is still there, just hidden behind a longer wait.
**Fence:** test-integrity gate greps the diff of touched test files for newly added `sleep`/`setTimeout`/`time.sleep` calls and 4x+ timeout inflations — each hit needs a plan-side justification, else FAIL. Real flakes take the FLAKY path in Step 4 item 5 (isolated re-runs, follow-up fix task), not a wait.

## 11. Environment-pinned mocks

A network/environment mock is pinned to literals that only hold on this machine — hardcoded hostname, port, absolute path. Suite green here, red anywhere else.
**Fence:** test-integrity gate's fixture spot-check extends to mocks: grep the task's impl and test files for hostname/port/absolute-path literals introduced by the wave; flag matches for justification.

## 12. Leftover debug output

`console.log` / `print` debugging left in production code — noise at best, data leakage at worst.
**Fence:** band-aid sweep (Step 4 item 7) scans the wave's added lines in non-test files for `console.log`/`console.debug` and bare `print(` outside CLI/logging surfaces; each hit is flagged.
