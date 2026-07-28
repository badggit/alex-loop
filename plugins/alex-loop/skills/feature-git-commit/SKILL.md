---
name: feature-git-commit
description: "Well-formatted git commits with conventional commit messages. Runs pre-commit checks, stages files by explicit path, and suggests splitting commits for different concerns. Invoke ONLY when the user explicitly names this skill ('/feature-git-commit', 'use feature-git-commit') or when another alex-loop skill calls it (feature-implement, feature-fix, plan task commit steps). Do NOT self-trigger on generic requests like 'commit', 'commit this', or 'commit and push everything' — handle those as ordinary git work unless the user asks for this skill."
allowed-tools: "Bash(git:*), Read, Grep, Glob"
---

<!-- Updated: 2026-07-28 -->

Whether to commit at all is governed by the session-injected `commit-authority` rule (commitPolicy, sole-committer invariants). This skill owns HOW a commit is made once one is authorized.

## Conventional Commits
Uses standard conventional commit format: `type(scope): description`
- **feat**: New feature or capability
- **fix**: Bug fix or issue resolution
- **docs**: Documentation only changes
- **refactor**: Code restructuring without behavior change
- **style**: Formatting, missing semicolons, etc (no code change)
- **perf**: Performance improvements
- **test**: Adding or updating tests
- **chore**: Maintenance, tooling, configuration
- **build**: Build system or dependencies
- **ci**: CI/CD configuration changes

## Process

Cheap, deterministic gates run first; expensive checks (hooks, tests) run last, so a doomed commit fails fast.

1. Inspect state: `git status` — note what is already staged and what is dirty.
2. **Pre-staged scope check.** If the index already holds paths outside this commit's concern (pre-staged earlier or by another actor), do not absorb them: commit with an explicit pathspec (`git commit -- <own paths>`) so only the concern's files land, and report the leftover staged paths instead of silently including them.
3. Stage by **explicit path only** — never `git add -A` or `git add .` (they sweep unrelated dirt and can stage credential-bearing files). One concern per commit; leave unrelated dirty files unstaged.
4. **Ignore gate.** Before any `git add`, run `git check-ignore -v -- <paths>`. Any hit → drop that path and say which ignore rule matched. `git add -f` (or any override of an ignore rule) is forbidden without the user explicitly confirming those exact paths in this session. Never stage `.env*` or key/credential files even when not ignored.
5. **Cheap content gates.** `git diff --cached --check` (whitespace damage, conflict markers). Then scan the staged diff's added lines for secret shapes — private-key headers (`BEGIN ... PRIVATE KEY`), provider key prefixes, long high-entropy literals assigned to `key`/`token`/`secret`/`password`-like names. On a hit: stop, and show the match truncated to its first and last 3 characters — never print a candidate secret whole.
6. **Discover message constraints BEFORE generating the message.** Read `commitlint.config.*` / `.commitlintrc*` / a `commitlint` field in `package.json`, and any `commit-msg` hook: extract allowed types, scope enum, required scope, max header length. Generate the message to those rules on the first try instead of the generate → reject → regenerate loop.
7. Analyze actual code changes (`git diff --cached`) and list the staged paths before committing.
8. Discover the project's checks (lint, build, typecheck, test, docs generation), then run them:
   - Sources, in order: `package.json` scripts (`lint`, `typecheck`, `test`, `build`), `Makefile` / `justfile` targets, `.husky/`, `lefthook.yml` / `.lefthook.yml`, `.pre-commit-config.yaml`, `.git/hooks/` (skip `*.sample`)
   - No check found in any source -> say so and continue; do not invent one
9. **Failure gate:** any check or hook failure stops the commit. Show the failing output verbatim (redact anything secret-shaped). Never bypass with `--no-verify`, never weaken or delete a failing check to get green — fix the cause or hand the failure to the user. Skipping checks requires an explicit user instruction in this session.
10. Determine commit type and scope based solely on current changes; generate concise subject line (50-80 characters); add body ONLY for complex/non-obvious changes.
11. Execute commit. **Signing:** if `commit.gpgsign` / `gpg.format` is configured and the key is unavailable or signing fails, STOP and escalate — never disable signing (`-c commit.gpgsign=false` is forbidden); bypassing a signing policy to get green is the same cheat as `--no-verify`.
12. **Post-commit verification:** `git show --stat --oneline -1 HEAD` — confirm exactly the intended paths landed and the message is as generated; report the resulting short SHA and stat.

## Amend and fixup

- `git commit --amend` is allowed only for your OWN latest commit, not yet pushed, and only while still working the same task it belongs to.
- Every other correction is a NEW commit: `fix(scope): ...` or `fixup! <original subject>` — squashing is the merge strategy's business, not yours.
- Never rewrite history that anyone else may have (pushed commits, other agents' commits).

## Splitting by concern

When the diff holds more than one concern, split it as a series of explicit-path commits:

1. Group the changed paths by concern.
2. Commit in dependency order — foundations first (types/schemas), then implementation, then tests, when they are separable; otherwise keep a task's test+impl together.
3. A file containing two concerns goes whole into its primary concern's commit, with the secondary change mentioned honestly in the body. Do NOT split hunks (`git add -p` or its non-interactive imitations) — patch-staged partial files are brittle and produce commits that fail checks individually.

## Autonomous mode (feature-panel)

When an autonomous loop run invokes this skill:

- Skipped: confirmations of message wording and of file selection, within the explicit-path rules above.
- NEVER relaxed: the failure gate (a failing check stops the commit and escalates into the run's repair loop — it is not retried around); the ignore and secret gates; the signing stop (a signing failure is a hard blocker per the autonomous contract); the sole-committer invariant and the push rules from the `commit-authority` rule (workers never push; the orchestrator pushes only the run's feature branch, and only when the resolved policy or the user authorizes it).
- `--no-verify` is structurally unavailable in autonomous mode: the required "explicit user instruction in this session" cannot exist without a user in the loop.

## Subject Line Format
`type(scope): concise description`
- Keep under 80 characters
- Use imperative mood ("add" not "added")
- Be specific but brief

## Body Guidelines
**When to include body:**
- Complex changes affecting multiple areas
- Architectural decisions or breaking changes
- Non-obvious behavior changes
- Changes requiring context

**When to omit body:**
- Simple/obvious changes
- Version bumps
- Straightforward fixes or refactors
- Self-explanatory from subject + diff

**Body structure (if needed):**
```
Brief opening sentence summarizing the change.

Bulleted list of specific changes:
- Change description 1
- Change description 2
- Change description 3

Optional section headers: Changes:, Features:, Architecture:
BREAKING CHANGE: description (if applicable)
```

## Best Practices
- No emojis anywhere in the commit message
- Prefer no body over verbose explanation
- Keep subject lines concise and technical
- Use bulleted lists in body, not paragraphs
- Focus on what changed, minimal why unless architectural
- Split unrelated changes into separate commits
- Review `git status` AND `git diff --cached` to understand full scope of changes
