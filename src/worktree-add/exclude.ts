import fs from 'node:fs';
import path from 'node:path';

import { errorCode } from './paths.ts';
import { showText } from './text.ts';
import type { Deps } from './types.ts';

export const TEMP_PATTERN = '.alex-loop-tmp-*';
export const EXCLUDE_HEADER =
    '# alex-loop worktree-add: links, dependency clones and copy temps in worktrees, ignored in the main clone already';

const FAILURE_TAIL = '; the worktree links show as untracked and must be removed before git worktree remove';
const GLOB_CHARACTERS = /[*?[\\]/gu;
const ESCAPED_CHARACTER = /\\(.)/gu;

type ReadResult = { ok: true; text: string } | { ok: false };

// Matches exactly REL, links too (node_modules/ would not); glob characters and a trailing space are escaped.
export function anchoredPattern(rel: string): string {
    const escaped = rel.replaceAll(GLOB_CHARACTERS, String.raw`\$&`);
    return `/${escaped.endsWith(' ') ? `${escaped.slice(0, -1)}${String.raw`\ `}` : escaped}`;
}

// The inverse of anchoredPattern: REL for a line starting with /, undefined for comments, the temp pattern, blanks and
// a bare / (no path).
export function patternPath(line: string): string | undefined {
    if (!line.startsWith('/')) {
        return;
    }
    const rel = line.slice(1).replaceAll(ESCAPED_CHARACTER, '$1');
    return rel.length > 0 ? rel : undefined;
}

// A missing file reads as empty; any other read failure means the file cannot be updated safely.
function readExisting(file: string): ReadResult {
    try {
        return { ok: true, text: fs.readFileSync(file, 'utf8') };
    } catch (error) {
        return errorCode(error) === 'ENOENT' ? { ok: true, text: '' } : { ok: false };
    }
}

// From a linked worktree git answers the common file of the main clone; a relative answer is relative to WORKTREE.
export async function excludeFilePath(deps: Deps, worktree: string): Promise<string | undefined> {
    const resolved = await deps.runner.run({
        file: 'git',
        args: ['-C', worktree, 'rev-parse', '--git-path', 'info/exclude'],
    });
    const [line = ''] = resolved.stdout.split('\n', 1);
    if (resolved.code !== 0 || line.length === 0) {
        return;
    }
    return path.resolve(worktree, line);
}

function appendText(text: string, present: ReadonlySet<string>, missing: readonly string[]): string {
    const header = present.has(EXCLUDE_HEADER) ? [] : [EXCLUDE_HEADER];
    const lead = text.length > 0 && !text.endsWith('\n') ? '\n' : '';
    return `${lead}${[...header, ...missing].join('\n')}\n`;
}

// Append-only: patterns already present as whole lines (whoever wrote them) are skipped and nothing is rewritten.
export async function addExcludePatterns(deps: Deps, worktree: string, patterns: readonly string[]): Promise<void> {
    if (patterns.length === 0) {
        return;
    }
    const file = await excludeFilePath(deps, worktree);
    if (file === undefined) {
        deps.log.warn(`cannot find the info/exclude file of the repository${FAILURE_TAIL}`);
        return;
    }
    const existing = readExisting(file);
    if (!existing.ok) {
        deps.log.warn(`cannot update ${showText(file)}${FAILURE_TAIL}`);
        return;
    }
    const present = new Set(existing.text.split('\n'));
    const missing = [...new Set(patterns)].filter((pattern) => !present.has(pattern));
    if (missing.length === 0) {
        return;
    }
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, appendText(existing.text, present, missing));
    } catch {
        deps.log.warn(`cannot update ${showText(file)}${FAILURE_TAIL}`);
    }
}
