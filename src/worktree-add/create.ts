import fs from 'node:fs';
import path from 'node:path';

import { showText } from './text.ts';
import type { ApplyStep, CommandResult, Deps, RepoLayout, WorktreeTarget } from './types.ts';
import { listWorktrees, matchesTarget } from './worktrees.ts';

export type ApplyResult = { ok: true } | { ok: false; reason: string };

// A branch this run created: its sha right after creation, and whether git may have written its upstream keys.
interface OwnedBranch {
    sha: string;
    tracked: boolean;
}

type BranchResult = { ok: true; owned: OwnedBranch | undefined } | { ok: false; reason: string };

type ParentResult = { ok: true; createdTop: string | undefined } | { ok: false; reason: string };

const BRANCH_REF_PREFIX = 'refs/heads/';
const SHORT_SHA_LENGTH = 7;
// git config --unset exits 5 when the key is absent.
const CONFIG_KEY_ABSENT = 5;
const UPSTREAM_KEYS = ['remote', 'merge'] as const;

function git(deps: Deps, dir: string, args: readonly string[]): Promise<CommandResult> {
    return deps.runner.run({ file: 'git', args: ['-C', dir, ...args] });
}

function succeeded(result: CommandResult): boolean {
    return result.code === 0 && result.spawnError === undefined;
}

function errorLine(result: CommandResult): string {
    if (result.spawnError !== undefined) {
        return showText(result.spawnError);
    }
    const [first = ''] = result.stderr.trim().split('\n', 1);
    const line = first.trim();
    return line.length > 0 ? showText(line) : `git exited with code ${String(result.code)}`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function commitOf(deps: Deps, dir: string, ref: string): Promise<string | undefined> {
    const result = await git(deps, dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    const sha = result.stdout.trim();
    return succeeded(result) && sha.length > 0 ? sha : undefined;
}

// git refuses to overwrite an existing branch, so a failure here means the branch is not ours and stays untouched.
async function createBranchAt(
    deps: Deps,
    dir: string,
    branch: string,
    sha: string,
    tracked: boolean
): Promise<BranchResult> {
    const created = await git(deps, dir, ['branch', '--no-track', branch, sha]);
    return succeeded(created) ? { ok: true, owned: { sha, tracked } } : { ok: false, reason: errorLine(created) };
}

// The remote commit is pinned first, so ownership is the sha this run chose, not one another process moved it to.
async function createTrackedBranch(deps: Deps, dir: string, branch: string, remote: string): Promise<BranchResult> {
    const upstream = `${remote}/${branch}`;
    const sha = await commitOf(deps, dir, `refs/remotes/${upstream}`);
    if (sha === undefined) {
        return { ok: false, reason: `cannot resolve the remote branch ${showText(upstream)}` };
    }
    return createBranchAt(deps, dir, branch, sha, true);
}

function createBranch(deps: Deps, dir: string, branch: string, step: ApplyStep): Promise<BranchResult> {
    switch (step.kind) {
        case 'create': {
            return createBranchAt(deps, dir, branch, step.start.sha, false);
        }
        case 'track': {
            return createTrackedBranch(deps, dir, branch, step.remote);
        }
        case 'checkout':
        case 'reuse': {
            return Promise.resolve({ ok: true, owned: undefined });
        }
    }
}

// Deletes the branch only while it still points at the sha this run created; then only its upstream keys go.
async function rollbackBranch(deps: Deps, dir: string, branch: string, owned: OwnedBranch): Promise<void> {
    const deleted = await git(deps, dir, [
        'update-ref',
        '--no-deref',
        '-d',
        `${BRANCH_REF_PREFIX}${branch}`,
        owned.sha,
    ]);
    if (!succeeded(deleted)) {
        deps.log.warn(`branch ${showText(branch)} was kept: ${errorLine(deleted)}`);
        return;
    }
    if (!owned.tracked) {
        return;
    }
    for (const key of UPSTREAM_KEYS) {
        const unset = await git(deps, dir, ['config', '--unset', `branch.${branch}.${key}`]);
        if (!succeeded(unset) && unset.code !== CONFIG_KEY_ABSENT) {
            deps.log.warn(`cannot remove branch.${showText(branch)}.${key}: ${errorLine(unset)}`);
        }
    }
}

// Only empty folders go, from the target's parent up to the topmost folder this run created.
function removeCreatedParents(parent: string, createdTop: string | undefined): void {
    if (createdTop === undefined) {
        return;
    }
    let dir = parent;
    for (;;) {
        try {
            fs.rmdirSync(dir);
        } catch {
            return;
        }
        const up = path.dirname(dir);
        if (dir === createdTop || up === dir) {
            return;
        }
        dir = up;
    }
}

// A worktree registered at the target anyway (a failing post-checkout hook) keeps everything; else roll back.
async function abandon(
    deps: Deps,
    repo: RepoLayout,
    target: WorktreeTarget,
    owned: OwnedBranch | undefined,
    reason: string,
    createdTop?: string
): Promise<ApplyResult> {
    const shownBranch = showText(target.branch);
    const entries = await listWorktrees(deps, repo.current);
    if (entries === undefined) {
        return { ok: false, reason: owned === undefined ? reason : `${reason}; branch ${shownBranch} was kept` };
    }
    const registered = entries.find((entry) => matchesTarget(entry.path, target.path));
    if (registered !== undefined) {
        const onBranch = registered.branch === undefined ? 'a detached HEAD' : showText(registered.branch);
        return {
            ok: false,
            reason: `the worktree exists at ${showText(target.path)} on ${onBranch} but git reported an error: ${reason}`,
        };
    }
    removeCreatedParents(target.parent, createdTop);
    if (owned !== undefined) {
        if (entries.some((entry) => entry.branch === target.branch)) {
            deps.log.warn(`branch ${shownBranch} was kept: a worktree has it checked out`);
        } else {
            await rollbackBranch(deps, repo.current, target.branch, owned);
        }
    }
    return { ok: false, reason };
}

async function setUpstream(deps: Deps, dir: string, branch: string, remote: string): Promise<string | undefined> {
    const upstream = `${remote}/${branch}`;
    const tracking = await git(deps, dir, ['branch', `--set-upstream-to=refs/remotes/${upstream}`, branch]);
    if (succeeded(tracking)) {
        return;
    }
    return `cannot set the upstream of ${showText(branch)} to ${showText(upstream)}: ${errorLine(tracking)}`;
}

function createParent(deps: Deps, parent: string): ParentResult {
    try {
        const createdTop = fs.mkdirSync(parent, { recursive: true });
        deps.log.info(`created parent folder ${showText(parent)}`);
        return { ok: true, createdTop };
    } catch (error) {
        return {
            ok: false,
            reason: `cannot create the parent folder ${showText(parent)}: ${showText(errorMessage(error))}`,
        };
    }
}

function createdMessage(target: WorktreeTarget, step: ApplyStep): string {
    const shownPath = showText(target.path);
    const shownBranch = showText(target.branch);
    switch (step.kind) {
        case 'create': {
            const short = step.start.sha.slice(0, SHORT_SHA_LENGTH);
            return `created worktree ${shownPath} on new branch ${shownBranch} from ${showText(step.start.label)} @ ${showText(short)}`;
        }
        case 'track': {
            return `created worktree ${shownPath} on new branch ${shownBranch} tracking ${showText(step.remote)}/${shownBranch}`;
        }
        case 'checkout':
        case 'reuse': {
            return `created worktree ${shownPath} on existing branch ${shownBranch}`;
        }
    }
}

// Never git worktree add -b: branch and upstream first, then the parent; a failure undoes only this run's work.
export async function applyStep(
    deps: Deps,
    repo: RepoLayout,
    target: WorktreeTarget,
    step: ApplyStep
): Promise<ApplyResult> {
    if (step.kind === 'reuse') {
        deps.log.info(`reusing worktree ${showText(target.path)} on ${showText(target.branch)}`);
        return { ok: true };
    }
    const dir = repo.current;
    const branch = await createBranch(deps, dir, target.branch, step);
    if (!branch.ok) {
        return branch;
    }
    if (step.kind === 'track') {
        const failed = await setUpstream(deps, dir, target.branch, step.remote);
        if (failed !== undefined) {
            return abandon(deps, repo, target, branch.owned, failed);
        }
    }
    let createdTop: string | undefined;
    if (target.parentMissing) {
        const parent = createParent(deps, target.parent);
        if (!parent.ok) {
            return abandon(deps, repo, target, branch.owned, parent.reason);
        }
        createdTop = parent.createdTop;
    }
    const added = await git(deps, dir, ['worktree', 'add', '--quiet', target.path, target.branch]);
    if (!succeeded(added)) {
        return abandon(deps, repo, target, branch.owned, errorLine(added), createdTop);
    }
    deps.log.info(createdMessage(target, step));
    return { ok: true };
}
