import fs from 'node:fs';
import path from 'node:path';

import { canonical, errorCode, lstatOrUndefined } from './paths.ts';
import { showText } from './text.ts';
import type {
    CommandResult,
    Deps,
    RegisteredWorktree,
    RepoLayout,
    TargetFacts,
    WorktreeEntry,
    WorktreeTarget,
} from './types.ts';
import { listWorktrees, lockState, matchesTarget } from './worktrees.ts';

export type FactsResult = { ok: true; facts: TargetFacts } | { ok: false; reason: string };

type RefCheck = { ok: true; exists: boolean } | { ok: false; reason: string };

type RemoteMatches = { ok: true; matches: string[] } | { ok: false; reason: string };

type CommonDir = { ok: true; dir: string } | { ok: false; reason: string };

// show-ref --verify --quiet exits 1 for a ref that does not exist; every other nonzero exit is an error.
const REF_ABSENT_CODE = 1;

function git(deps: Deps, dir: string, args: readonly string[]): Promise<CommandResult> {
    return deps.runner.run({ file: 'git', args: ['-C', dir, ...args] });
}

function succeeded(result: CommandResult): boolean {
    return result.code === 0 && result.spawnError === undefined;
}

function failureLine(result: CommandResult): string {
    if (result.spawnError !== undefined) {
        return result.spawnError;
    }
    const line = result.stderr.split('\n', 1)[0]?.trim() ?? '';
    return line.length > 0 ? line : `git exited with code ${String(result.code)}`;
}

function targetStateOf(target: string): TargetFacts['targetState'] {
    try {
        return fs.lstatSync(target).isSymbolicLink() ? 'symlink' : 'present';
    } catch (error) {
        return errorCode(error) === 'ENOENT' ? 'absent' : 'unreadable';
    }
}

function findRegistered(entries: readonly WorktreeEntry[], target: string): WorktreeEntry | undefined {
    return entries.find((entry) => entry.path === target) ?? entries.find((entry) => matchesTarget(entry.path, target));
}

async function commonDirOf(deps: Deps, dir: string): Promise<CommonDir> {
    const result = await git(deps, dir, ['rev-parse', '--git-common-dir']);
    const printed = result.stdout.trim();
    if (!succeeded(result) || printed.length === 0) {
        return { ok: false, reason: 'cannot find the git folder of the repository' };
    }
    return { ok: true, dir: path.resolve(dir, printed) };
}

function describeRegistered(entry: WorktreeEntry, commonDir: string, isMain: boolean): RegisteredWorktree {
    const folderExists = lstatOrUndefined(entry.path) !== undefined;
    const state = lockState(entry, commonDir, isMain);
    return {
        path: entry.path,
        branch: entry.branch,
        bare: entry.bare,
        detached: entry.detached,
        // Fails closed before a reuse: a lock state that cannot be confirmed counts as locked while the folder exists.
        locked: state === 'locked' || (state === 'unknown' && folderExists),
        missing: entry.prunable || !folderExists,
    };
}

async function checkRef(deps: Deps, dir: string, ref: string, kind: string): Promise<RefCheck> {
    const result = await git(deps, dir, ['show-ref', '--verify', '--quiet', ref]);
    if (result.spawnError === undefined && (result.code === 0 || result.code === REF_ABSENT_CODE)) {
        return { ok: true, exists: result.code === 0 };
    }
    return { ok: false, reason: `cannot check ${kind} ${showText(ref)}: ${showText(failureLine(result))}` };
}

// The REMOTE/BRANCH names of the remote-tracking refs already fetched.
async function remoteMatchesOf(deps: Deps, dir: string, branch: string): Promise<RemoteMatches> {
    const listed = await git(deps, dir, ['remote']);
    if (!succeeded(listed)) {
        return { ok: false, reason: 'cannot list the remotes of the repository' };
    }
    const matches: string[] = [];
    const remotes = listed.stdout.split('\n').filter((line) => line.length > 0);
    for (const remote of remotes) {
        const check = await checkRef(deps, dir, `refs/remotes/${remote}/${branch}`, 'remote branch');
        if (!check.ok) {
            return check;
        }
        if (check.exists) {
            matches.push(`${remote}/${branch}`);
        }
    }
    return { ok: true, matches };
}

export async function gatherFacts(deps: Deps, repo: RepoLayout, target: WorktreeTarget): Promise<FactsResult> {
    const { current } = repo;
    const entries = await listWorktrees(deps, current);
    if (entries === undefined) {
        return { ok: false, reason: 'cannot list the worktrees of the repository' };
    }
    const remote = await remoteMatchesOf(deps, current, target.branch);
    if (!remote.ok) {
        return remote;
    }
    const local = await checkRef(deps, current, `refs/heads/${target.branch}`, 'branch');
    if (!local.ok) {
        return local;
    }
    const entry = findRegistered(entries, target.path);
    let registered: RegisteredWorktree | undefined;
    if (entry !== undefined) {
        const common = await commonDirOf(deps, current);
        if (!common.ok) {
            return common;
        }
        registered = describeRegistered(entry, common.dir, entry === entries[0]);
    }
    const holder = entries.find((other) => other !== entry && other.branch === target.branch);
    return {
        ok: true,
        facts: {
            target: target.path,
            branch: target.branch,
            targetIsMain: canonical(target.path) === canonical(repo.main),
            targetState: targetStateOf(target.path),
            registered,
            holder: holder?.path,
            localBranch: local.exists,
            remoteMatches: remote.matches,
        },
    };
}
