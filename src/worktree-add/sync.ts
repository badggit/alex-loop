import fs from 'node:fs';
import path from 'node:path';

import { addExcludePatterns, anchoredPattern, TEMP_PATTERN } from './exclude.ts';
import { isLinkWithText, lstatOrUndefined, parentInside } from './paths.ts';
import { hasControlCharacter, showText } from './text.ts';
import type { Deps, EntryTransfer } from './types.ts';

export type EntryClass = 'copy' | 'dep' | 'skip' | 'link';

interface SyncRun {
    deps: Deps;
    main: string;
    worktree: string;
    transfer: EntryTransfer;
    linked: string[];
    linkedWithoutCow: string[];
}

const COPY_NAMES: ReadonlySet<string> = new Set(['.env', 'CLAUDE.local.md', 'temp.local']);
const COPY_PREFIX = '.env.';
const DEPENDENCY_NAME = 'node_modules';
// Build and cache outputs stay per worktree: a link would let one branch overwrite the outputs of another.
const SKIP_NAMES: ReadonlySet<string> = new Set([
    '.cache',
    '.eslintcache',
    '.next',
    '.turbo',
    'build',
    'coverage',
    'dist',
    'out',
]);
const SKIP_SUFFIX = '.tsbuildinfo';
const REPLACEMENT_CHARACTER = '\uFFFD';

export function classify(rel: string): EntryClass {
    const name = path.posix.basename(rel);
    if (COPY_NAMES.has(name) || name.startsWith(COPY_PREFIX)) {
        return 'copy';
    }
    if (name === DEPENDENCY_NAME) {
        return 'dep';
    }
    if (SKIP_NAMES.has(name) || name.endsWith(SKIP_SUFFIX)) {
        return 'skip';
    }
    return 'link';
}

function errorCode(error: unknown): string {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
        return error.code;
    }
    return 'unknown';
}

// The topmost ignored entries of MAIN, relative and without a trailing slash; undefined when git fails.
async function listIgnored(deps: Deps, main: string): Promise<string[] | undefined> {
    const listed = await deps.runner.run({
        file: 'git',
        args: ['-C', main, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'],
    });
    if (listed.code !== 0) {
        return;
    }
    return listed.stdout
        .split('\0')
        .map((entry) => (entry.endsWith('/') ? entry.slice(0, -1) : entry))
        .filter((entry) => entry.length > 0);
}

// The runner decodes output as UTF-8, so a name with invalid bytes arrives with U+FFFD and cannot be addressed.
function usableEntries(deps: Deps, rels: readonly string[]): string[] {
    const kept: string[] = [];
    for (const rel of rels) {
        if (hasControlCharacter(rel)) {
            deps.log.warn(`skipped an ignored path with a control character in its name: ${showText(rel)}`);
        } else if (rel.includes(REPLACEMENT_CHARACTER)) {
            deps.log.warn(`skipped an ignored path whose name is not valid UTF-8: ${showText(rel)}`);
        } else {
            kept.push(rel);
        }
    }
    return kept;
}

function isOwnLink(run: SyncRun, rel: string): boolean {
    return isLinkWithText(path.join(run.worktree, rel), path.join(run.main, rel));
}

// An own link may stand where a copy or a dependency belongs: the transfer replaces it with the real entry.
function destinationOpen(run: SyncRun, rel: string, kind: EntryClass): boolean {
    if (lstatOrUndefined(path.join(run.worktree, rel)) === undefined) {
        return true;
    }
    return kind !== 'link' && isOwnLink(run, rel);
}

function linkMissing(run: SyncRun, rel: string): boolean {
    const dest = path.join(run.worktree, rel);
    if (lstatOrUndefined(dest) !== undefined) {
        return false;
    }
    try {
        fs.symlinkSync(path.join(run.main, rel), dest);
        return true;
    } catch (error) {
        const code = errorCode(error);
        if (code !== 'EEXIST') {
            run.deps.log.warn(`cannot link ${showText(rel)} into the worktree: ${showText(code)}`);
        }
        return false;
    }
}

async function syncDependency(run: SyncRun, rel: string): Promise<void> {
    const outcome = await run.transfer.cloneDependency(rel);
    if (outcome.kind === 'cloned') {
        return;
    }
    const linked = linkMissing(run, rel);
    if (outcome.kind === 'unavailable') {
        if (linked) {
            run.linkedWithoutCow.push(rel);
        }
        return;
    }
    const fallback = isOwnLink(run, rel) ? '; linked it instead' : '';
    run.deps.log.warn(`cannot clone ${showText(rel)} into the worktree (${showText(outcome.reason)})${fallback}`);
}

async function syncEntry(run: SyncRun, rel: string, kind: EntryClass): Promise<void> {
    if (kind === 'skip' || !parentInside(run.worktree, rel) || !destinationOpen(run, rel, kind)) {
        return;
    }
    switch (kind) {
        case 'copy': {
            await run.transfer.copyEntry(rel);
            return;
        }
        case 'dep': {
            await syncDependency(run, rel);
            return;
        }
        case 'link': {
            if (linkMissing(run, rel)) {
                run.linked.push(rel);
            }
            return;
        }
    }
}

function joinShown(rels: readonly string[]): string {
    return rels.map((rel) => showText(rel)).join(', ');
}

function reportLinks(run: SyncRun): void {
    if (run.linked.length > 0) {
        run.deps.log.info(`linked ${joinShown(run.linked)}`);
    }
    if (run.linkedWithoutCow.length > 0) {
        run.deps.log.info(
            `linked ${joinShown(run.linkedWithoutCow)}: no copy-on-write between the clone and the worktree`
        );
    }
}

// Copies get no pattern: they are ignored by the repository's own rules; links and dependency folders may not be.
function excludedPatterns(run: SyncRun, entries: readonly string[]): string[] {
    const patterns: string[] = [];
    for (const rel of entries) {
        const kind = classify(rel);
        if (kind === 'copy') {
            continue;
        }
        const isDependencyFolder =
            kind === 'dep' && lstatOrUndefined(path.join(run.worktree, rel))?.isDirectory() === true;
        if (isOwnLink(run, rel) || isDependencyFolder) {
            patterns.push(anchoredPattern(rel));
        }
    }
    return patterns;
}

// Problems are warnings and never stop the run; nothing that already stands in the worktree is overwritten.
export async function syncIgnored(deps: Deps, main: string, worktree: string, transfer: EntryTransfer): Promise<void> {
    const listed = await listIgnored(deps, main);
    if (listed === undefined) {
        deps.log.warn(`cannot list the ignored files of ${showText(main)}; nothing synced into the worktree`);
        return;
    }
    const entries = usableEntries(deps, listed);
    const run: SyncRun = { deps, main, worktree, transfer, linked: [], linkedWithoutCow: [] };
    if (entries.some((rel) => classify(rel) === 'copy' || classify(rel) === 'dep')) {
        await addExcludePatterns(deps, worktree, [TEMP_PATTERN]);
    }
    for (const rel of entries) {
        await syncEntry(run, rel, classify(rel));
    }
    reportLinks(run);
    await addExcludePatterns(deps, worktree, excludedPatterns(run, entries));
}
