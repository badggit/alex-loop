import path from 'node:path';

import { canonical } from './paths.ts';
import { showText } from './text.ts';
import type { CommandResult, Deps, RepoLayout } from './types.ts';
import { listWorktrees } from './worktrees.ts';

export type RepoResult = { ok: true; repo: RepoLayout } | { ok: false; reason: string };

export type BranchNameCheck = 'valid' | 'invalid' | { error: string };

// Both directories are canonical and absolute.
interface GitDirs {
    gitDir: string;
    commonDir: string;
}

const BRANCH_REJECTED_CODE = 1;

function gitIn(deps: Deps, dir: string, args: readonly string[]): Promise<CommandResult> {
    return deps.runner.run({ file: 'git', args: ['-C', dir, ...args] });
}

function withoutFinalNewline(text: string): string {
    return text.endsWith('\n') ? text.slice(0, -1) : text;
}

function failureLine(result: CommandResult): string {
    if (result.spawnError !== undefined) {
        return showText(result.spawnError);
    }
    const [first = ''] = result.stderr.trim().split('\n', 1);
    return first.length > 0 ? showText(first) : `git exited with code ${String(result.code)}`;
}

// A relative directory printed by rev-parse is relative to the directory git ran in.
async function canonicalDir(deps: Deps, dir: string, flag: string): Promise<string | undefined> {
    const result = await gitIn(deps, dir, ['rev-parse', flag]);
    const value = withoutFinalNewline(result.stdout);
    return result.code === 0 && value.length > 0 ? canonical(path.resolve(dir, value)) : undefined;
}

// --path-format=absolute needs git 2.31, so relative output is resolved by canonicalDir instead.
async function gitDirsOf(deps: Deps, dir: string): Promise<GitDirs | undefined> {
    const gitDir = await canonicalDir(deps, dir, '--absolute-git-dir');
    const commonDir = await canonicalDir(deps, dir, '--git-common-dir');
    return gitDir === undefined || commonDir === undefined ? undefined : { gitDir, commonDir };
}

// The first listed entry is the main tree only when it is a real working tree of ours; a bare hub lists its git dir.
async function confirmedMainTree(deps: Deps, dir: string, commonDir: string): Promise<string | undefined> {
    const [first] = (await listWorktrees(deps, dir)) ?? [];
    if (first === undefined || first.bare) {
        return;
    }
    const entry = canonical(first.path);
    const toplevel = await canonicalDir(deps, entry, '--show-toplevel');
    const entryCommon = await canonicalDir(deps, entry, '--git-common-dir');
    return toplevel === entry && entryCommon === commonDir ? entry : undefined;
}

async function linkedLayout(deps: Deps, current: string, commonDir: string): Promise<RepoLayout> {
    const main = await confirmedMainTree(deps, current, commonDir);
    return main === undefined
        ? { current, main: current, mainFound: false, linked: true }
        : { current, main, mainFound: true, linked: true };
}

// Fails closed: a probe git could not answer refuses just like a probe that found a superproject.
async function superprojectRefusal(deps: Deps, dir: string): Promise<string | undefined> {
    const result = await gitIn(deps, dir, ['rev-parse', '--show-superproject-working-tree']);
    if (result.code !== 0) {
        return `cannot check whether ${showText(dir)} is inside a superproject: ${failureLine(result)}`;
    }
    const superproject = withoutFinalNewline(result.stdout);
    if (superproject.length === 0) {
        return;
    }
    return `the main working tree ${showText(dir)} is a submodule; a sibling worktree would land inside the superproject ${showText(superproject)}`;
}

export async function locateRepository(deps: Deps, cwd: string): Promise<RepoResult> {
    const dir = canonical(cwd);
    const shownCwd = showText(cwd);
    const inside = await gitIn(deps, dir, ['rev-parse', '--is-inside-work-tree']);
    if (inside.code !== 0) {
        return { ok: false, reason: `not a git repository: ${shownCwd}` };
    }
    if (inside.stdout.trim() !== 'true') {
        return { ok: false, reason: `not inside a git working tree: ${shownCwd}` };
    }
    const current = await canonicalDir(deps, dir, '--show-toplevel');
    if (current === undefined) {
        return { ok: false, reason: `not a git repository: ${shownCwd}` };
    }
    const dirs = await gitDirsOf(deps, current);
    if (dirs === undefined) {
        return { ok: false, reason: `cannot read the git directories of ${showText(current)}` };
    }
    // A main working tree, a submodule and a separate-git-dir clone share one directory for both.
    if (dirs.gitDir !== dirs.commonDir) {
        return { ok: true, repo: await linkedLayout(deps, current, dirs.commonDir) };
    }
    const reason = await superprojectRefusal(deps, current);
    if (reason !== undefined) {
        return { ok: false, reason };
    }
    return { ok: true, repo: { current, main: current, mainFound: true, linked: false } };
}

// check-ref-format exits 1 for a name it rejects; any other failure means git itself could not run the check.
export async function checkBranchName(deps: Deps, dir: string, branch: string): Promise<BranchNameCheck> {
    const result = await gitIn(deps, dir, ['check-ref-format', `refs/heads/${branch}`]);
    if (result.spawnError === undefined && result.code === 0) {
        return 'valid';
    }
    if (result.spawnError === undefined && result.code === BRANCH_REJECTED_CODE) {
        return 'invalid';
    }
    return { error: `cannot check the branch name ${showText(branch)}: ${failureLine(result)}` };
}
