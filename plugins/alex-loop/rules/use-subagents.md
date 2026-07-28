<!-- Updated: 2026-07-10 12:07:32 UTC -->

# Use Subagents

Delegate non-trivial research, bulk reading, and high-output command execution to subagents. Preserve the main context window for synthesis and decisions, not raw tool output.

## When to Delegate

Pick subagent models per the `model-selection` rule — work delegation stays host-family (bulk/mechanical work rides the fast tier); cross-family preference applies to verification seats only. Dispatch a subagent via the `Agent` tool (or any equivalent subagent-spawning tool in the host harness) when the task matches one of these patterns:

| Task | Subagent |
|------|----------|
| Open-ended codebase exploration or "how does X work" | `Explore` |
| Finding files/symbols that need multiple rounds of globbing/grepping | `Explore` |
| Designing an implementation strategy before coding | `feature-design` skill, then `feature-plan` skill (NOT the `Plan` subagent) |
| Independent second-opinion review of a diff or migration | `code-reviewer` |
| Language-specific standards and patterns | dispatch a worker subagent told to read the relevant language-standards skill, when one is installed (skills, not subagents — see "Name the skills a subagent must read") |
| Multi-step research spanning many files | `general-purpose` |
| High-volume shell output (logs, `aws`, `gh`, large test runs) | `general-purpose` with a shell-focused prompt |

Subagent names above are this toolkit's; in another harness, map to its nearest equivalent (read-only explorer, reviewer, general worker).

## When NOT to Delegate

- Known file path -- read it directly (file-read tool)
- Known symbol or string -- search directly (content-search tool)
- Single glob pattern -- glob directly (file-glob tool)
- Short, deterministic commands whose output fits in context -- run them directly in the shell tool
- Tasks the user expects you to perform personally (synthesis, final answers, commits — in orchestrated implementation runs leaf workers hand changes back and the orchestrator is the sole committer)

## An Orchestrator Should Not Delegate Its Own Defining Work

This applies to BOTH the top-level session orchestrating subagents AND to any agent (in a runtime, in code) whose purpose is to drive a process.

If an entity's defining responsibility is "drive process X", do NOT spawn a helper subagent for sub-steps that are part of process X itself. Helpers cost a session and an LLM call without buying isolation; the sub-step's reasoning belongs in the orchestrator's own conversation where the next sub-step needs it.

Symptom: sub-steps that produce typed structured output the orchestrator immediately consumes — propose-question, propose-approach, synthesize-result. These are the orchestrator's own thinking, not delegations.

Reasonable delegation looks different: a SEPARATE process (lint, format, schema-check, network call, expensive search) the orchestrator wants to fire-and-forget OR a TYPED tool surface that needs isolated execution context (sandboxed code run, parallel critique fan-out across roles, fixture replay). These genuinely need their own session.

Anti-pattern in agent design: every sub-step becomes its own helper agent. The "orchestrator" turns into a thin dispatcher with no actual reasoning. The conversation history is fragmented across sessions; the orchestrator can't see its own prior thinking. Cost balloons because every sub-step is a separate LLM call.

Apply at design time: when listing sub-steps, ask "is this the orchestrator's own thinking, or a separate process?" If it's the orchestrator's thinking, the orchestrator does it inline. If the question feels ambiguous, default to inline — split into a sub-process only when isolation is genuinely needed.

Apply at runtime in this conversation: when spinning up a subagent for what could be inline reasoning (a small grep, a single file read, a synthesis you'd do yourself anyway), default to doing it inline. Subagents are for cohesive units of work that would balloon the parent context, not for every step.

## Parallelization Rules

- Run independent subagents concurrently by emitting multiple subagent calls in a single message
- Do NOT split a single cohesive task across subagents if their work would overlap -- duplicated research wastes tokens and produces conflicting summaries
- One subagent per distinct question or scope. If two subagents would need the same files, merge them into one prompt

### Exception -- triangulation

When independent verification matters more than token efficiency (mining a transcript for retrospective findings, adversarial review, extracting findings from a corpus where false negatives are costly), dispatch **multiple subagents on the identical brief** and reconcile contradictions upstream:

- **Convergent findings** (≥2 subagents report the same thing) -- keep, union the source references.
- **Divergent findings** (only 1 subagent reports it) -- re-read the cited source to validate. Keep with low confidence if supported; drop if unsupported.
- **Contradictions** (incompatible interpretations of the same source) -- re-read and resolve, or mark AMBIGUOUS and surface to the user.

The default no-overlap rule still applies to ordinary research and exploration. Triangulation is opt-in for tasks that explicitly require it.

## Only the Top-Level Agent May Dispatch Subagents

The user-facing, top-level session is the sole delegation owner. A spawned agent is always a leaf worker: it MUST NOT create another agent, subagent, worker, council, panel, or workflow.

This is a behavioral prohibition, not a capability assumption. It applies even when a worker happens to be given a delegation tool by the host. A worker MUST NOT call `Agent`, `Task`, `Workflow`, `spawn_agent`, a collaboration/delegation tool, an external-model agent harness, or any equivalent surface that starts another LLM worker. Renaming the tool or using a skill that delegates does not make nesting acceptable.

- Every top-level dispatch prompt MUST include: **"You are a leaf worker. Do not call Agent, Task, Workflow, spawn_agent, or any equivalent delegation/subagent tool. Do the assigned work yourself and return to the parent. If you need further fan-out, return `NEEDS_PARENT_FANOUT` with the proposed independent work items; do not delegate them yourself."**
- Do not instruct a worker to "delegate", "spawn workers", "run agents in parallel", "convene a council", "use the Explore subagent", or invoke a skill whose required execution model launches agents.
- If a leaf worker can complete the task serially itself, it does so. It may use ordinary read, search, shell, and edit tools within its assigned scope.
- If the task genuinely requires further fan-out, the worker stops before delegating and returns `NEEDS_PARENT_FANOUT` with the proposed independent work items. The top-level agent decides whether to dispatch them.
- The top-level agent performs all fan-out directly, with self-contained prompts. It never asks a worker to manage other workers.

## Prompt Discipline

Subagents start with zero conversation context. Every prompt must be self-contained:

- Include the mandatory leaf-worker prohibition from **Only the Top-Level Agent May Dispatch Subagents**
- State the goal and why it matters
- List what you already know or have ruled out
- Give exact file paths, commands, or search terms when you have them
- Specify the response format and length cap (e.g. "report in under 200 words")
- Never write "based on your findings, fix the bug" -- do the synthesis yourself

## Name the skills a subagent must read

Subagents do not inherit your loaded skills, do not know which skills exist, and will not discover a relevant one on their own. A prompt that says "follow Python standards" or "use the aimock skill" fails -- the subagent has no pointer to act on.

When a subagent's task depends on a skill's standards or procedure:

- Name the skill and give the exact path to its `SKILL.md`.
- Instruct the subagent to Read the `SKILL.md` and then follow its reference links -- read the `references/` files it points to. References do NOT auto-load for a subagent; the skill's own links are the index, so the subagent picks the relevant ones itself.
- Give paths. Do not assume the subagent can invoke a skill by name or has a skill-invocation tool.

Examples:

- Language work: "Read `<skills-dir>/developer-<language>/SKILL.md` and follow its reference links before writing code."
- Any skill-governed task: pass the skill's full `SKILL.md` path and have the subagent follow the links inside.

## Verification

A subagent's summary describes what it intended to do, not necessarily what happened. After a subagent writes or edits code, inspect the actual diff before reporting the task as done. Apply the same evidence-before-claims gate from `verify-before-completion.md`.

## Priority When User Has Already Given a Task

If the user has handed you a concrete task, proceed with that task using this delegation approach -- do not stop to ask whether subagents should be used.
