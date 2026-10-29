<!-- Updated: 2026-10-29 02:18:50 UTC -->

# Model Selection

Which model gets which work — subagents, council seats, workflows, second opinions. Host-agnostic: applies whichever agent harness is running (Claude Code, Codex CLI, Gemini CLI, ...). "Host family" = the model family of the agent reading this; "cross-family" = any other.

## Delegation Ownership

Model routing is performed only by the user-facing top-level agent. A spawned leaf worker MUST NOT use `Agent`, `Task`, `Workflow`, `spawn_agent`, another model's CLI/API, or any equivalent surface to create a further worker or verification seat. If it needs another seat or parallel investigation, it returns `NEEDS_PARENT_FANOUT` with the proposed work items, as required by `use-subagents.md`.

## Rankings

Higher = better. Cost reflects the effective cost under the subscription plans in use, not list price. Intelligence is how hard a problem the model handles unsupervised. Taste covers UI/UX, code quality, API design, and copy.

Rows are model families, not versions. Each row always means the newest released version of that family (see **Newest version only**), and its scores describe that version. `gpt-*-sol` stands for the newest `gpt-<version>-sol`; the same goes for `tera` and `luna`.

| family     | tier     | cost | intelligence | taste |
| ---------- | -------- | ---- | ------------ | ----- |
| gpt-*-sol  | frontier | 3    | 8            | 9     |
| gpt-*-tera | balanced | 5    | 6            | 8     |
| gpt-*-luna | fast     | 6    | 5            | 7     |
| fable      | frontier | 2    | 9            | 9     |
| opus       | balanced | 4    | 7            | 8     |
| sonnet     | fast     | 5    | 5            | 7     |

## Tiers

Other rules and skills reference tiers, not model names — this table is the single tier-to-model mapping.

- **frontier** (fable, gpt-*-sol) - hardest problems handled unsupervised: final reviews, judgment and verifier seats, architecture, anything where being wrong is expensive.
- **balanced** (opus, gpt-*-tera) - standard implementation, secondary review seats, substantial but bounded tasks.
- **fast** (sonnet, gpt-*-luna) - bulk/mechanical fan-out: clear-spec edits, data extraction, grounding checks against a provided source.

## Newest version only

A family name always resolves to the newest released version of that family. Never pin a version number in a dispatch, a prompt, or a config, and never pick an older version of a family while a newer one is available. Resolve the version at dispatch time; take the first source that works:

1. An alias the runtime itself resolves to the newest version: under Claude Code, `model: "opus"` / `"sonnet"` / `"fable"` on `Agent` (the same aliases work for `claude --model`).
2. The runtime's own list of current models: the model ids in the session's system prompt or environment notes, the CLI's model list, the enum in an MCP tool schema.
3. The provider's model list or docs (see **Model ids and endpoints drift**).

If none of them settles the version, omit the model parameter so the runtime uses its own default, and say so. When a provider renames or restructures its lines, map the new lines onto the tiers by the provider's own positioning (flagship -> frontier, mid-range -> balanced, small and fast -> fast); never keep routing to a retired name.

## Forbidden models - use the session model

A model is forbidden when this rule bans it (see **How to apply**) or when the user's instructions do: in the session, or in a global or project instruction file (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, their `.local` variants). The user's instructions take precedence over this rule.

When the tier pick is forbidden, run that work on the session model: the model the user-facing top-level agent runs on, i.e. whatever the user selected. It differs between users and sessions, so never assume a specific one. Do not substitute another row of the table.

- Under Claude Code: omit the `model` override so the worker inherits the session model. If the host sends workers without an override to a configured default model instead, pass the session model's family alias explicitly.
- Upward escalation (see **How to apply**) follows the same substitution: escalating into a forbidden model means running on the session model.
- If the user's instructions require workers to run on the session model, every tier resolves to the session model.
- Cross-family seats: if a family's pick for the seat's tier is forbidden, that family cannot fill the seat. Treat it as unavailable and continue down the **Runtime discovery** ladder; never drop the seat to a lower tier of that family.

Example: frontier work picks `fable`. A user whose instructions forbid Fable gets that work on their session model, for example the newest Opus if that is what they run.

## How to apply

- Defaults, not limits. Standing permission to override upward: if a cheaper model's output doesn't meet the bar, rerun with a smarter model without asking. Judge the output, not the price tag. Escalating costs less than shipping mediocre work.
- Cost is a tie-breaker only; when axes conflict for anything that ships, intelligence > taste > cost.
- Bulk/mechanical work (clear-spec implementation, data analysis, migrations, grounding checks against a provided source): fast tier; the gpt lines are effectively free where natively available.
- Anything user-facing (UI, copy, API design) needs taste >= 7.
- Reviews of plans/implementations: frontier or balanced tier - fable or opus, optionally a gpt line as an extra independent perspective.
- Never use Haiku. Never use a model older than the newest version of its family.

## Prefer cross-family for verification seats — not for work delegation

Cross-family preference applies only to seats that judge work: council verifiers, fact-checkers, reviewers, second opinions. Independence from the producer's model family is the signal there — a family shares blind spots with itself.

Work delegation (implementation, research, bulk edits, data analysis) stays on the host's native subagent mechanism with the tier the table picks. Spawning another family to write code buys friction, not signal — and vice versa: a host that can write the code still wants another family to review it.

For verification seats, prefer a family other than the host's when a runtime is present:

- Host Claude -> codex (gpt lines) > gemini > other.
- Host Codex -> claude (fable / opus) > gemini > other.
- Host Gemini -> claude > codex > other.

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
2. CLI on PATH: `command -v codex`, `command -v claude`, `command -v gemini`, `command -v llm`. Each manages its own auth. Pass the newest model of the seat's tier through the CLI's model flag when it has one (see **Newest version only**); otherwise the CLI uses its configured default.
3. Other-family MCP tool already in the tool list (OpenAI / Gemini / Grok / Perplexity MCP).
4. Direct HTTPS via `curl` + `jq`, only when the provider key is present — test with `[ -n "$VAR" ]`, never print the value. Patterns below.
5. Nothing cross-family reachable → run host-family per the table and say so: "cross-family seat unavailable, ran <model>". In councils additionally note `single-family — correlated bias risk`. A missing cross-family runtime never blocks the work.

## Security

- Detect a key only with `[ -n "$VAR" ]`. Never `echo`, `printenv`, `env | grep`, or otherwise print its value.
- Key travels in a request header, never a URL path or query string.
- Do not log a request body that carries the key.

## Model ids and endpoints drift

Do not trust a hardcoded model id or endpoint. Before the first call, confirm the endpoint and the newest model id of the needed family from provider docs, the MCP tool schema, or the provider's model-list endpoint where it has one (`GET /v1/models` on OpenAI, Anthropic and xAI, `GET /v1beta/models` on Gemini; the key travels as in the harnesses below). Placeholders below (`<...>`) are intentional - fill them with that newest id.

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
