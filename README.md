<!-- Updated: 2026-10-28 -->

# alex-loop

A plugin packaging the design-to-implementation skill chain plus the multi-agent verifier that gates it. Installs into both Claude Code and Codex — the skills use the open `SKILL.md` standard, so one skill set drives either harness.

## Install

### Claude Code

```
/plugin marketplace add badggit/alex-loop
/plugin install alex-loop@alex-loop
```

Skills are namespaced under the plugin, so they invoke as `/alex-loop:feature-design`, `/alex-loop:feature-implement`, and so on. Namespaced skills never collide with loose `~/.claude/skills/` skills.

### Codex

```
codex plugin marketplace add badggit/alex-loop
codex plugin add alex-loop@alex-loop
```

Codex reads the same `skills/` directory via the plugin's `.codex-plugin/plugin.json`; the marketplace lives at `.agents/plugins/marketplace.json`. Invoke a skill explicitly with `$feature-design` (or `@alex-loop` for the bundle).

**Invocation policy.** Skills activate only when the user names them explicitly (slash/`$` invocation, "use <skill>", "start Alex Loop") or when another Alex Loop skill invokes them at its handoffs and gates (design -> plan -> implement, fix escalation, challenge gates, git helpers inside implement/fix). Generic phrasing — "commit this", "fix this bug", "challenge this", "create a branch" — does NOT auto-trigger a skill; each skill's description instructs the model to handle such requests as ordinary work instead. `worktree-add` goes further: it is user-invoked only (`disable-model-invocation: true` in Claude Code, `allow_implicit_invocation: false` in Codex), so no skill or model starts it on its own.

Layout: the plugin itself lives under `plugins/alex-loop/` (skills plus both plugin manifests); both marketplace files at the repo root point there. Codex requires the plugin directory to be distinct from the marketplace root, and Claude Code resolves the same relative source. Each harness reads only its own manifest set and ignores the other.

## Skills

Every setting mentioned below is a whole-line directive in a repo-root instruction file — `CLAUDE.md` under Claude Code, `AGENTS.md` under Codex, or their machine-local (typically gitignored) `CLAUDE.local.md` / `AGENTS.local.md` variants — written bare or HTML-comment-wrapped (`<!-- alex-loop: autonomous -->`), nothing else on the line. Set them by hand or interactively via `feature-config`; absent a directive, the default applies; on a value conflict a machine-local file overrides a checked-in one. Each skill section ends with the directives that change its behavior.

### `feature-design` — step 1/3: idea to approved design

- Decision-tree interview, one question at a time, every question ships with a recommended answer; the codebase is combed first, so you only answer what code cannot reveal. Depth steerable per run ("ask more questions" / "keep questions minimal") or pinned per repo via the `design-questions` directive.
- Conditional non-functional branch (perf / security / a11y / observability) and an early "is this actually several features?" split check — before the expensive planner run.
- Designs stay abstract (no file paths, no identifiers) and carry identity: `Status` / `Revision` / `Stakes` headers; after approval, changes land only as dated amendments, material ones re-approved.
- Rejected approaches are recorded under `Alternatives considered`, so re-entry and challenge never re-propose them.
- The human design-approval gate is the one gate never skipped, even in autonomous mode.

Directives: `alex-loop: autonomous` — interview and section-by-section confirmations self-resolve via the council protocol; the human design-approval gate still reaches you regardless. `alex-loop design-questions: <auto|few|medium|many>` — pins the interview depth: `few` asks only blocking decisions (everything else is inferred and listed under Assumptions), `medium` asks primary-branch decisions only, `many` walks secondary branches too, `auto` (default) adapts; a live hint ("keep questions minimal") overrides it for that run, and autonomous mode ignores it.

### `feature-plan` — step 2/3: design to executable tasks

- One planner subagent does all reading and drafting; the orchestrator consumes a ~300-word summary — session context stays lean.
- Tasks are complexity-scored 1–5 (nothing ships at 5; 15-task ceiling), with TDD steps and exact `Run:`/`Expected:` commands; vague criteria are banned — a human judgment call must be labeled `[JUDGMENT]`.
- Waves for parallel execution: disjoint `Files:` sets plus shared-resource conflict checks (lockfiles, build configs, codegen outputs).
- Header pins `Design revision`, `Stakes`, `Risks`, and one feature-level `Verification` command that outlives the session.
- Touching persisted data forces a migration dry-run + rollback-verification task; the planner self-lints the plan before returning it.

Directives: `alex-loop: autonomous` — the question gates ("challenge first?", "proceed to implementation?") self-resolve and the plan hands off to implementation without asking.

### `feature-implement` — step 3/3: plan to validated code

- Parallel task subagents under strict write ownership: workers never commit, push, or touch the plan file — the orchestrator is the sole serial committer (policy-gated), which removes index and plan-file races by construction.
- Adversarial validation per wave: full suite against a baseline, test-integrity gate, band-aid sweep, plan-conformance diff — built around a 12-cheat catalogue with a named fence per cheat.
- Flake detection (isolated re-runs, `FLAKY` verdicts don't burn task retries), timeout as a distinct failure type, and a resume protocol for interrupted runs.
- Conditional gates fire only when relevant: UI screenshot, zero-orphan grep after refactors, real e2e for new architecture, perf (when the design declared targets), security focus + secret scan for authn/input diffs.
- Drift triage between waves (>30% drift = replan), per-wave proceed gate, optional draft-PR step at the end.

Directives: `alex-loop: autonomous` — per-wave proceed gates and in-run decisions self-resolve (hard blockers still escalate); `alex-loop commit-policy: <auto|per-task|per-wave|final|manual>` — commit/push granularity: `auto` (default) commits each validated task and may push the feature branch, `manual` means no commits and no pushes — a verified diff plus a proposed commit series.

### `feature-fix` — fast path for known end-states

- Classifies before touching code: logic error (red-test-first), mechanical change (before/after structural verify — no fake red tests), production incident (containment first, regression test as a mandatory follow-up), spec gap (escalate to design).
- No edit before root cause; `git bisect` with the red test as a ready-made predicate for regressions.
- Same-class sweep: the cause pattern is grepped repo-wide — every sibling instance is fixed or explicitly listed.
- Attempt hygiene: per-attempt patch snapshots; the 3-strike escalation to `feature-design` rolls back only recorded files, never the whole tree.
- Reads prior designs/plans/fix records as the spec and detects recurrences of previously "fixed" bugs.

Directives: `alex-loop: autonomous` — the classify/escalate decision and `[JUDGMENT]` calls self-resolve, the verify gate runs through a review panel; `alex-loop commit-policy: <value>` — governs whether and when the verified fix is committed.

### `feature-challenge` — pre-mortem for a design, plan, or branch

- "It already failed — explain how" framing instead of a polite risk list.
- Free-form failure generation plus an 8-category coverage sweep — each empty category needs an explicit "n/a — why", never silent.
- Deep-dives budgeted by the design's `Stakes`, including a cross-family model seat (data-egress-gated) to break single-family blind spots.
- Synthesis re-reads every cited file before believing a finding; hallucinated ones land in a visible `Dropped findings` list.
- Revisions apply to design AND plan in lockstep; every checklist item becomes a task, a revision, or a named accepted risk — nothing dangles.

Directives: `alex-loop: autonomous` — runs as the panel challenge engine, iterated to verifier unanimity instead of asking between rounds; `alex-loop external-models: <providers>` (or `none`) — authorizes (or forbids) sending code and design excerpts to the cross-family deep-dive seat.

### `feature-panel` — the multi-agent engine behind the steps

- Four modes (discuss / challenge / gap / review) over one Workflow engine: fan out analysts, then a synthesis pass that verifies cited code rather than trusting reports.
- Challenge/review iterate until an independent verifier panel is unanimous — exactly K valid votes; a failed seat is never counted as consent.
- Failed analysts are retried, then explicitly excluded — results can be partial, but never silently truncated or wedged.
- Panels are read-only by construction; the orchestrator owns all writes. Autonomous runs leave an audit artifact (seats, votes, rounds, exclusions).
- Canonical home of the autonomous-mode contract: council + independent-model seat for decisions, bounded repair loop, a short hard-escalation list.

Directives: `alex-loop: autonomous` — this skill hosts the contract the other skills follow when the directive is on; `alex-loop external-models: <providers>` (or `none`) — gates the independent-model seat's data egress.

### `feature-git-branch` — convention-respecting branches

- Detects the project's naming convention (recent branches, contributor docs, enforced hooks — the hook wins) before proposing anything; never imposes a scheme.
- Base branch detected via `origin/HEAD` (not a hardcoded guess); fork workflow (upstream base, origin push); `git check-ref-format` as the final validity check.
- Never creates git worktrees; a separate worktree is made only when the user runs `/alex-loop:worktree-add`.

Directives: `alex-loop: autonomous` — skips the name confirmation, adopts the house default without asking, proceeds on a dirty tree; hard blockers (hook-rejected name, detached HEAD, existing branch) stay hard.

### `feature-git-commit` — conventional commits behind safety gates

- Cheap deterministic gates first: pre-staged scope check, `git check-ignore` on every path, secret scan of the staged diff (matches shown truncated).
- Explicit-path staging only — never `git add -A`; commitlint/commit-msg constraints are discovered before the message is generated, not after a rejection.
- Hard failure gate: no `--no-verify`, no disabling signing, a failing check stops the commit; post-commit `git show --stat` confirms exactly what landed.
- Amend/fixup policy (own unpushed commit only, never rewrite shared history) and a concern-splitting procedure.

Directives: `alex-loop: autonomous` — skips message-wording and file-selection confirmations; the ignore, secret, signing, and failure gates never relax; `alex-loop commit-policy: <value>` — decides (via the `commit-authority` rule) whether a loop run invokes this skill at all, and at what granularity.

### `feature-config` — repo-level settings interview

- Reviews every recognized directive (autonomous mode, commit policy, external-model egress, design-interview depth, context-watchdog auto-enable) with its current effective value, then asks one question per setting — each skippable, each unsettable back to its default.
- Writes only anchored whole-line directives into the repo-root instruction file and verifies every written line against the same grep the skills use to detect it; when a machine-local `CLAUDE.local.md`/`AGENTS.local.md` exists it writes there, falling back to the checked-in `CLAUDE.md`/`AGENTS.md` otherwise.
- Surfaces conflicts between the instruction files (machine-local overrides checked-in) and inert near-miss lines the anchored greps ignore; never commits, never touches global config, never invents a directive nothing consumes.

Directives: none of its own — this skill is the interactive way to set every directive listed above.

### `context-watchdog` - keep working state across auto-compaction (Claude Code)

- Off by default; `/alex-loop:context-watchdog on` (or `off` / `status`) switches it for the current session only. `feature-design`, `feature-plan` and `feature-implement` switch it on automatically when they start.
- While on, a `PreCompact` hook postpones the first auto-compact attempt and asks the agent to run `save`: a structured checkpoint (verbatim request and corrections, user decisions, statuses with evidence, workflow state, key files and commands, dead ends, next steps), written after the plan, task list and other on-disk statuses are brought up to date. Once a fresh checkpoint exists the next attempt compacts normally; without one, compaction goes ahead after 5 postponements (15 once the save has started), so the context never hits the hard limit.
- At compaction the checkpoint becomes a restore file (a stale checkpoint can never let a later compaction through); right after it a `SessionStart` (`compact`) hook hands that file back, the agent runs `restore`, reconciles it with the summary and reality, and continues. The file is deleted as soon as it has been read. State lives under `~/.cache/alex-loop/context-watchdog/<session-id>/` (`$XDG_CACHE_HOME` respected) - outside `~/.claude`, where Claude Code refuses agent writes.
- A manual `/compact` is never blocked: run `/alex-loop:context-watchdog save` first to keep state across it. The compaction threshold stays Claude Code's own (`/autocompact 250000`, `autoCompactWindow`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`).
- Claude Code only: its hooks are registered through `.claude-plugin/plugin.json` (`hooks/context-watchdog.json`), never through the `hooks/hooks.json` Codex shares, so Codex sessions get only a manual `save`.

Directives: `alex-loop context-watchdog: off` - the loop skills no longer switch the watchdog on automatically; the explicit `on` still works.

### `worktree-add` - a sibling worktree for parallel work

- `/alex-loop:worktree-add` creates the worktree next to the main clone; `/alex-loop:worktree-add ~/worktrees` puts it into the given parent folder instead (a relative folder counts from the current one, a leading `~` or `~/` is expanded by the script, other `~` forms are refused, and a missing folder is created). User-invoked only: `disable-model-invocation: true` in Claude Code, `allow_implicit_invocation: false` in Codex (invoke it there with `$worktree-add`). Needs git 2.29+ and Node 22 or newer on PATH; the script checks both versions, and only the package managers it starts may use the network.
- Naming: the folder is `MAINFOLDER-[TICKET-]DESCRIPTION` (the main clone's folder name plus a suffix) and the branch is the suffix alone. The ticket (`abc-123`, or `gh-123` for a GitHub issue) is taken only from the request or the current task, never from the current branch name and never invented; the description is 1-2 kebab-case words for the current task.
- Branch, first match wins: a worktree already registered at the target on that branch is reused; an existing local branch is checked out and logged as an `EXISTING` branch with its last commit date and how far it is ahead of / behind the default branch; a single remote-tracking branch of that name becomes a tracking branch (several remotes: refused); otherwise a new branch starts from the local default branch, not from the main clone's HEAD. The default branch is found offline: the branch `origin/HEAD` points to, then `init.defaultBranch`, then `main`, then `master` (each only when that local branch exists); when none is found the start is HEAD with a warning. A warning also says when the local default branch is behind its remote-tracking branch (local refs, no fetch). Uncommitted changes of the main clone are not carried over. A locked worktree whose folder is gone is refused: run `git worktree unlock PATH`, then `git worktree prune`.
- Ignored files of the main clone are placed by rules (since 1.17.0). git lists them as a collapsed tree; each entry is checked against the rules below, top to bottom, and the first match wins:

| Where | Entry | Result |
|---|---|---|
| any depth | Copy class: `.env`, `.env.*`, `CLAUDE.local.md`, `temp.local`; install-time config `.npmrc`, `.yarnrc`, `.yarnrc.yml`, `bunfig.toml`, `uv.toml`, `poetry.toml`; version pins `.python-version`, `.nvmrc`, `.node-version`, `.tool-versions`; `.envrc` | Per-worktree copy: copy-on-write, else a plain copy; never a symlink. |
| any depth | `node_modules`, and `.venv`, `venv` or any other folder holding `pyvenv.cfg` | Installed from the worktree's own lock files; fallback below. |
| any depth | Skip names: `.cache`, `.eslintcache`, `.next`, `.turbo`, `build`, `coverage`, `dist`, `out`, `*.tsbuildinfo`; Python caches and outputs (`__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `.hypothesis`, `htmlcov`, `.coverage`, `.coverage.*`, `coverage.xml`, `.tox`, `.nox`, `.eggs`, `.ipynb_checkpoints`, `.pytype`, `.pyre`, `*.egg-info`, `*.pyc`, `*.pyo`); junk (`.DS_Store`, `Thumbs.db`, `*.swp`, `*.swo`, `*~`, `*.orig`, `*.rej`, `*.log`); tool state (`.terraform`, `.terragrunt-cache`, `.vercel`, `.netlify`, `.serverless`, `.aws-sam`, `.direnv`, `.dart_tool`, `.angular`, `.nx`, `.astro`, `.docusaurus`, `.expo`, `.wrangler`, `.svelte-kit`, `.nuxt`, `.parcel-cache`, `.vite`, `.gradle`); `target` only beside `Cargo.toml`, `pom.xml`, `build.gradle` or `build.gradle.kts` | Not transferred and not reported. |
| any depth | A path ending in `.claude/settings.local.json` | Symlink to the main clone. |
| top-level folder | Anything whose first path component is `.idea`, `.vscode`, `.claude`, `.codex`, `.cursor`, `.gemini` or `.zed` | Symlink to the main clone. |
| top level | `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and `STEM.local` / `STEM.local.EXT` names with a non-empty stem (`docs.local`, `config.local.yaml`; not a bare `.local`) | Symlink to the main clone. |
| any depth | A folder git lists as ignored whole | Walked in the main clone (at most 5000 entries and 6 levels deep, symlinks never followed); the rows above apply to what is inside. |
| anywhere | Everything else | Not linked; named in one `not linked:` info line. |

- Placement: an entry below one that is already handled (linked, copied, walked, skipped, a dependency) is not processed again; a copied folder is copied whole with its subtree. A copy or link found inside a walked folder gets its parent folders created first, as real folders in the worktree; a folder is never created through a link or over a file, and such an entry is skipped with a warning that names the blocking folder. A walked folder over the limits is not expanded and gets a `not expanded PATH: more than 5000 entries or deeper than 6 levels` warning; nothing inside it is copied or linked, except entries git lists separately. The `not linked:` line names the largest entries first (at most 10, then `and N more`) with their sizes, leaves out paths that already are the tool's own links, and ends with `to share one with the main clone, run worktree-add --link PATH inside the worktree`.
- `--link PATH` (repeatable, relative to the repository root, at any depth) links a path the rules leave out. Run from the main clone, it applies to the worktree being created or reused. Run from inside a linked worktree, it needs no `--suffix` and only links the given paths into that worktree from the main clone; nothing is created, synced or installed. A malformed value (empty, absolute, with `..`, `.`, `//` or a control character) is a usage error. A path that does not exist in the main clone, is not ignored there, is a dependency folder or a copied entry (or lies inside one), or lies inside a folder the rules already link whole is refused with a `not linked with --link: ...` warning (for example `not linked with --link: data is not ignored in the main clone`) and the run goes on. It is also refused when its parent folder in the worktree is a link or not a folder (or cannot be created), or when something else already stands at that path in the worktree (`not linked with --link: something else already stands at PATH in the worktree`). Over a skip name it links and warns `build outputs are now shared with the main clone`. A forced folder is linked whole: any `.env` or dependency folder inside it is then shared with the main clone too. Running the same `--link` again logs nothing new.
- Legacy check: each run checks the tool's own lines in the shared `info/exclude` file. A line that hides files the repository's `.gitignore` files (and the global excludes file) do not ignore gets a warning such as `.git/info/exclude line /src/oldpkg hides 1 file that .gitignore does not ignore (src/oldpkg); ... Remove the worktree-add links at src/oldpkg in every worktree first, then this line`. Follow that order: `rm PATH` (no trailing slash) in every worktree, then delete the line; removing the line first can make an old link a committable file. A reused worktree with the tool's own links that the current rules would not create gets one `this worktree has links to the main clone outside the current rules` info line. Nothing is removed automatically.
- Migration to 1.17.0: new worktrees follow the rules at once; existing worktrees lose nothing on a rerun. No longer linked: top-level ignored folders and files outside the list above (for example `data/`, `local.settings.json`, model or database files) and every nested ignored entry inside the source tree (leftover package folders, `__pycache__`, `*.egg-info`). The `not linked:` line names them; use `--link PATH` for what a worktree really needs. Install-time config files (`.npmrc`, `.yarnrc.yml`, ...) and version pins are now per-worktree copies instead of links.

- Copies keep file modes (a 600 `.env` stays 600) and symlinks inside a copied folder stay symlinks. A failed clone gets one plain-copy retry. Each copy is made under a temporary name next to its destination and renamed into place only when the destination is still absent; a failed or interrupted copy leaves no partial entry (the temporary copy is removed at once, or by the next run when the process was killed). The sync only adds what is missing and never overwrites anything in the worktree, an edited `.env` included. One exception: a symlink made by an earlier run of this or a similar tool (pointing exactly at the main clone's entry) where a copy belongs is replaced by the copy, and such a link where a dependency folder is installed is removed and the install is done in its place.
- Links, dependency clones and the temporary names get anchored patterns in the shared `info/exclude` file under an alex-loop header, appended only when not already present, because a folder pattern such as `node_modules/` does not ignore a symlink of that name. When the exclude file cannot be updated, a warning says the links show as untracked and must be removed before `git worktree remove`.
- Links lead into the main clone: inside a worktree, `rm -rf docs.local/` (trailing slash) or `rm -rf docs.local/*` empties the main clone's folder; `python -m venv --clear` on a `.venv` linked by the fallback empties the main venv, and an install run through a linked `node_modules` writes into the main clone's one; writes into a linked `.claude` change the main clone's settings. Removing the link itself (`rm docs.local`, or `rm -rf docs.local` without the slash), `git clean`, and `git worktree remove` (with or without `--force`) are safe. `.claude` stays a link.
- Installs run the branch's own install scripts (npm `preinstall`/`postinstall`/`prepare`, uv build backends) with your full environment, exactly like running `npm ci` or `uv sync` yourself. For a branch you do not trust, use `--no-install`.
- Installs: each project with a tracked lock file (`package-lock.json` or `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock` or `bun.lockb`, `uv.lock`) is installed with npm, pnpm, yarn (1 or 2+), bun or uv in frozen mode (`npm ci`, `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile` or `--immutable`, `bun install --frozen-lockfile`, `uv sync --frozen`), offline first where the manager allows it. The manager comes from the lock file and `packageManager` in `package.json`; a wrong version or a conflict between them is a warning, not a guess, with no fallback: the dependency folders stay missing and the warning says why. npm does not enforce `packageManager`, so an npm pin of another major than the npm on PATH only gets an info line naming both versions and the install runs; for pnpm, yarn and bun the pinned major is required. A project is installed automatically when it sits at the worktree root or the main clone has its dependency folder; others get a `not installed automatically` line with the command to run. For a uv project only its root `.venv` is installed; another Python environment inside it (a `venv`, or a `.venv` deeper inside) is never installed and is linked like an orphan. A `venv` or `.venv` without `pyvenv.cfg` (a config folder or a file) is a normal ignored entry and follows the rules above. A nested `node_modules` without its own lock file belongs to the root JS project only when the root's `workspaces` cover that folder (brace sets such as `packages/{app,lib}` and character classes such as `pkg-[ab]` are understood); otherwise it is an orphan, and its warning says it is outside that project's workspaces. Fallback: with `--no-install`, when the manager is not on PATH, or for an orphan (a folder no supported lock file covers, such as a Python environment without `uv.lock`), `node_modules` is cloned with copy-on-write, else linked (with a `linked node_modules: REASON` line saying why copy-on-write is unavailable), and a Python environment is linked. When `CODEX_SANDBOX_NETWORK_DISABLED=1`, installs are skipped and every dependency folder gets the same fallback as with `--no-install`; the log names the install commands to run later, after removing the linked folders. A folder whose parent does not exist in the worktree is skipped with a `skipped ... does not exist in the worktree` line. Install target folders the main clone lacks (for example a new root `node_modules`) get exclude patterns too, so they never show in `git status`. When the main clone's ignored files cannot be listed or synced, only the projects at the worktree root install automatically from the worktree's own lock files; nested projects get `not installed automatically` lines and the orphan fallback is skipped, with one warning that says so. A failed install removes only what the package manager can create: the project's `node_modules` or `.venv`, nested `node_modules` of that project, and manager files that were absent before (`.pnp.cjs`, `.pnp.loader.mjs`, `.yarn/install-state.gz`, `.yarn/unplugged`, `.yarn/cache`); other new files are left in place. Where this run removed the tool's own link to the main clone before installing, the failed install puts that link back with a warning (`the earlier link was restored; remove it with rm PATH before installing`), so a rerun never leaves a working worktree worse than before; no link is made where none stood. Its warning includes a `to install:` line naming the next step; the full output is saved with mode 600 as `alex-loop-install-MANAGER[-DIR].log` (DIR percent-encoded, `/` as `%2F`) in the worktree's private git folder (`.git/worktrees/NAME`). An unexpected error while installing one project is reported for that project, and the remaining projects still install. An install that changes the shared repository config (for example `core.hooksPath`) is reverted after each project with a warning; keys under `branch.*` and `remote.*` are never reverted, because another worktree may set upstreams at the same time. To retry, fix the cause and rerun the same command from the main clone: the worktree is reused, missing or linked dependency folders are installed, and folders that already stand are left as they are. A `not installed with MANAGER: PATH already stands in the worktree` line is not a failure: the existing folder was kept. To reinstall it from this branch's lock file, remove it (`rm -rf -- PATH` for a real folder, `rm PATH` for a link) and rerun.
- Session switch: in Claude Code the skill calls `EnterWorktree` only when tool search offers it; otherwise it gives `/cd PATH` (usually the way) and `cd 'PATH' && claude` for a new terminal. Under Codex it gives `cd 'PATH' && codex`.
- Plain shell use: `plugins/alex-loop/skills/worktree-add/scripts/worktree-add.mjs --suffix SUFFIX [--parent DIR] [--no-install] [--link PATH]...` (`--help` prints the usage). Inside a linked worktree, `worktree-add.mjs --link PATH` links only that path and prints the worktree's path; from the main clone `--suffix` stays required. stdout carries only the absolute worktree path on success; log lines go to stderr. Exit codes: 0 success, 1 refusal or error (one `error` log line), 2 wrong arguments (usage text; an option value that starts with `--`, as in `--parent --no-install`, counts as missing). Run inside a linked worktree without `--link`, it creates nothing and prints that worktree's path.
- Known limits: installs are not sandboxed: a branch's install scripts run with your environment (credentials and registry tokens included), so use `--no-install` for a branch you do not trust. A folder git lists as ignored whole is walked to at most 5000 entries and 6 levels deep; a larger or deeper one is not expanded (with a warning), so a `.env` deep inside it is not copied. Copy-on-write needs btrfs, XFS or bcachefs on Linux or APFS on macOS; elsewhere copies are plain. An interrupt (Ctrl-C or a signal) during the installs skips the shared-config revert, so a change an install's script made there (for example `core.hooksPath`) stays and is undone by hand; the partial-install marker still makes the next run remove the half-installed folders, whether it installs them or falls back. After an interrupted run, the next worktree-add run removes and reinstalls the marked folders, even if they were installed by hand in between. Ignored names with control characters or invalid UTF-8 are skipped with a warning. Removal stays manual: `git worktree remove PATH` and `git branch -d BRANCH` from the main clone.

Directives: none.

The backbone is `feature-design -> feature-plan -> feature-implement`. `feature-fix` is the short path for scoped changes that don't need a design — bugs, regressions, chores, tweaks — routing into `feature-design` only when a supposed fix turns out to need a decision. `feature-panel` supplies the parallel analysis each phase delegates to; `feature-challenge` is the adversarial pass; `feature-git-branch` and `feature-git-commit` keep work off the default branch and land it cleanly. `feature-config` is the guided way to set the repo-level directives that steer all of them.

**Commit policy.** By default (`commitPolicy: auto`) the loop drives itself the classic way: the orchestrator commits each validated task and may push the feature branch after wave validation. Loop runs obey exactly two levers — a live in-session instruction, or a repo-root `CLAUDE.md`/`AGENTS.md` (or `CLAUDE.local.md`/`AGENTS.local.md`) line `alex-loop commit-policy: <auto|per-task|per-wave|final|manual>` (`manual` = no commits, no pushes; verified diff + proposed commit series). General "don't commit" prose in instruction files does NOT govern loop runs — set the policy line instead (the `feature-config` skill sets or clears it interactively). The rule cuts the other way too: outside a loop run, a plain "commit and push" request is ordinary git work — no alex-loop skill involvement, no policy lookup. Task subagents never commit or push under any policy; the orchestrator is the sole, serial committer.

All artifacts for one feature live together in `<artifact-root>/alex-loop/YYYY-MM-DD-<topic>/` (or `YYYY-MM-DD-<ticket>-<topic>/` when the work carries a numbered ticket such as `ABC-123` or `#123` -> `gh-123`, taken from the request or the current branch name, never invented), each document type numbered independently (`01-design.md`, `01-plan.md`, `01-challenge.md`, `01-fix.md`; a big feature can carry `02-design.md`, multiple plans, and so on), so loop output stays in a single folder that cannot collide with a project's own `docs/` naming. The artifact root is `docs.local/` when that folder already exists at the repo root, `docs/` otherwise; the skills create `docs/` and the `alex-loop/` subfolder as needed but NEVER create `docs.local/` — its pre-existence is the opt-in.

## Agents

| Agent | Role |
|---|---|
| `code-reviewer` | Read-only review subagent: type safety, regressions, YAGNI, language idioms across Python/TypeScript/JS/React/Node/Next.js, plus a GitHub PR triage mode (label/merge/comment/close actions gated by per-PR user approval). Referenced by the `use-subagents` rule; applies its inline standards, with the repository's own rules taking precedence. |

Agent definitions load in Claude Code via the plugin's `agents/` directory. Codex does not document plugin-distributed agent definitions — map to a comparable reviewer setup there.

## Rules (session-injected index)

The plugin also ships always-on rules in `plugins/alex-loop/rules/`. A `SessionStart` hook (`hooks/hooks.json` + `hooks/inject-rules.sh`) injects a compact index — one `Read @<path> — <summary>` line per rule — and the agent reads each rule on demand before work touching its domain. Index instead of full contents keeps session context lean. The same mechanism works in Claude Code and Codex, since Codex sets `CLAUDE_PLUGIN_ROOT` as a compat alias for `PLUGIN_ROOT`.

| Rule | Role |
|---|---|
| `model-selection` | Model rankings and frontier/balanced/fast tiers, cross-family preference for verification seats, runtime presence checks, the data-egress policy for external providers, per-provider curl harnesses. |
| `commit-authority` | Who may commit and when: the `commitPolicy` values and resolution order, sole-committer and no-push invariants. |
| `use-subagents` | Delegation criteria, orchestrator-keeps-own-work, parallelization and triangulation, prompt self-containment, subagents-cannot-fan-out, verify-the-diff. |
| `verify-before-completion` | Evidence-before-claims gates: diagnosis discipline, baselines, phase-end verification chains, removed-symbol and band-aid sweeps, honest reporting. |
| `refactor-validate-premise` | Validate an architecture refactor's load-bearing premise on the riskiest call site before migrating the easy ones. |
| `asking-questions` | Decision-elicitation discipline: act-don't-ask during investigation, one concern per question, batching, recommendation-first phrasing. |

The rule summary shown in the index is each file's first prose line after the H1 — keep that line a one-sentence summary when adding rules. Drop additional `.md` files into `rules/` to extend.

## Autonomous mode (opt-in)

By default each skill asks at its gates (design approval, "challenge first?", "continue to implementation?", per-wave proceed). A project opts into autonomous execution by adding one directive to its repo-root instruction file — `CLAUDE.md` under Claude Code, `AGENTS.md` under Codex, or their machine-local `CLAUDE.local.md` / `AGENTS.local.md` variants (a repo-root file, not the global `~/.claude/CLAUDE.md` or `~/.codex/AGENTS.md`):

```
<!-- alex-loop: autonomous -->
```

Each skill detects the opt-in deterministically as its first step — an anchored whole-line grep (the bare directive or its HTML-comment form, nothing else on the line) scoped to the repo-root `CLAUDE.md`, `AGENTS.md`, and their machine-local `.local.md` variants (`git rev-parse --show-toplevel`) — so a stray directive in the global config cannot enable autonomy across unrelated projects, and a quoted or negated mention of the directive cannot activate it either. The `feature-config` skill sets, changes, or removes this directive (and the other repo-level settings) interactively.

With the directive present, after the initial design is approved the chain self-drives, panel-gated to a unanimous bar. The orchestrator resolves its own decisions instead of handing them back — three mechanisms carry the run:

1. **Decision protocol (council + independent-model seat)** — a decision the orchestrator can't resolve from the plan, the code, or a sensible default (a design fork, ambiguous contract, in-scope expansion, "is X still needed after Y") is resolved by a council: 2-3 subagents on the same brief with distinct angles (minimalist / correctness / risk), plus one independent-model seat for a real second opinion — under Claude Code the `codex:codex-rescue` agent (GPT via Codex). The synthesis and rationale are recorded in the plan file, and the run continues. The decision never surfaces to the user.
2. **Repair loop** — a build/verify break enters a bounded loop (`maxRounds`, default 3): diagnose, fix, re-verify. A green build from a gamed fix (weakened tests, band-aids) counts as a failure, not a pass.
3. **Hard escalation** — the only thing that reaches the user: a hard blocker (signing, missing credentials, environment/permission, non-fast-forward base), an irreversible/outward-facing action lacking prior authorization (push, destructive ops), or a council deadlock on a high-stakes, irreversible decision.

`AskUserQuestion` in autonomous mode is reserved for mechanism 3 — a design/scope/ambiguity decision reaching it is itself the defect signal. Absent the directive, the skills behave exactly as shipped, so non-opted projects are unaffected.

## Development

The `worktree-add` script is written in TypeScript: the sources live in `src/worktree-add/` and their offline tests in `tests/worktree-add/` (Node's built-in test runner). Plugin users need none of this; they run the committed bundle. For development (Node 22.18 or newer): `npm ci` installs the toolchain, `npm run check` runs the type check, lint and tests, and `npm run build` regenerates the committed `plugins/alex-loop/skills/worktree-add/scripts/worktree-add.mjs`. `scripts/validate-plugin.sh` fails when the bundle is stale (it differs from a fresh build) or when `node_modules` is missing.

`npm ci` also sets `core.hooksPath` to `.githooks`, whose pre-commit hook rejects a commit when the staged bundle differs from a fresh build of the staged sources; fix it with `npm run build` and stage the bundle.

## Machine-local overrides (`CLAUDE.local.md` / `AGENTS.local.md`)

All directive detection reads four repo-root files: the checked-in `CLAUDE.md` / `AGENTS.md` and their machine-local `CLAUDE.local.md` / `AGENTS.local.md` variants (typically gitignored). A directive in a `.local.md` file works exactly like a committed one, but only on that machine — per-machine settings stay out of the repository.

- On a value conflict (`commit-policy`, `external-models`, `design-questions`), the machine-local file overrides the checked-in one. The presence-only directives (`autonomous`, `context-watchdog: off`) take effect when found in any of the four files.
- `feature-config` prefers the machine-local file as its write target: when a `.local.md` variant exists at the repo root, decided settings land there; the checked-in file is written only when no `.local.md` exists or the user explicitly asks for a committed setting.
- The global `~/.claude/CLAUDE.md` / `~/.codex/AGENTS.md` are never read for directives and never written.
