<!-- Updated: 2026-07-10 11:40:57 UTC -->

# Asking Questions

How to elicit decisions from the user without overwhelming them.

## Act, don't ask, during open-ended investigation

When the task is open-ended investigation or diagnosis ("why did X fail", "what's slow"), keep investigating and report findings before interrupting with a question. Do NOT pause to ask "where should I look?", "want me to retry?", or for a confirmation the investigation itself would answer. Reserve questions for genuine decision points (which fix to apply, an ambiguous requirement) — not for work you can do yourself. A clarifying/remediation prompt raised while the user expects continued investigation reads as stalling; the diagnostic signal is the user interrupting the prompt to repeat the original instruction.

## One concern per question

Each question covers one decision. Multi-part questions hide disagreements — split them.

## Per-target grouping

When triaging many items at once (review-codebase candidates, retrospective findings, design alternatives, etc.), group questions by target/category and ask in batches per target. Do NOT surface a single mega-prompt with every item interleaved.

Order conflicts first, then small/cross-cutting changes, then file-creation last. Cognitive locality helps the user weigh related decisions together.

## Pacing precedence

When a skill that is driving the interaction defines its own question pacing (e.g. a design interview that mandates one question at a time), the skill's pacing wins. This rule governs question quality — one concern per question, recommendation attached, tool choice — regardless of who sets the pacing.

## Tool

- Use the question/prompt tool (`AskUserQuestion` or the host harness's equivalent) for ALL clarifying questions. Never ask in plain text.
- Multi-choice when the answer space is small and enumerable (2–4 options plus automatic "Other").
- Open-ended only when the answer space genuinely cannot be enumerated.
- Batch ≤4 questions per question-tool call (this toolkit's schema limit; respect the host tool's own cap). Split into multiple calls when more are needed.

## Recommendation, not a cold ask

Every question carries a recommended answer when possible. Phrase as "I think X because Y. Confirm or correct?" — never ask cold. The recommendation must be grounded in what was read or what is conventional in the project. If there is no basis for one, say so and ask outright rather than fabricating a default.
