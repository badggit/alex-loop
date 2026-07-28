<!-- Updated: 2026-07-10 11:59:47 UTC -->

# Model Selection

Which model gets which work — subagents, council seats, workflows, second opinions. Host-agnostic: applies whichever agent harness is running (Claude Code, Codex CLI, Gemini CLI, ...). "Host family" = the model family of the agent reading this; "cross-family" = any other.

## Delegation Ownership

Model routing is performed only by the user-facing top-level agent. A spawned leaf worker MUST NOT use `Agent`, `Task`, `Workflow`, `spawn_agent`, another model's CLI/API, or any equivalent surface to create a further worker or verification seat. If it needs another seat or parallel investigation, it returns `NEEDS_PARENT_FANOUT` with the proposed work items, as required by `use-subagents.md`.

## Rankings

Higher = better. Cost reflects what the owner actually pays (OpenAI limits are generous), not list price. Intelligence is how hard a problem the model handles unsupervised. Taste covers UI/UX, code quality, API design, and copy.

| model        | tier     | cost | intelligence | taste |
| ------------ | -------- | ---- | ------------ | ----- |
| gpt-5.6-sol  | frontier | 3    | 8            | 9     |
| gpt-5.6-tera | balanced | 5    | 6            | 8     |
| gpt-5.6-luna | fast     | 6    | 5            | 7     |
| fable-5      | frontier | 2    | 9            | 9     |
| opus-4.8     | balanced | 4    | 7            | 8     |
| sonnet-5     | fast     | 5    | 5            | 7     |

## Tiers

Other rules and skills reference tiers, not model names — this table is the single tier-to-model mapping.

- **frontier** (fable-5, gpt-5.6-sol) — hardest problems handled unsupervised: final reviews, judgment and verifier seats, architecture, anything where being wrong is expensive.
- **balanced** (opus-4.8, gpt-5.6-tera) — standard implementation, secondary review seats, substantial but bounded tasks.
- **fast** (sonnet-5, gpt-5.6-luna) — bulk/mechanical fan-out: clear-spec edits, data extraction, grounding checks against a provided source.

## How to apply

- Defaults, not limits. Standing permission to override upward: if a cheaper model's output doesn't meet the bar, rerun with a smarter model without asking. Judge the output, not the price tag. Escalating costs less than shipping mediocre work.
- Cost is a tie-breaker only; when axes conflict for anything that ships, intelligence > taste > cost.
- Bulk/mechanical work (clear-spec implementation, data analysis, migrations, grounding checks against a provided source): fast tier; gpt-5.6-* effectively free where natively available.
- Anything user-facing (UI, copy, API design) needs taste >= 7.
- Reviews of plans/implementations: frontier or balanced — fable-5 or opus-4.8, optionally gpt-5.6-* as an extra independent perspective.
- Never use Haiku. Never use GPT-5.5 or older.

## Prefer cross-family for verification seats — not for work delegation

Cross-family preference applies only to seats that judge work: council verifiers, fact-checkers, reviewers, second opinions. Independence from the producer's model family is the signal there — a family shares blind spots with itself.

Work delegation (implementation, research, bulk edits, data analysis) stays on the host's native subagent mechanism with the tier the table picks. Spawning another family to write code buys friction, not signal — and vice versa: a host that can write the code still wants another family to review it.

For verification seats, prefer a family other than the host's when a runtime is present:

- Host Claude → codex (gpt-5.6-*) > gemini > other.
- Host Codex → claude (fable-5 / opus-4.8) > gemini > other.
- Host Gemini → claude > codex > other.

Same-family verification is the fallback, not the default. Table rank still gates tier: cross-family preference never drops a seat below the tier the task needs. Families outside the table (gemini, grok, perplexity) are unranked — use them as extra verification perspectives only, never as primary implementers of shipped work.

Cross-family seats are additionally gated by the **Data egress** policy below — a reachable runtime is necessary but not sufficient.

## Data egress — what may leave the machine

API-key hygiene (the Security section) is not permission to ship content. Repository content — source code, diffs, design/plan documents, logs — may be sent to another provider's runtime (curl, MCP, or another vendor's CLI: a local CLI still egresses to that vendor's API) only when one of these authorizations exists:

1. An explicit in-session user instruction naming the provider or approving external review.
2. A repo-config allowlist line in repo-root `CLAUDE.md`/`AGENTS.md` or their machine-local `CLAUDE.local.md`/`AGENTS.local.md` variants: `alex-loop external-models: <providers>` (e.g. `openai, google`). The line `alex-loop external-models: none` explicitly forbids egress. Match the whole line (optionally wrapped in an HTML comment, same convention as the autonomous directive), never a substring. If a checked-in file and a machine-local file disagree, the machine-local value wins.

Absent authorization, treat cross-family as unavailable and fall through to rung 5 (host-family, stated openly). When sending is authorized: inline only the excerpts the seat actually needs, never send `.env*`/credential files, and redact secrets or obvious PII from the excerpt first.

## Runtime discovery — presence check before planning a seat

Never plan a cross-family verification seat on assumption. Take the first rung that works; stop there:

1. Other-family agent/plugin already registered in the session (e.g. a codex rescue agent type, a claude subagent type).
2. CLI on PATH: `command -v codex`, `command -v claude`, `command -v gemini`, `command -v llm`. Each manages its own auth and model.
3. Other-family MCP tool already in the tool list (OpenAI / Gemini / Grok / Perplexity MCP).
4. Direct HTTPS via `curl` + `jq`, only when the provider key is present — test with `[ -n "$VAR" ]`, never print the value. Patterns below.
5. Nothing cross-family reachable → run host-family per the table and say so: "cross-family seat unavailable, ran <model>". In councils additionally note `single-family — correlated bias risk`. A missing cross-family runtime never blocks the work.

## Security

- Detect a key only with `[ -n "$VAR" ]`. Never `echo`, `printenv`, `env | grep`, or otherwise print its value.
- Key travels in a request header, never a URL path or query string.
- Do not log a request body that carries the key.

## Model ids and endpoints drift

Do not trust a hardcoded model id or endpoint. Before the first call, confirm the current model id and endpoint from provider docs or the MCP tool schema. Placeholders below (`<...>`) are intentional.

## curl harnesses

### OpenAI (GPT family)

```bash
[ -n "$OPENAI_API_KEY" ] || { echo "no OPENAI_API_KEY"; exit 2; }
curl -sS --max-time 90 https://api.openai.com/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "content-type: application/json" \
  -d '{ "model": "<GPT_MODEL>", "messages": [ {"role":"user","content":"<PROMPT>"} ] }' \
  | jq -r '.choices[0].message.content'
```

### Anthropic (Claude family)

```bash
[ -n "$ANTHROPIC_API_KEY" ] || { echo "no ANTHROPIC_API_KEY"; exit 2; }
curl -sS --max-time 90 https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{ "model": "<CLAUDE_MODEL>", "max_tokens": 4096, "messages": [ {"role":"user","content":"<PROMPT>"} ] }' \
  | jq -r '.content[0].text'
```

### Google Gemini

```bash
[ -n "$GEMINI_API_KEY" ] || { echo "no GEMINI_API_KEY"; exit 2; }
curl -sS --max-time 90 \
  "https://generativelanguage.googleapis.com/v1beta/models/<MODEL>:generateContent" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H "content-type: application/json" \
  -d '{ "contents": [ { "parts": [ { "text": "<PROMPT>" } ] } ] }' \
  | jq -r '.candidates[0].content.parts[0].text'
```

### xAI Grok (OpenAI-compatible)

```bash
[ -n "$XAI_API_KEY" ] || { echo "no XAI_API_KEY"; exit 2; }
curl -sS --max-time 90 https://api.x.ai/v1/chat/completions \
  -H "Authorization: Bearer $XAI_API_KEY" \
  -H "content-type: application/json" \
  -d '{ "model": "<GROK_MODEL>", "messages": [ {"role":"user","content":"<PROMPT>"} ] }' \
  | jq -r '.choices[0].message.content'
```

### Perplexity Sonar (OpenAI-compatible)

```bash
[ -n "$PERPLEXITY_API_KEY" ] || { echo "no PERPLEXITY_API_KEY"; exit 2; }
curl -sS --max-time 90 https://api.perplexity.ai/chat/completions \
  -H "Authorization: Bearer $PERPLEXITY_API_KEY" \
  -H "content-type: application/json" \
  -d '{ "model": "<SONAR_REASONING_MODEL>", "messages": [ {"role":"user","content":"<PROMPT>"} ] }' \
  | jq -r '.choices[0].message.content'
```

## External runtimes cannot read local files

A curl/MCP seat gets nothing from "see `docs/x.md`" — inline the artifact content and code excerpts into the prompt. File paths work only for seats with local execution (codex CLI, claude CLI, gemini CLI, host-native subagents).
