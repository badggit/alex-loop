---
name: feature-git-branch
description: "Create feature branches that respect the project's existing naming conventions. Detects patterns from prior branches, git hooks, and contributor docs before choosing a name; recognizes issue keys (ABC-123, #123, etc.) without assuming any specific tracker. Invoke ONLY when the user explicitly names this skill ('/feature-git-branch', 'use feature-git-branch') or when another alex-loop skill calls it (feature-implement, feature-fix). Do NOT self-trigger on generic requests like 'create a branch' or 'branch off main' — handle those as ordinary git work unless the user asks for this skill."
argument-hint: "<description | issue-key | issue-url>"
allowed-tools: "Bash(git:*), Read, Grep, Glob"
---

<!-- Updated: 2026-07-10 15:24:36 UTC -->

## Core principle

The project already has a convention (or deliberately has none). Find it first, then follow it. Do not impose an external pattern on a repository that uses a different one.

## Autonomous mode (feature-panel)

FIRST run the repo-root opt-in check — `grep -qsE '^(<!-- *)?alex-loop: *autonomous( *-->)? *$' "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/CLAUDE.md" "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/AGENTS.md" "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/CLAUDE.local.md" "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)/AGENTS.local.md" && echo ON` (anchored whole-line match — a quoted, negated, or prose mention of the directive must NOT activate the mode) (the repo-root instruction files — `CLAUDE.md`/`AGENTS.md` under Claude Code / Codex, plus their machine-local `CLAUDE.local.md`/`AGENTS.local.md` variants — NOT the global `~/.claude/CLAUDE.md` or `~/.codex/AGENTS.md`). If it prints ON, follow the `feature-panel` skill's **Autonomous mode** contract; otherwise behave as written below.

Confirmation gates — skip the ask, proceed:
- **Step 1 item 5** (no convention detected): adopt the house default without asking; state which default was applied in the run report.
- **Step 3 item 5** (name confirmation): skip; create with the validated candidate and report the name + rationale.
- **Step 4 dirty tree**: do not refuse and do not ask; proceed with `git checkout -b` — it carries uncommitted changes onto the new branch, nothing is lost. Report that the tree was carried dirty.

Hard blockers stay hard — surface immediately, never auto-proceed: name fails an enforced hook, non-fast-forward base, detached HEAD or mid-rebase/merge, candidate branch already exists.

## Workflow

### Step 1 - Discover the project's conventions (required)

Run this before suggesting any branch name. Report the findings back to the user in one short block.

1. **Sample existing branches.** List recent local and remote branches and look for a shared pattern:
   ```bash
   git for-each-ref --sort=-committerdate --count=40 \
       --format='%(refname:short)' refs/heads/ refs/remotes/ \
     | grep -vE '^origin(/HEAD)?$' | awk '!seen[$0]++'
   ```
   Look for:
   - A **prefix** grammar (e.g. `feat/`, `feature/`, `fix/`, `bugfix/`, `chore/`, `release/`, `hotfix/`, `tests/`, flat - no prefix).
   - An **issue-key** segment (`[A-Z][A-Z0-9]+-[0-9]+`) - the common shape used by many issue trackers. Treat it as a generic marker; do not assume any specific tracker.
   - A **short-issue** segment (`#123`, `gh-123`) for GitHub-style references.
   - The **slug style** (`kebab-case`, `snake_case`, `PascalCase`). kebab-case is most common; match what the project uses.
   - The **separator** between segments (`/`, `-`, `_`).
   - A **username** prefix (`alice/fix-x`, `@bob/feat-y`).

2. **Read contributor docs.** Grep the repo for stated conventions (shell-agnostic — no bash-only loop; `-H` keeps the filename for the `source:` field):
   ```bash
   grep -i -H -A3 -E 'branch|naming' CONTRIBUTING.md CONTRIBUTING.rst \
     .github/CONTRIBUTING.md README.md docs/CONTRIBUTING.md \
     docs/development.md .github/PULL_REQUEST_TEMPLATE.md 2>/dev/null
   ```
   Explicit rules in docs beat pattern inference from branches.

3. **Check enforced hooks and config.** Some projects reject branch names at push time. Look for:
   - `.git/hooks/pre-push`, `.git/hooks/pre-commit`, `.git/hooks/commit-msg` - skip any `*.sample` files.
   - `lefthook.yml` / `.lefthook.yml`.
   - `.husky/` directory.
   - `.pre-commit-config.yaml`.
   - `package.json` scripts mentioning `branch`.
   - Any `check-branch*` / `branch-name*` scripts in `scripts/` or `bin/`.

   Read the regex or pattern they enforce. If a hook enforces a pattern, the skill **must** produce a name that passes it.

4. **Summarize what you found.** One short block to the user:
   ```
   Detected convention:
     prefix:       feat | fix | chore   (34 of last 40 branches)
     issue key:    yes - pattern [A-Z]+-[0-9]+
     slug:         kebab-case
     separator:    "/" between prefix, "-" within slug
     enforced by:  .husky/pre-push regex ^(feat|fix|chore)/[A-Z]+-[0-9]+-[a-z0-9-]+$
     source:       CONTRIBUTING.md section "Branching"
   ```
   If findings conflict (docs say one thing, branches do another, hook enforces a third), surface the conflict and let the user pick. The enforced hook wins by default because it will reject a push otherwise.

5. **When nothing is detected** (empty repo, no prior branches, no hook, no doc): propose a pragmatic prefix-based default. State plainly that this is a house default (an extension of Gitflow's prefix grammar), not a canonical rule from any single workflow, and ask the user to confirm or override before creating the branch.

   Pattern:
   ```
   <type>/[<ISSUE-KEY>-]<short-kebab-description>
   ```

   Prefix vocabulary:
   | Prefix | When to use |
   |---|---|
   | `feature/` | New capability, enhancement |
   | `bugfix/` | Non-urgent bug fix |
   | `hotfix/` | Urgent fix against the current production line |
   | `release/` | Release preparation; description is usually the version (e.g. `release/1.4.0`) |
   | `chore/` | Maintenance, tooling, dependency bumps, CI, docs-only |
   | `tests/` | Test-only changes |

   Rules:
   - All lowercase except the issue key segment (which keeps its tracker casing, typically uppercase).
   - kebab-case for the description (`-` separator, no spaces, no underscores).
   - Issue key segment is optional: include it if the user supplied one, omit it otherwise; never invent one.
   - Cap description at ~50 chars at a word boundary.

   Examples:
   - `feature/add-oauth-provider`
   - `feature/ABC-123-add-oauth-provider`
   - `bugfix/retry-backoff-overflow`
   - `hotfix/ABC-456-stripe-webhook-signature`
   - `release/1.4.0`
   - `chore/bump-node-to-22`

   Validation regex for this default:
   ```
   ^(feature|bugfix|hotfix|release|chore|tests)/([A-Z][A-Z0-9]+-[0-9]+-)?[a-z0-9][a-z0-9.-]*$
   ```

   If the project signals a stricter scheme (e.g. only the canonical Gitflow four), match that instead - the detection pass in Step 1 takes precedence.

### Step 2 - Gather input

Accept any of:
- A free-text description: `"Fix the retry backoff in the upload client"`
- An issue key: `ABC-123`, `PROJ-456`, `LIN-789`, `#1234`, `gh-1234`
- A URL pointing to an issue - parse the key from the path; do not call any tracker API (this skill does not depend on any tracker CLI or MCP)
- An explicit type: `feature`, `fix`, `chore`, `tests`, `release`, `hotfix` - map to whatever prefix the project actually uses (e.g. project uses `feat/` → map `feature` to `feat`)

If the input carries a tracker issue key (`ABC-123` shape), preserve it verbatim (including the uppercase project prefix). GitHub-style short refs are normalized to a slug-safe form instead: `#123` becomes `gh-123` (a raw `#` fails both slugification and the validation regex); `gh-123` stays as-is. If the input is free-text only, do not invent a key. If the project requires keys (by hook or doc) and none was provided, ask for one instead of fabricating a placeholder.

### Step 3 - Compose and validate

1. Map the input to the detected prefix vocabulary (`feature` → `feat` etc.).
2. Slugify the description: lowercase, replace non-alphanumeric runs with `-`, strip leading/trailing `-`, collapse repeats, cap at ~50 chars at a word boundary.
3. Assemble per detected grammar.
4. Validate against every constraint you found in Step 1 (hook regex, doc rule, pattern inference). All must pass.
5. Run `git check-ref-format --branch <name>` as the final validity check — convention regexes approximate Git's own rules but do not replace them.
6. Show the candidate and one-line rationale, then ask for confirmation before creating the branch.

### Step 4 - Ensure clean state

Before creating:
- `git status` - refuse to create on a dirty tree unless the user opts to stash (`git stash push -u -m "pre-branch"`) or commit first. **Exception:** untracked files under `docs.local/alex-loop/` and `docs/alex-loop/` do not count as dirty — they are intentionally uncommitted loop artifacts and `git checkout -b` carries them onto the new branch. **Exception:** when creating the branch in a new worktree (Step 5), the current tree is not touched, so this gate does not apply.
- **Determine the base branch by detection, not assumption:** `git symbolic-ref --short refs/remotes/origin/HEAD` (run `git remote set-head origin --auto` first if unset), then upstream config and contributor docs; fall back to the `main` / `master` / `develop` guess list only when detection yields nothing. Check the current branch with `git branch --show-current` and check out the base first if needed.
- **Fork workflow:** if a remote named `upstream` exists (`git remote`), the base is `upstream/<base>` (fetch from upstream) while the push target stays `origin`. If `origin/<base>` and `upstream/<base>` have diverged, say so explicitly before proceeding.
- `git fetch --prune <base-remote>` then fast-forward the base: `git pull --ff-only <base-remote> <base>`. If non-FF, surface and stop - do not force-update. If the fetch fails (offline, no remote), continue from the local base and state that the base may be stale (see Error handling).
- Check the candidate branch does not already exist locally or on origin: `git show-ref --verify --quiet refs/heads/<name>` and `git ls-remote --exit-code --heads origin <name>`.

### Step 5 - Create

```bash
git checkout -b <branch-name>
```

**Worktree option.** When live work is in progress on another branch (or the caller needs an isolated tree — e.g. parallel implementation runs), offer creating the branch in a new worktree instead of switching:

```bash
git worktree add ../<repo-name>-<branch-slug> -b <branch-name> <base>
```

The current tree stays untouched (no stash juggling, no dirty-tree gate). Offer, don't impose: a worktree costs disk space and the user must know where it lives. Report the worktree path when created.

If Step 4 stashed, restore it now: `git stash pop`. On conflict, stop and surface — never drop the stash.

Report the created branch and the first suggested next step (e.g. "start work; commit with the project's message convention, then `git push -u origin <name>`").

## Inference hints

Use these when you need to pick a type from free-text input and no project-specific signal fixed the choice already:

| Cue in the description | Likely prefix |
|---|---|
| "add", "implement", "support", "introduce", "new" | `feature/` |
| "fix", "bug", "regress", "broken", "crash" (non-urgent) | `bugfix/` |
| "hotfix", "urgent", "prod down" | `hotfix/` |
| "release", "cut", "version" | `release/` |
| "upgrade", "bump", "update deps", "config", "tooling", "CI" | `chore/` |
| "test", "coverage", "flaky" (test-only change) | `tests/` |

If the project's detected convention only allows a subset of these prefixes (e.g. strict Atlassian Gitflow with only `feature/` `release/` `hotfix/` `support/`), map to the closest allowed prefix instead of inventing one. Never mint a prefix the project does not already use.

## Error handling

- **Dirty tree** - offer `git stash -u` or commit first. Do not silently discard work.
- **Branch already exists** - offer `git switch <name>` or suggest a suffix (`-2`, a date, or a short tag).
- **Name fails an enforced hook** - regenerate to match the hook, do not override it.
- **Conflicting signals** - ask the user which source to trust; record their choice for this session.
- **No network / no remote** - continue locally; skip the remote-existence check and mark the branch as local-only.
- **Detached HEAD or in the middle of a rebase/merge** - stop; ask the user to finish or abort the operation first.

## What this skill will not do

- Call any issue-tracker API or CLI.
- Assume a repo uses any specific issue tracker.
- Impose a naming scheme on a repo that has its own.
- Create a branch on a dirty tree without explicit consent (autonomous mode counts as consent — the opt-in directive pre-authorizes carrying uncommitted changes onto the new branch).
- Override a hook-enforced pattern.

## Helpful commands

- Rename current branch: `git branch -m <new-name>`
- List recent branches with activity: `git for-each-ref --sort=-committerdate --count=20 --format='%(committerdate:short) %(refname:short)' refs/heads/`
- Delete local branch: `git branch -d <branch-name>`
- Delete remote branch: `git push origin --delete <branch-name>`
- Move to a branch: `git switch <branch-name>`
