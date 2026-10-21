import fs from 'node:fs';
import path from 'node:path';

import { errorCode, lstatOrUndefined } from './paths.ts';
import { showText } from './text.ts';

export type ParentResult =
    { ok: true } | { ok: false; blocker: string; cause: 'link' | 'not-a-folder' | 'mkdir-failed'; code: string };

export type ParentFailure = Exclude<ParentResult, { ok: true }>;

// The reason part of a blocked-parent warning; each caller puts its own prefix naming the path in front.
export function blockedReason(failure: ParentFailure): string {
    const blocker = showText(failure.blocker);
    if (failure.cause === 'mkdir-failed') {
        return `cannot create its folder ${blocker} in the worktree (${showText(failure.code)})`;
    }
    return `its folder ${blocker} in the worktree is a link or not a folder`;
}

function blockerFor(stat: fs.Stats, blocker: string): ParentResult | undefined {
    if (stat.isSymbolicLink()) {
        return { ok: false, blocker, cause: 'link', code: '' };
    }
    if (!stat.isDirectory()) {
        return { ok: false, blocker, cause: 'not-a-folder', code: '' };
    }
    return undefined;
}

// Creates one missing component; an EEXIST from a concurrent creator is accepted only when a real folder now stands there.
function createComponent(file: string, blocker: string): ParentResult | undefined {
    try {
        fs.mkdirSync(file);
        return undefined;
    } catch (error) {
        const code = errorCode(error);
        const stat = code === 'EEXIST' ? lstatOrUndefined(file) : undefined;
        if (stat === undefined) {
            return { ok: false, blocker, cause: 'mkdir-failed', code };
        }
        return blockerFor(stat, blocker);
    }
}

// Makes every folder above REL inside the worktree, one level at a time, never following or creating through a link.
export function ensureParents(worktree: string, rel: string): ParentResult {
    const parts = rel.split('/').slice(0, -1);
    let current = '';
    for (const part of parts) {
        current = current === '' ? part : `${current}/${part}`;
        const file = path.join(worktree, current);
        const stat = lstatOrUndefined(file);
        const failure = stat === undefined ? createComponent(file, current) : blockerFor(stat, current);
        if (failure !== undefined) {
            return failure;
        }
    }
    return { ok: true };
}
