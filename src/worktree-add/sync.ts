import fs from 'node:fs';
import path from 'node:path';

import { addExcludePatterns, anchoredPattern, TEMP_PATTERN } from './exclude.ts';
import { errorCode, isOwnLink, lstatOrUndefined, parentInside } from './paths.ts';
import { hasControlCharacter, showText } from './text.ts';
import type { Deps, EntryTransfer } from './types.ts';

export type EntryClass = 'copy' | 'dep' | 'skip' | 'link';

interface ClassifiedEntry {
    rel: string;
    kind: EntryClass;
}

interface SyncRun {
    deps: Deps;
    main: string;
    worktree: string;
    transfer: EntryTransfer;
    linked: string[];
}

const COPY_NAMES: ReadonlySet<string> = new Set(['.env', 'CLAUDE.local.md', 'temp.local']);
const COPY_PREFIX = '.env.';
const DEPENDENCY_NAMES: ReadonlySet<string> = new Set(['node_modules', '.venv', 'venv']);
const VENV_MARKER = 'pyvenv.cfg';
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
    if (DEPENDENCY_NAMES.has(name)) {
        return 'dep';
    }
    if (SKIP_NAMES.has(name) || name.endsWith(SKIP_SUFFIX)) {
        return 'skip';
    }
    return 'link';
}

export function isVenvFolder(main: string, rel: string): boolean {
    const folder = path.join(main, rel);
    return (
        lstatOrUndefined(folder)?.isDirectory() === true &&
        lstatOrUndefined(path.join(folder, VENV_MARKER)) !== undefined
    );
}

// An ignored folder of any name that holds pyvenv.cfg is a Python environment, so it is a dependency folder too.
function entryClass(main: string, rel: string): EntryClass {
    const kind = classify(rel);
    return kind === 'link' && isVenvFolder(main, rel) ? 'dep' : kind;
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

// An own link may stand where a copy belongs: the transfer replaces it with the real file.
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

// Dependency folders are left to the install stage, which installs them or clones or links them from the main clone.
async function syncEntry(run: SyncRun, rel: string, kind: EntryClass): Promise<void> {
    if (kind === 'skip' || kind === 'dep' || !parentInside(run.worktree, rel) || !destinationOpen(run, rel, kind)) {
        return;
    }
    switch (kind) {
        case 'copy': {
            await run.transfer.copyEntry(rel);
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

function reportLinks(run: SyncRun): void {
    if (run.linked.length > 0) {
        run.deps.log.info(`linked ${run.linked.map((rel) => showText(rel)).join(', ')}`);
    }
}

// Copies get no pattern: they are ignored by the repository's own rules; links may not be. Dependency folders get
// theirs from the install stage.
function excludedPatterns(run: SyncRun, entries: readonly ClassifiedEntry[]): string[] {
    return entries
        .filter((entry) => entry.kind !== 'copy' && entry.kind !== 'dep' && isOwnLink(run, entry.rel))
        .map((entry) => anchoredPattern(entry.rel));
}

// Problems are warnings and never stop the run; nothing that already stands in the worktree is overwritten. Returns
// the dependency folders of the main clone for the install stage, or undefined when the listing fails.
export async function syncIgnored(
    deps: Deps,
    main: string,
    worktree: string,
    transfer: EntryTransfer
): Promise<string[] | undefined> {
    const listed = await listIgnored(deps, main);
    if (listed === undefined) {
        deps.log.warn(`cannot list the ignored files of ${showText(main)}; nothing synced into the worktree`);
        return undefined;
    }
    const entries = usableEntries(deps, listed).map((rel) => ({ rel, kind: entryClass(main, rel) }));
    const run: SyncRun = { deps, main, worktree, transfer, linked: [] };
    if (entries.some((entry) => entry.kind === 'copy' || entry.kind === 'dep')) {
        await addExcludePatterns(deps, worktree, [TEMP_PATTERN]);
    }
    for (const entry of entries) {
        await syncEntry(run, entry.rel, entry.kind);
    }
    reportLinks(run);
    await addExcludePatterns(deps, worktree, excludedPatterns(run, entries));
    return entries.filter((entry) => entry.kind === 'dep').map((entry) => entry.rel);
}
