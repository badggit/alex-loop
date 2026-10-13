import path from 'node:path';

import { showText } from './text.ts';
import type { CommandResult, Deps, StartPoint, WorktreeEntry } from './types.ts';
import { listWorktrees, matchesTarget } from './worktrees.ts';

export type StartResult = { ok: true; start: StartPoint } | { ok: false; reason: string };

interface Upstream {
    ref: string;
    shown: string;
}

const BRANCH_REF_PREFIX = 'refs/heads/';
const ORIGIN_REF_PREFIX = 'refs/remotes/origin/';
const FALLBACK_BRANCHES = ['main', 'master'];
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const COUNT = /^\d+$/u;
const LEFT_RIGHT_COUNTS = /^(\d+)\s+(\d+)$/u;
const TICKET = /^([a-z][a-z0-9]*-\d+)(?:-|$)/u;

function git(deps: Deps, dir: string, args: readonly string[]): Promise<CommandResult> {
    return deps.runner.run({ file: 'git', args: ['-C', dir, ...args] });
}

function succeeded(result: CommandResult): boolean {
    return result.code === 0 && result.spawnError === undefined;
}

async function printed(deps: Deps, dir: string, args: readonly string[]): Promise<string | undefined> {
    const result = await git(deps, dir, args);
    const text = result.stdout.trim();
    return succeeded(result) && text.length > 0 ? text : undefined;
}

async function refExists(deps: Deps, dir: string, ref: string): Promise<boolean> {
    return succeeded(await git(deps, dir, ['show-ref', '--verify', '--quiet', ref]));
}

async function originHeadBranch(deps: Deps, main: string): Promise<string | undefined> {
    const ref = await printed(deps, main, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    return ref?.startsWith(ORIGIN_REF_PREFIX) === true ? ref.slice(ORIGIN_REF_PREFIX.length) : undefined;
}

// Network-free: origin/HEAD, init.defaultBranch, main, master; a candidate counts only with a local branch of that name.
export async function defaultBranch(deps: Deps, main: string): Promise<string | undefined> {
    const candidates = [
        await originHeadBranch(deps, main),
        await printed(deps, main, ['config', '--get', 'init.defaultBranch']),
        ...FALLBACK_BRANCHES,
    ];
    for (const candidate of candidates) {
        if (
            candidate !== undefined &&
            candidate.length > 0 &&
            (await refExists(deps, main, `${BRANCH_REF_PREFIX}${candidate}`))
        ) {
            return candidate;
        }
    }
    return;
}

// Full refs keep a tag of the same name from shadowing the branch.
async function commitOf(deps: Deps, main: string, ref: string): Promise<string | undefined> {
    const sha = await printed(deps, main, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return sha !== undefined && OBJECT_ID.test(sha) ? sha : undefined;
}

async function upstreamOf(deps: Deps, main: string, branch: string): Promise<Upstream | undefined> {
    const configured = await printed(deps, main, [
        'for-each-ref',
        '--format=%(upstream) %(upstream:short)',
        `${BRANCH_REF_PREFIX}${branch}`,
    ]);
    const [ref, shown] = configured?.split(' ') ?? [];
    if (ref !== undefined && shown !== undefined && ref.length > 0 && (await refExists(deps, main, ref))) {
        return { ref, shown };
    }
    const remote = `${ORIGIN_REF_PREFIX}${branch}`;
    return (await refExists(deps, main, remote)) ? { ref: remote, shown: `origin/${branch}` } : undefined;
}

async function warnIfBehind(deps: Deps, main: string, branch: string): Promise<void> {
    const upstream = await upstreamOf(deps, main, branch);
    if (upstream === undefined) {
        return;
    }
    const count = await printed(deps, main, ['rev-list', '--count', `${BRANCH_REF_PREFIX}${branch}..${upstream.ref}`]);
    if (count === undefined || !COUNT.test(count) || Number.parseInt(count, 10) === 0) {
        return;
    }
    deps.log.warn(
        `local ${showText(branch)} is ${count} commits behind ${showText(upstream.shown)} (local refs, no fetch); ` +
            'the new branch starts from the older commit'
    );
}

async function headStart(deps: Deps, main: string): Promise<StartResult> {
    const sha = await commitOf(deps, main, 'HEAD');
    if (sha === undefined) {
        return { ok: false, reason: 'the main clone has no commits yet' };
    }
    const branch = await printed(deps, main, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    deps.log.warn("no default branch found; the new branch starts from the main clone's HEAD");
    return { ok: true, start: { sha, label: branch === undefined ? 'HEAD (detached)' : `HEAD (${branch})` } };
}

// A new branch starts from the local default branch, never from whatever the main clone has checked out.
export async function startPoint(deps: Deps, main: string): Promise<StartResult> {
    const branch = await defaultBranch(deps, main);
    if (branch === undefined) {
        return headStart(deps, main);
    }
    const sha = await commitOf(deps, main, `${BRANCH_REF_PREFIX}${branch}`);
    if (sha === undefined) {
        return { ok: false, reason: `cannot resolve the default branch ${showText(branch)}` };
    }
    await warnIfBehind(deps, main, branch);
    return { ok: true, start: { sha, label: branch } };
}

// rev-list --left-right --count D...B prints commits only in D (behind) and then only in B (ahead).
async function aheadBehind(deps: Deps, main: string, base: string, branch: string): Promise<string | undefined> {
    const counts = await printed(deps, main, [
        'rev-list',
        '--left-right',
        '--count',
        `${BRANCH_REF_PREFIX}${base}...${BRANCH_REF_PREFIX}${branch}`,
    ]);
    const match = counts === undefined ? undefined : LEFT_RIGHT_COUNTS.exec(counts);
    if (match === null || match === undefined) {
        return;
    }
    const [, behind = '', ahead = ''] = match;
    return `${ahead} ahead / ${behind} behind ${showText(base)}`;
}

export async function logExistingBranch(deps: Deps, main: string, branch: string): Promise<void> {
    const date = await printed(deps, main, ['log', '-1', '--format=%cs', `${BRANCH_REF_PREFIX}${branch}`, '--']);
    const base = await defaultBranch(deps, main);
    const counts = base === undefined ? undefined : await aheadBehind(deps, main, base, branch);
    const head = `checking out EXISTING local branch ${showText(branch)}: last commit ${showText(date ?? 'unknown')}`;
    deps.log.info(counts === undefined ? head : `${head}, ${counts}`);
}

// The leading tracker key such as rep-123 or gh-42; fix-2-bugs yields fix-2, harmless for an informational listing.
export function ticketOf(suffix: string): string | undefined {
    return TICKET.exec(suffix)?.[1];
}

function namesTicket(folder: string, key: string): boolean {
    return folder.includes(`-${key}-`) || folder.endsWith(`-${key}`);
}

function describeEntry(entry: WorktreeEntry): string {
    return `${showText(entry.path)} (${entry.branch === undefined ? 'detached' : showText(entry.branch)})`;
}

export async function logSameTicket(deps: Deps, main: string, suffix: string, target: string): Promise<void> {
    const key = ticketOf(suffix);
    if (key === undefined) {
        return;
    }
    const entries = await listWorktrees(deps, main);
    const others = (entries ?? []).filter(
        (entry) => !matchesTarget(entry.path, target) && namesTicket(path.basename(entry.path), key)
    );
    if (others.length === 0) {
        return;
    }
    deps.log.info(`other worktrees for ticket ${key}: ${others.map((entry) => describeEntry(entry)).join(', ')}`);
}
