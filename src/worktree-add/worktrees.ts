import fs from 'node:fs';
import path from 'node:path';

import { canonicalLoose, lstatOrUndefined } from './paths.ts';
import type { Deps, WorktreeEntry } from './types.ts';

export type LockState = 'locked' | 'unlocked' | 'unknown';

const BRANCH_LINE_PREFIX = 'branch refs/heads/';

const GITDIR_LINE = /^gitdir: (.+?)\r?\n?$/u;

function errorCode(error: unknown): unknown {
    return error instanceof Error && 'code' in error ? error.code : undefined;
}

function hasFlag(line: string, flag: string): boolean {
    return line === flag || line.startsWith(`${flag} `);
}

// Parses git worktree list --porcelain: one block per working tree, separated by empty lines, the main one first.
export function parseWorktreeList(text: string): WorktreeEntry[] {
    const entries: WorktreeEntry[] = [];
    let current: WorktreeEntry | undefined;
    for (const line of text.split('\n')) {
        if (line.startsWith('worktree ')) {
            current = {
                path: line.slice('worktree '.length),
                branch: undefined,
                bare: false,
                detached: false,
                locked: false,
                prunable: false,
            };
            entries.push(current);
        } else if (current !== undefined) {
            if (line.startsWith(BRANCH_LINE_PREFIX)) {
                current.branch = line.slice(BRANCH_LINE_PREFIX.length);
            } else if (line === 'bare') {
                current.bare = true;
            } else if (line === 'detached') {
                current.detached = true;
            } else if (hasFlag(line, 'locked')) {
                current.locked = true;
            } else if (hasFlag(line, 'prunable')) {
                current.prunable = true;
            }
        }
    }
    return entries;
}

export async function listWorktrees(deps: Deps, dir: string): Promise<WorktreeEntry[] | undefined> {
    const listed = await deps.runner.run({ file: 'git', args: ['-C', dir, 'worktree', 'list', '--porcelain'] });
    return listed.code === 0 && listed.spawnError === undefined ? parseWorktreeList(listed.stdout) : undefined;
}

// The same folder, also when reached through a symlinked parent or already gone.
export function matchesTarget(entryPath: string, target: string): boolean {
    return entryPath === target || canonicalLoose(entryPath) === canonicalLoose(target);
}

function readSingleLine(file: string): string | undefined {
    let text: string;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch {
        return;
    }
    const line = text.endsWith('\n') ? text.slice(0, -1) : text;
    return line.length === 0 || line.includes('\n') ? undefined : line;
}

// The admin dir must name dotGit back, so a forged .git line cannot borrow an unrelated directory's lock state.
function linksBack(adminDir: string, dotGit: string): boolean {
    const record = readSingleLine(path.join(adminDir, 'gitdir'));
    return record !== undefined && canonicalLoose(path.resolve(adminDir, record)) === canonicalLoose(dotGit);
}

function lockMarkerState(adminDir: string): LockState {
    try {
        fs.lstatSync(path.join(adminDir, 'locked'));
        return 'locked';
    } catch (error) {
        return errorCode(error) === 'ENOENT' ? 'unlocked' : 'unknown';
    }
}

// Git never locks the main tree; only it may have a .git file naming the common dir (a separate-git-dir clone).
function lockStateOfFolder(worktreePath: string, commonDir: string, isMain: boolean): LockState {
    const dotGit = path.join(worktreePath, '.git');
    if (lstatOrUndefined(dotGit)?.isDirectory() === true) {
        return 'unlocked';
    }
    let text: string;
    try {
        text = fs.readFileSync(dotGit, 'utf8');
    } catch {
        return 'unknown';
    }
    const pointer = GITDIR_LINE.exec(text)?.[1];
    if (pointer === undefined) {
        return 'unknown';
    }
    const adminDir = path.resolve(worktreePath, pointer);
    if (isMain && canonicalLoose(adminDir) === canonicalLoose(commonDir)) {
        return 'unlocked';
    }
    return linksBack(adminDir, dotGit) ? lockMarkerState(adminDir) : 'unknown';
}

// Without the folder there is no .git file, so the admin dir is found by its gitdir record in the common dir.
function lockStateOfMissing(worktreePath: string, commonDir: string): LockState {
    const adminRoot = path.join(commonDir, 'worktrees');
    let names: string[];
    try {
        names = fs.readdirSync(adminRoot);
    } catch {
        return 'unknown';
    }
    const dotGit = path.join(worktreePath, '.git');
    for (const name of names) {
        const adminDir = path.join(adminRoot, name);
        if (linksBack(adminDir, dotGit)) {
            return lockMarkerState(adminDir);
        }
    }
    return 'unknown';
}

// A porcelain locked line wins; git 2.29 prints none, so the lock marker in the admin dir is read instead.
export function lockState(entry: WorktreeEntry, commonDir: string, isMain = false): LockState {
    if (entry.locked) {
        return 'locked';
    }
    if (entry.bare) {
        return 'unlocked';
    }
    return lstatOrUndefined(entry.path) === undefined
        ? lockStateOfMissing(entry.path, commonDir)
        : lockStateOfFolder(entry.path, commonDir, isMain);
}
