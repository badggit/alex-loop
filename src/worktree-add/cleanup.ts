import fs from 'node:fs';
import path from 'node:path';

import { errorCode, JS_DEPS, lstatOrUndefined, parentInside, UV_VENV } from './paths.ts';
import { failureLine, showText } from './text.ts';
import type { Deps } from './types.ts';

export type RemoveResult = { ok: true } | { ok: false; reason: string };

// Empty leftovers on a failure mean the listing itself failed and nothing was removed.
export type RemoveNewResult = { ok: true } | { ok: false; leftovers: string[]; reason: string };

type ListResult = { ok: true; entries: ReadonlySet<string> } | { ok: false; reason: string };

// A trailing separator on a link to a folder makes fs act on the link target, so it never reaches fs.
function withoutTrailingSeparators(file: string): string {
    let result = file;
    while (result.length > 1 && (result.endsWith('/') || result.endsWith(path.sep))) {
        result = result.slice(0, -1);
    }
    return result;
}

// Empty folders are listed too, so one that stood before is told apart from one the install left behind.
async function listUntracked(deps: Deps, dir: string): Promise<ListResult> {
    const listed = await deps.runner.run({
        file: 'git',
        args: ['-C', dir, 'ls-files', '-z', '--others', '--directory'],
    });
    if (listed.code !== 0) {
        return { ok: false, reason: failureLine(listed) };
    }
    const entries = listed.stdout
        .split('\0')
        .map((entry) => withoutTrailingSeparators(entry))
        .filter((entry) => entry.length > 0);
    return { ok: true, entries: new Set(entries) };
}

// Untracked and ignored entries alike, relative to DIR and without a trailing slash; undefined when git fails.
export async function untrackedEntries(deps: Deps, dir: string): Promise<ReadonlySet<string> | undefined> {
    const listed = await listUntracked(deps, dir);
    return listed.ok ? listed.entries : undefined;
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

// Folder names a package manager installs into, at any depth of the project (workspaces nest node_modules).
const TARGET_NAMES: ReadonlySet<string> = new Set([JS_DEPS, UV_VENV]);
const YARN_FOLDER = '.yarn';
const YARN_ARTIFACTS: readonly string[] = ['.yarn/install-state.gz', '.yarn/unplugged', '.yarn/cache'];
// Paths relative to the project root that only a package manager writes during an install.
const ROOT_ARTIFACTS: ReadonlySet<string> = new Set([
    '.pnp.cjs',
    '.pnp.loader.mjs',
    '.pnp.data.json',
    ...YARN_ARTIFACTS,
]);

function isManagerArtifact(rel: string): boolean {
    const name = rel.split('/').at(-1) ?? '';
    return TARGET_NAMES.has(name) || ROOT_ARTIFACTS.has(rel);
}

// A .yarn folder that is new as a whole is listed as one entry; only the yarn artifacts inside it go, and the
// folder itself only when nothing else is left in it. A .yarn that is not a real folder is left alone.
function removeNewYarnFolder(dir: string): RemoveResult {
    const full = path.join(dir, YARN_FOLDER);
    if (lstatOrUndefined(full)?.isDirectory() !== true) {
        return { ok: true };
    }
    for (const rel of YARN_ARTIFACTS) {
        const removed = removeSafely(dir, rel);
        if (!removed.ok) {
            return removed;
        }
    }
    try {
        if (fs.readdirSync(full).length === 0) {
            fs.rmdirSync(full);
        }
        return { ok: true };
    } catch (error) {
        return { ok: false, reason: `cannot remove ${showText(YARN_FOLDER)}: ${showText(errorCode(error))}` };
    }
}

function removeNewEntry(dir: string, rel: string): RemoveResult {
    if (rel === YARN_FOLDER) {
        return removeNewYarnFolder(dir);
    }
    return isManagerArtifact(rel) ? removeSafely(dir, rel) : { ok: true };
}

// Removes the package manager's own entries of DIR that are untracked now and were not in before; every other new
// entry may be the user's (written while the install ran) and is left in place. Continues past failures.
export async function removeNewEntries(deps: Deps, dir: string, before: ReadonlySet<string>): Promise<RemoveNewResult> {
    const now = await listUntracked(deps, dir);
    if (!now.ok) {
        return { ok: false, leftovers: [], reason: now.reason };
    }
    const leftovers: string[] = [];
    let firstReason: string | undefined;
    for (const rel of now.entries) {
        if (before.has(rel)) {
            continue;
        }
        const removed = removeNewEntry(dir, rel);
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

export function shellQuote(text: string): string {
    return `'${text.replaceAll("'", String.raw`'\''`)}'`;
}

export function removalCommand(paths: readonly string[]): string {
    const quoted = paths.map((file) => shellQuote(withoutTrailingSeparators(file)));
    return ['rm', '-rf', '--', ...quoted].join(' ');
}
