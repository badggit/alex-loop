import fs from 'node:fs';
import path from 'node:path';

// Dependency folder names the managers install into: npm-family managers and uv.
export const JS_DEPS = 'node_modules';
export const UV_VENV = '.venv';

// The real path, or the input unchanged when it cannot be resolved.
export function canonical(file: string): string {
    try {
        return fs.realpathSync.native(file);
    } catch {
        return file;
    }
}

// The code of a Node system error (ENOENT, EEXIST, ...), or 'unknown' for anything else.
export function errorCode(error: unknown): string {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
        return error.code;
    }
    return 'unknown';
}

export function lstatOrUndefined(file: string): fs.Stats | undefined {
    try {
        return fs.lstatSync(file);
    } catch {
        return;
    }
}

function isDirectory(file: string): boolean {
    return lstatOrUndefined(file)?.isDirectory() === true;
}

// Walks the components left to right: existing ones resolve physically (symlinks followed), the missing rest is
// joined as text, and a ".." that climbs back into an existing folder continues from its physical path. So a path
// through a symlinked parent and its real spelling compare equal even when the final folder is missing.
export function canonicalLoose(file: string): string {
    const absolute = path.isAbsolute(file) ? file : `${process.cwd()}/${file}`;
    let current = '/';
    let exists = true;
    for (const part of absolute.split('/')) {
        if (part === '' || part === '.') {
            continue;
        }
        if (part === '..') {
            current = path.dirname(current);
            if (!exists && isDirectory(current)) {
                exists = true;
            }
            continue;
        }
        const next = path.join(current, part);
        if (exists) {
            try {
                current = fs.realpathSync.native(next);
                continue;
            } catch {
                exists = false;
            }
        }
        current = next;
    }
    return current;
}

// True only for a symlink whose readlink text is exactly text.
export function isLinkWithText(file: string, text: string): boolean {
    if (lstatOrUndefined(file)?.isSymbolicLink() !== true) {
        return false;
    }
    try {
        return fs.readlinkSync(file) === text;
    } catch {
        return false;
    }
}

// The link this tool makes for REL: a symlink in the worktree whose text is the same path in the main clone.
export function isOwnLink(paths: { main: string; worktree: string }, rel: string): boolean {
    return isLinkWithText(path.join(paths.worktree, rel), path.join(paths.main, rel));
}

export function realOrUndefined(file: string): string | undefined {
    try {
        return fs.realpathSync.native(file);
    } catch {
        return;
    }
}

// True when the entry at REL may be written: nothing stands there, or only the tool's own link.
export function missingOrOwnLink(paths: { main: string; worktree: string }, rel: string): boolean {
    return lstatOrUndefined(path.join(paths.worktree, rel)) === undefined || isOwnLink(paths, rel);
}

// Both relative with forward slashes, '' for the root.
export function isAtOrAbove(dir: string, folder: string): boolean {
    return dir === '' || folder === dir || folder.startsWith(`${dir}/`);
}

// A parent reached through a link (for example into the main clone) would put the entry outside root itself.
export function parentInside(root: string, rel: string): boolean {
    const realRoot = realOrUndefined(root);
    const parent = realOrUndefined(path.dirname(path.join(root, rel)));
    return realRoot !== undefined && parent === path.join(realRoot, path.dirname(rel));
}

// False when the folder that would hold REL is missing (or reached through a broken link), so REL cannot exist.
export function parentExists(root: string, rel: string): boolean {
    return realOrUndefined(path.dirname(path.join(root, rel))) !== undefined;
}
