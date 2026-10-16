import fs from 'node:fs';
import path from 'node:path';

import { lstatOrUndefined, parentInside } from './paths.ts';
import { showText } from './text.ts';
import type { Deps } from './types.ts';

export type RemoveResult = { ok: true } | { ok: false; reason: string };

export type RemoveNewResult = { ok: true } | { ok: false; leftovers: string[]; reason: string };

function errorCode(error: unknown): string {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
        return error.code;
    }
    return 'unknown';
}

// A trailing separator on a link to a folder makes fs act on the link target, so it never reaches fs.
function withoutTrailingSeparators(file: string): string {
    let result = file;
    while (result.length > 1 && (result.endsWith('/') || result.endsWith(path.sep))) {
        result = result.slice(0, -1);
    }
    return result;
}

// Untracked and ignored entries alike, relative to DIR and without a trailing slash; undefined when git fails.
export async function untrackedEntries(deps: Deps, dir: string): Promise<ReadonlySet<string> | undefined> {
    const listed = await deps.runner.run({
        file: 'git',
        args: ['-C', dir, 'ls-files', '-z', '--others', '--directory', '--no-empty-directory'],
    });
    if (listed.code !== 0) {
        return;
    }
    const entries = listed.stdout
        .split('\0')
        .map((entry) => withoutTrailingSeparators(entry))
        .filter((entry) => entry.length > 0);
    return new Set(entries);
}

function refusal(rel: string): string | undefined {
    if (rel.length === 0) {
        return 'refused an empty path';
    }
    if (path.isAbsolute(rel)) {
        return `refused an absolute path: ${showText(rel)}`;
    }
    if (rel.split(/[/\\]/u).includes('..')) {
        return `refused a path with "..": ${showText(rel)}`;
    }
    return;
}

// Never follows a link: a link is unlinked, and a parent reached through a link (into the main clone) is refused.
export function removeSafely(root: string, rel: string): RemoveResult {
    const clean = withoutTrailingSeparators(rel);
    const refused = refusal(clean);
    if (refused !== undefined) {
        return { ok: false, reason: refused };
    }
    if (!parentInside(root, clean)) {
        return { ok: false, reason: `refused a path whose parent is not inside ${showText(root)}: ${showText(clean)}` };
    }
    const full = path.join(root, clean);
    const stats = lstatOrUndefined(full);
    if (stats === undefined) {
        return { ok: true };
    }
    try {
        if (stats.isDirectory()) {
            fs.rmSync(full, { recursive: true, force: true });
        } else {
            fs.unlinkSync(full);
        }
        return { ok: true };
    } catch (error) {
        return { ok: false, reason: `cannot remove ${showText(clean)}: ${showText(errorCode(error))}` };
    }
}

// Removes every entry of DIR that is untracked now and was not in before; continues past failures.
export async function removeNewEntries(deps: Deps, dir: string, before: ReadonlySet<string>): Promise<RemoveNewResult> {
    const now = await untrackedEntries(deps, dir);
    if (now === undefined) {
        return { ok: false, leftovers: [], reason: `cannot list the untracked entries of ${showText(dir)}` };
    }
    const leftovers: string[] = [];
    let firstReason: string | undefined;
    for (const rel of now) {
        if (before.has(rel)) {
            continue;
        }
        const removed = removeSafely(dir, rel);
        if (!removed.ok) {
            leftovers.push(rel);
            firstReason ??= removed.reason;
        }
    }
    if (firstReason === undefined) {
        return { ok: true };
    }
    return { ok: false, leftovers, reason: firstReason };
}

function shellQuote(text: string): string {
    return `'${text.replaceAll("'", String.raw`'\''`)}'`;
}

export function removalCommand(paths: readonly string[]): string {
    const quoted = paths.map((file) => shellQuote(withoutTrailingSeparators(file)));
    return ['rm', '-rf', '--', ...quoted].join(' ');
}
