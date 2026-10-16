---
name: worktree-add
description: "Creates a sibling git worktree of the current project for parallel work, named after the current task, with per-worktree copies of the .env files, CLAUDE.local.md and temp.local and dependencies installed from the branch's own lock files, and moves the session into it. Invoked ONLY when the user runs /alex-loop:worktree-add, optionally with --no-install and a parent folder. Do NOT self-trigger on generic requests like 'create a worktree'."
argument-hint: "[--no-install] [FOLDER]"
disable-model-invocation: true
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/skills/worktree-add/scripts/worktree-add.mjs *)
---

<!-- Updated: 2026-10-16 -->

# worktree-add

A thin wrapper around `scripts/worktree-add.mjs`, a Node script. The skill derives a name suffix from the current task, runs the script exactly once, relays its output and switches the session into the new worktree. The script does every check itself and prints the absolute worktree path on success.

What the script does (for answering questions; never repeat its work):

- The folder is `MAINFOLDER-SUFFIX`, next to the main clone or inside the given parent folder. The script derives the name; the skill only passes the suffix.
- `.env`, `.env.*`, `CLAUDE.local.md` and `temp.local` are copied per worktree. Build caches are skipped. Every other ignored entry (including `docs.local` and `.claude`) is linked to the main clone.
- Dependencies (`node_modules`, and `.venv`, `venv` or any other folder holding `pyvenv.cfg`) are installed per worktree from the branch's own lock files (npm, pnpm, yarn, bun, uv), not linked. A project is installed automatically when it sits at the worktree root or the main clone has its dependency folder; others get a `not installed automatically` line with the command. For a uv project only its root `.venv` is installed; another Python environment inside it is linked like an orphan.
- A nested `node_modules` without its own lock file belongs to the root JS project only when the root's `workspaces` cover that folder; otherwise it is an orphan.
- Fallback: with `--no-install`, when the manager is not on PATH, or for an orphan (a folder no supported lock file covers), `node_modules` is cloned with copy-on-write, else linked, and a Python environment is linked. When `CODEX_SANDBOX_NETWORK_DISABLED=1`, installs are skipped and every dependency folder gets the same fallback as with `--no-install`; the log names the commands to run later. A folder whose parent does not exist in the worktree is skipped (`skipped ... does not exist in the worktree`); it is simply absent, not kept or linked. When the main clone's ignored files cannot be listed or synced, only the projects at the worktree root install automatically from the worktree's own lock files; nested projects get `not installed automatically` lines and the orphan fallback is skipped, with one warning that says so.
- A failed install removes only what the package manager can create (the project's `node_modules` or `.venv`, nested `node_modules` of that project, and manager files such as `.pnp.cjs`, `.pnp.loader.mjs`, `.yarn/install-state.gz`, `.yarn/unplugged`, `.yarn/cache` that were absent before); other new files stay. The folder is left missing, except where this run removed the tool's own link to the main clone: that link is put back (`the earlier link was restored`). A conflict between the lock files and `packageManager`, or a wrong manager version, gets no fallback either: the folders stay missing and the warning says why. npm does not enforce `packageManager`, so an npm pin of another major than the npm on PATH only gets an info line and the install runs; for pnpm, yarn and bun the pinned major is required. An unexpected error in one project is reported for that project and the others still install.
- A dependency folder that already stands in the worktree is never overwritten or reinstalled.
- The installs run the branch's own install scripts (npm `preinstall`/`postinstall`/`prepare`, uv build backends) with the user's full environment, exactly like running `npm ci` or `uv sync` by hand. For a branch the user does not trust, `--no-install` avoids running its code.
- Shared git config changed by an install is reverted with a warning, except keys under `branch.*` and `remote.*` (another worktree may set upstreams at the same time).
- A new branch starts from the local default branch, not the current HEAD. Uncommitted changes are not carried over.

Arguments: `$ARGUMENTS`

## 1. Read the arguments

When `$ARGUMENTS` starts with the word `--no-install`, remove it and pass `--no-install` to the script. `--no-install` counts only as the first word: if the user wrote it elsewhere (for example after the folder), move it to the front and pass it as the flag; never leave it inside DIR, or the script creates a folder with that name. The rest is the optional parent folder DIR, taken as one value and passed exactly as typed. Empty means no `--parent`. Do not change a `~` in it: the script expands a leading `~` or `~/` itself. Do not check the folder yourself.

## 2. Derive the suffix

SUFFIX is `TICKET-DESCRIPTION`, or only `DESCRIPTION` when there is no ticket.

- TICKET: only from the user's request for this worktree or from the current task's own turns: a ticket key presented as the work's ticket (for example `ABC-123`, written lowercase as `abc-123`), or a GitHub issue `#123`, written as `gh-123`. Never take it from the current branch name or from an older task, and never invent one.
- DESCRIPTION: 1-2 kebab-case ASCII words in lowercase that summarize the current task, without repeating the ticket. Transliterate non-Latin words into Latin letters.

If the conversation has no task to name the worktree after, ask the user one short question for the task as plain reply text, with no tool, and end the turn. When the user answers, read the answer with the same rules and continue.

## 3. Announce and run

In the same message as the run, state the derived SUFFIX and where each part came from (for example: ticket from the user's request, description from the current task).

Run the script exactly once, from the current project directory, as a single Bash call with no pipes, redirections or chaining, and with the longest tool timeout (600000 ms):

```
${CLAUDE_PLUGIN_ROOT}/skills/worktree-add/scripts/worktree-add.mjs --suffix 'SUFFIX'
${CLAUDE_PLUGIN_ROOT}/skills/worktree-add/scripts/worktree-add.mjs --suffix 'SUFFIX' --parent 'DIR'
${CLAUDE_PLUGIN_ROOT}/skills/worktree-add/scripts/worktree-add.mjs --suffix 'SUFFIX' --no-install
${CLAUDE_PLUGIN_ROOT}/skills/worktree-add/scripts/worktree-add.mjs --suffix 'SUFFIX' --parent 'DIR' --no-install
```

- Write the script path UNQUOTED, exactly as above, so the command text matches the `allowed-tools` rule. This relies on the resolved plugin path holding no spaces or shell metacharacters, which holds for the plugin cache and the development folder.
- Every argument value (SUFFIX, DIR) is POSIX single-quoted, DIR exactly as typed: wrap it in `'...'` and write each apostrophe inside it as `'\''`. Never use double quotes and never leave a value unquoted, even when it looks harmless. Examples:

```
$(id)       ->  '$(id)'
a`b         ->  'a`b'
a;rm x      ->  'a;rm x'
it's        ->  'it'\''s'
login-form  ->  'login-form'
```

- When `${CLAUDE_PLUGIN_ROOT}` stays as literal text (Codex), use the absolute path of `scripts/worktree-add.mjs` inside the folder that holds this SKILL.md, single-quoted (Codex has no `allowed-tools` rule to match).

## 4. Relay the output

Your reply starts with the script output exactly as printed: never capitalize, summarize, reword or translate it. Exit codes: 0 success, 1 refusal or error (one `error` log line), 2 usage error. On a non-zero exit, name the exit code and stop.

When the output has install warnings (log lines whose text after the level starts with `cannot install dependencies`, `not installed:`, `not installed with`, `cannot remove the partial install`, `cannot clone`, `cannot link` or `to install:`, except the `already stands` lines described below), add after the verbatim output a short block in the user's language:

- which project failed (the folder, or the worktree root) and why, in plain words;
- what is missing (`... is left missing`, `stays missing`) or was linked instead;
- the exact next step: the text of the `to install:` line, with its command, or the removal command the warning gives.

An `info` line starting with `not installed automatically` is not a failure: that project was intentionally left out. Mention it in the same block (or alone) with the command shown in it (`run in the worktree: ...`). When there are more than 3 such lines, do not relay each one: give their count and the command form once (for example `cd FOLDER && npm ci`).

A `not installed with MANAGER: PATH already stands in the worktree and is left as it is` line (also `already stand ... are left as they are`, or `not installed: ... it already stands in the worktree`) is not an install failure either: the existing folder was kept and works as before. Say so, and add that only to reinstall it from this branch's lock file, remove it (`rm -rf -- PATH` for a real folder, `rm PATH` with no trailing slash for a link) and rerun the same command from the main clone. Never present this removal as the fix for an error.

Whenever the output shows a dependency folder (`node_modules`, `.venv`, `venv` or a Python environment, at any depth) as linked, warnings or not (for example `installs skipped (--no-install): linked ...`, `installs skipped: the network is disabled in this sandbox; linked ...`, `linked ... meanwhile`, `linked it`, `linked it instead`, `linked node_modules: REASON` or `the earlier link was restored`), add that installs must not run in this worktree until the link itself is removed with `rm PATH` (no trailing slash; for example `rm node_modules`, `rm .venv`, `rm packages/a/node_modules`), because an install through the link writes into the main clone.

Runtime: the script needs git and Node 22 or newer on PATH. When the command fails because `node` is missing (shell exit 127, or a `node: not found` or `No such file or directory` message), say that Node 22 or newer is required and stop. An older Node is reported by the script itself (`Node 22 or newer is required, found X`).

## 5. Find PATH

The output mixes stdout and stderr in no guaranteed order. Log lines start with an ISO timestamp, for example `2026-10-08T10:00:00Z info ...`.

- If a log line, right after the timestamp, starts with `info already in the worktree `, the session already works in a linked worktree and nothing was created: say so in one sentence, do not switch, and go to step 7.
- Otherwise PATH is the single output line that starts with `/`. If there is not exactly one such line, do not switch: give the step 6 fallback lines with the literal placeholder `PATH` and say that the worktree path is in the output above.

## 6. Switch the session

- Claude Code: load the tool through tool search (`select:EnterWorktree`). Only when the search actually finds `EnterWorktree`, call it with its `path` parameter set to PATH. It always asks the user for approval, because PATH is outside `.claude/worktrees/`.
- If `EnterWorktree` is not found, is refused or the user declines, do not try anything else. Reply with two lines:
  - `/cd PATH` - built-in, only the user can type it; moves this session into the worktree.
  - `cd 'PATH' && claude` - starts a new session from a new terminal.
- Codex: give one line instead: `cd 'PATH' && codex`.

Write PATH single-quoted in the `cd` lines; a single quote inside PATH is written as `'\''`.

## 7. Closing line

End the reply with this one line: inside the worktree, deleting a linked folder with a trailing slash (`rm -rf docs.local/`, or `rm -rf node_modules/` when it was linked) erases the main clone's data; remove the link itself with `rm PATH`, no trailing slash (`rm docs.local`, `rm node_modules`, `rm .venv`) instead.

## Rules

- No checks of your own before or after the run: no git, file or directory inspection. The script checks everything.
- Never retry with other arguments and never run any other command. Use no tools other than the one Bash call, tool search for `EnterWorktree`, and `EnterWorktree` itself.
- Removal stays manual: `git worktree remove PATH` and `git branch -d BRANCH` from the main clone when the work is done.
