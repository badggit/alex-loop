import fs from 'node:fs';
import path from 'node:path';

// The real path, or the input unchanged when it cannot be resolved.
export function canonical(file: string): string {
    try {
        return fs.realpathSync.native(file);
    } catch {
        return file;
    }
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
