import fs from 'node:fs';
import path from 'node:path';

import { EXCLUDE_HEADER, excludeFilePath, patternPath } from './exclude.ts';
import { errorCode, isAtOrAbove, isOwnLink } from './paths.ts';
import { failureLine, showText } from './text.ts';
import type { Deps, Env } from './types.ts';

export interface LegacyRequest {
    main: string;
    worktree: string;
    env: Env;
    keeps: (_rel: string) => boolean;
}

interface ExcludeLines {
    block: string[];
    user: string[];
}

type Step<T> = { ok: true; value: T } | { ok: false; reason: string };

const NAMED_PATHS = 3;
const CONFIG_KEY_MISSING = 1;

// The tool's block runs from each header line to the next line starting with #; every other pattern line is the user's.
function splitLines(text: string): ExcludeLines {
    const result: ExcludeLines = { block: [], user: [] };
    let inBlock = false;
    for (const line of text.split('\n')) {
        if (line.startsWith('#')) {
            inBlock = line === EXCLUDE_HEADER;
            continue;
        }
        if (line.trim().length > 0) {
            (inBlock ? result.block : result.user).push(line);
        }
    }
    return result;
}

interface BlockPath {
    rel: string;
    line: string;
}

function blockPaths(lines: ExcludeLines): BlockPath[] {
    const seen = new Set<string>();
    const result: BlockPath[] = [];
    for (const line of lines.block) {
        const rel = patternPath(line);
        if (rel !== undefined && !seen.has(rel)) {
            seen.add(rel);
            result.push({ rel, line });
        }
    }
    return result;
}

export function toolBlockPaths(text: string): string[] {
    return blockPaths(splitLines(text)).map((entry) => entry.rel);
}

function readExclude(file: string): Step<string> {
    try {
        return { ok: true, value: fs.readFileSync(file, 'utf8') };
    } catch (error) {
        return errorCode(error) === 'ENOENT'
            ? { ok: true, value: '' }
            : { ok: false, reason: `cannot read ${showText(file)}` };
    }
}

function defaultGlobalExcludes(env: Env): string | undefined {
    const xdg = env.XDG_CONFIG_HOME;
    if (xdg !== undefined && xdg.length > 0) {
        return path.join(xdg, 'git', 'ignore');
    }
    return env.HOME === undefined ? undefined : path.join(env.HOME, '.config', 'git', 'ignore');
}

// Mirrors git's own lookup: core.excludesFile (git resolves a relative value against the repository top level), else
// the XDG default; undefined when no file exists.
async function globalExcludes(deps: Deps, main: string, env: Env): Promise<Step<string | undefined>> {
    const result = await deps.runner.run({
        file: 'git',
        args: ['-C', main, 'config', '--path', '--get', 'core.excludesFile'],
    });
    if (result.code !== 0 && result.code !== CONFIG_KEY_MISSING) {
        return { ok: false, reason: failureLine(result) };
    }
    const [configured = ''] = result.stdout.split('\n', 1);
    let file = defaultGlobalExcludes(env);
    if (result.code === 0 && configured.length > 0) {
        file = path.resolve(main, configured);
    }
    return { ok: true, value: file !== undefined && fs.existsSync(file) ? file : undefined };
}

async function listHidden(
    deps: Deps,
    request: LegacyRequest,
    lines: ExcludeLines,
    paths: readonly BlockPath[]
): Promise<Step<string[]>> {
    const global = await globalExcludes(deps, request.main, request.env);
    if (!global.ok) {
        return global;
    }
    const result = await deps.runner.run({
        file: 'git',
        args: [
            '-C',
            request.main,
            'ls-files',
            '-z',
            '--others',
            '--directory',
            '--no-empty-directory',
            '--exclude-per-directory=.gitignore',
            ...(global.value === undefined ? [] : [`--exclude-from=${global.value}`]),
            ...lines.user.map((line) => `--exclude=${line}`),
            '--',
            ...paths.map((entry) => `:(literal)${entry.rel}`),
        ],
    });
    if (result.code !== 0) {
        return { ok: false, reason: failureLine(result) };
    }
    const entries = result.stdout.split('\0').filter((entry) => entry.length > 0);
    return { ok: true, value: entries.map((entry) => entry.replace(/\/$/u, '')) };
}

function shownExcludeFile(main: string, file: string): string {
    const relative = path.relative(main, file);
    const outside = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    return showText(outside ? file : relative);
}

function hidingWarning(shownFile: string, entry: BlockPath, hidden: readonly string[]): string {
    const count = hidden.length === 1 ? '1 file' : `${String(hidden.length)} files`;
    const named = hidden.slice(0, NAMED_PATHS).map((listed) => showText(listed));
    const names = hidden.length > NAMED_PATHS ? [...named, '...'] : named;
    return (
        `${shownFile} line ${showText(entry.line)} hides ${count} that .gitignore does not ignore (${names.join(', ')}); ` +
        `git status and git add skip ${hidden.length === 1 ? 'it' : 'them'}. Remove the worktree-add links at ${showText(entry.rel)} in every worktree first, ` +
        'then this line'
    );
}

// Read-only: warns for block lines that hide files from git and names own links outside the rules; removes nothing.
export async function checkLegacyExcludes(deps: Deps, request: LegacyRequest): Promise<void> {
    const fail = (reason: string): void => {
        deps.log.warn(`cannot check the worktree-add lines of the exclude file: ${reason}`);
    };
    const file = await excludeFilePath(deps, request.main);
    if (file === undefined) {
        fail('cannot find the info/exclude file of the repository');
        return;
    }
    const text = readExclude(file);
    if (!text.ok) {
        fail(text.reason);
        return;
    }
    const lines = splitLines(text.value);
    const paths = blockPaths(lines);
    if (paths.length === 0) {
        return;
    }
    const listed = await listHidden(deps, request, lines, paths);
    if (!listed.ok) {
        fail(listed.reason);
        return;
    }
    const shownFile = shownExcludeFile(request.main, file);
    for (const entry of paths) {
        const hidden = listed.value.filter((listedPath) => isAtOrAbove(entry.rel, listedPath));
        if (hidden.length > 0) {
            deps.log.warn(hidingWarning(shownFile, entry, hidden));
        }
    }
    const outside = paths.map((entry) => entry.rel).filter((rel) => isOwnLink(request, rel) && !request.keeps(rel));
    if (outside.length > 0) {
        deps.log.info(
            `this worktree has links to the main clone outside the current rules: ${outside.map((rel) => showText(rel)).join(', ')}`
        );
    }
}
