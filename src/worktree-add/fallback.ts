import fs from 'node:fs';
import path from 'node:path';

import { errorCode, isOwnLink, JS_DEPS, lstatOrUndefined, parentInside } from './paths.ts';
import { showText } from './text.ts';
import type { Deps, EntryTransfer } from './types.ts';

export type FallbackKind = 'cloned' | 'linked' | 'present' | 'failed';

export interface FallbackResult {
    rel: string;
    kind: FallbackKind;
}

interface FallbackRun {
    deps: Deps;
    main: string;
    worktree: string;
    transfer: EntryTransfer;
}

// An own link already standing counts as linked; a foreign entry that appears before the link is made is present.
function ensureLink(run: FallbackRun, rel: string): FallbackKind {
    const dest = path.join(run.worktree, rel);
    if (lstatOrUndefined(dest) !== undefined) {
        return isOwnLink(run, rel) ? 'linked' : 'present';
    }
    try {
        fs.symlinkSync(path.join(run.main, rel), dest);
        return 'linked';
    } catch (error) {
        const code = errorCode(error);
        if (code === 'EEXIST') {
            return isOwnLink(run, rel) ? 'linked' : 'present';
        }
        run.deps.log.warn(`cannot link ${showText(rel)} into the worktree: ${showText(code)}`);
        return 'failed';
    }
}

// The transfer replaces an own link standing at the destination with the clone and restores it when that fails.
async function cloneOrLink(run: FallbackRun, rel: string): Promise<FallbackKind> {
    const outcome = await run.transfer.cloneDependency(rel);
    if (outcome.kind === 'cloned') {
        return 'cloned';
    }
    const kind = ensureLink(run, rel);
    if (outcome.kind === 'failed') {
        const fallback = kind === 'linked' ? '; linked it instead' : '';
        run.deps.log.warn(`cannot clone ${showText(rel)} into the worktree (${showText(outcome.reason)})${fallback}`);
    }
    return kind;
}

function destinationOpen(run: FallbackRun, rel: string): boolean {
    return lstatOrUndefined(path.join(run.worktree, rel)) === undefined || isOwnLink(run, rel);
}

// Only node_modules is cloned: other dependency folders (a venv) keep the main clone's absolute paths when copied.
async function fallbackFor(run: FallbackRun, rel: string): Promise<FallbackKind> {
    if (!parentInside(run.worktree, rel) || !destinationOpen(run, rel)) {
        return 'present';
    }
    if (path.posix.basename(rel) === JS_DEPS) {
        return cloneOrLink(run, rel);
    }
    return ensureLink(run, rel);
}

// For dependency folders where no install was attempted; success lines are left to the caller.
export async function applyFallback(
    deps: Deps,
    paths: { main: string; worktree: string },
    transfer: EntryTransfer,
    rels: readonly string[]
): Promise<FallbackResult[]> {
    const run: FallbackRun = { deps, main: paths.main, worktree: paths.worktree, transfer };
    const results: FallbackResult[] = [];
    for (const rel of rels) {
        results.push({ rel, kind: await fallbackFor(run, rel) });
    }
    return results;
}
