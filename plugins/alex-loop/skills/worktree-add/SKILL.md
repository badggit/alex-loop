---
name: worktree-add
description: "Creates a sibling git worktree of the current project for parallel work, named after the current task, with per-worktree copies of the .env files, CLAUDE.local.md and temp.local, and moves the session into it. Invoked ONLY when the user runs /alex-loop:worktree-add, optionally with a parent folder. Do NOT self-trigger on generic requests like 'create a worktree'."
argument-hint: "[FOLDER]"
disable-model-invocation: true
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/skills/worktree-add/scripts/worktree-add.mjs *)
---

<!-- Updated: 2026-10-14 -->

# worktree-add

A thin wrapper around `scripts/worktree-add.mjs`, a Node script. The skill derives a name suffix from the current task, runs the script exactly once, relays its output and switches the session into the new worktree. The script does every check itself and prints the absolute worktree path on success.

What the script does (for answering questions; never repeat its work):

- The folder is `MAINFOLDER-SUFFIX`, next to the main clone or inside the given parent folder. The script derives the name; the skill only passes the suffix.
- `.env`, `.env.*`, `CLAUDE.local.md` and `temp.local` are copied per worktree. `node_modules` is cloned when copy-on-write is available, else linked. Build caches are skipped. Every other ignored entry (including `docs.local`, `.claude`, `.venv`) is linked to the main clone.
- A new branch starts from the local default branch, not the current HEAD. Uncommitted changes are not carried over.

Arguments: `$ARGUMENTS`

## 1. Read the arguments

`$ARGUMENTS` is the optional parent folder DIR, taken as one value and passed exactly as typed. Empty means no `--parent`. Do not change a `~` in it: the script expands a leading `~` or `~/` itself. Do not check the folder yourself.

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

End the reply with this one line: inside the worktree, deleting a linked folder with a trailing slash (`rm -rf docs.local/`) erases the main clone's data; remove the link itself (`rm docs.local`) instead.

## Rules

- No checks of your own before or after the run: no git, file or directory inspection. The script checks everything.
- Never retry with other arguments and never run any other command. Use no tools other than the one Bash call, tool search for `EnterWorktree`, and `EnterWorktree` itself.
- Removal stays manual: `git worktree remove PATH` and `git branch -d BRANCH` from the main clone when the work is done.
