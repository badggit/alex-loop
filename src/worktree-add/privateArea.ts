import fs from 'node:fs';
import path from 'node:path';

import { errorCode } from './paths.ts';
import type { Deps } from './types.ts';

export const PARTIAL_MARKER = 'alex-loop-partial-install';

const LOG_PREFIX = 'alex-loop-install';
const LOG_MODE = 0o600;
const UNSAFE_NAME_CHARACTER = /[^\w.-]/gu;

export type LogWriteResult = { ok: true; path: string } | { ok: false; reason: string };

// The worktree's own git folder (.git/worktrees/NAME for a linked worktree); undefined when git fails.
export async function privateDir(deps: Deps, worktree: string): Promise<string | undefined> {
    const result = await deps.runner.run({ file: 'git', args: ['-C', worktree, 'rev-parse', '--absolute-git-dir'] });
    const dir = result.stdout.trim();
    if (result.code !== 0 || dir.length === 0) {
        return;
    }
    return dir;
}

function nameSafe(text: string): string {
    return text.replaceAll('/', '-').replaceAll(UNSAFE_NAME_CHARACTER, '_');
}

// The root project (empty or ".") gets no slug.
export function logFileName(manager: string, projectDir: string): string {
    const trimmed = projectDir.replace(/\/+$/u, '');
    if (trimmed === '' || trimmed === '.') {
        return `${LOG_PREFIX}-${nameSafe(manager)}.log`;
    }
    return `${LOG_PREFIX}-${nameSafe(manager)}-${nameSafe(trimmed)}.log`;
}

// Overwrites in place with mode 0600 and narrows an existing wider mode; never writes through a link.
export function writeInstallLog(dir: string, fileName: string, text: string): LogWriteResult {
    const file = path.join(dir, fileName);
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | noFollow;
    let fd: number | undefined;
    try {
        fd = fs.openSync(file, flags, LOG_MODE);
        fs.fchmodSync(fd, LOG_MODE);
        fs.writeFileSync(fd, text);
        return { ok: true, path: file };
    } catch (error) {
        return { ok: false, reason: errorCode(error) };
    } finally {
        if (fd !== undefined) {
            fs.closeSync(fd);
        }
    }
}

// Undefined when the marker exists but cannot be read, so an update never drops marks it could not see.
function readMarks(dir: string): string[] | undefined {
    let text: string;
    try {
        text = fs.readFileSync(path.join(dir, PARTIAL_MARKER), 'utf8');
    } catch (error) {
        return errorCode(error) === 'ENOENT' ? [] : undefined;
    }
    return [...new Set(text.split('\n').filter((line) => line.length > 0))];
}

export function readPartialMarks(dir: string): string[] {
    return readMarks(dir) ?? [];
}

// An empty set removes the marker file, so its presence always means at least one partial install.
function writePartialMarks(dir: string, rels: readonly string[]): boolean {
    const file = path.join(dir, PARTIAL_MARKER);
    try {
        if (rels.length === 0) {
            fs.rmSync(file, { force: true });
        } else {
            fs.writeFileSync(file, `${rels.join('\n')}\n`);
        }
        return true;
    } catch {
        return false;
    }
}

export function addPartialMarks(dir: string, rels: readonly string[]): boolean {
    const marks = readMarks(dir);
    if (marks === undefined) {
        return false;
    }
    return writePartialMarks(dir, [...new Set([...marks, ...rels])]);
}

export function clearPartialMarks(dir: string, rels: readonly string[]): boolean {
    const marks = readMarks(dir);
    if (marks === undefined) {
        return false;
    }
    const cleared = new Set(rels);
    return writePartialMarks(
        dir,
        marks.filter((rel) => !cleared.has(rel))
    );
}
