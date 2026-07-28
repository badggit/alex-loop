<!-- Updated: 2026-04-30 00:33:34 UTC -->

# Refactor: Validate the Premise First

Architecture-changing refactors rest on a load-bearing premise — "this abstraction will subsume those call sites," "this detection mechanism covers all cases," "this invariant holds across all entry points." Before migrating the full call surface, prove the premise with the smallest possible end-to-end test.

## When this applies

- Introducing a new abstraction that consolidates N call sites into one chokepoint.
- Replacing a per-caller convention with a centrally-enforced rule.
- Moving a decision from caller-discipline to mechanism (e.g. "the dispatcher figures it out").
- Any refactor where a wrong premise would surface only after multiple migrations have already committed to it.

## The rule

Before the first task that depends on the premise lands (in a wave-structured plan that is typically before Wave 2; in a single-batch refactor, before the batch):

1. **State the load-bearing premise and write it down.** One sentence, recorded in the feature's design or plan document — not just said out loud. Implementation must not re-derive it.
2. **Identify the riskiest call site.** The one most likely to violate the premise — usually the one with unusual context, async re-entrancy, or external invocation.
3. **Write a focused test that exercises that call site through the new abstraction.** Not a full migration. Just enough scaffolding to prove the abstraction handles that case correctly.
4. **Run the test. If it passes, the premise survives the worst case.** When the premise claims universality ("covers all cases", "holds across all entry points"), also exercise one negative/boundary case that must be rejected or handled — a universal claim proven only on one happy path is not proven. Record the evidence and any discovered limits next to the premise. Continue.
5. **If it fails, STOP.** Do not migrate the easier call sites first hoping the premise will hold. Return to the design/plan and re-design there — do not improvise a new architectural course mid-migration.

## Why

Migrating the easy cases first feels productive, but every migration is a commitment to the premise. By the time you reach the hard case (Wave N), you have N-1 commits worth of code on the same flawed foundation. The fix is then either revert-the-batch or scope-the-refactor-down — both expensive, both demoralizing, both avoidable. Validating the premise on the riskiest case **first** catches the architectural drift before any commit lands. The drift either disappears (premise was sound) or surfaces immediately (re-design with full information).

## Example shape

For a "single dispatcher detects re-entrancy via AsyncLocalStorage" refactor, the riskiest case is the one where re-entrancy must be detected across a sibling async context (e.g. a fresh request handler answering a gate emitted by a still-suspended outer call). Write that scenario as a test before migrating any of the easy cold-path callers. If ALS can't bridge sibling contexts, the test fails and the dispatcher needs an explicit slot-handle mechanism instead.

## Don't

- Don't migrate cold paths first because they're easy.
- Don't assume the hard case will fall into place.
- Don't defer the riskiest test to the wave that owns its migration — by then the design is committed.
- Don't write the load-bearing test against a mock that doesn't reproduce the real async/re-entrant context. Mocks that match the design's assumptions can pass while the real context fails.

## When this doesn't apply

- Pure mechanical refactors with no architectural premise (rename, extract function, move file).
- Refactors that touch one isolated call site.
- Refactors where every case is structurally identical (no riskiest-case to find).
