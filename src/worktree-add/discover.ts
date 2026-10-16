import fs from 'node:fs';
import path from 'node:path';

import type { Deps } from './types.ts';

export type Ecosystem = 'js' | 'uv';

// dir is relative to the worktree with forward slashes, '' for the worktree root.
export interface Project {
    dir: string;
    ecosystem: Ecosystem;
    lockNames: readonly string[];
}

interface WorkspaceSpec {
    include: readonly string[];
    exclude: readonly string[];
}

const LOCK_ECOSYSTEMS: ReadonlyMap<string, Ecosystem> = new Map([
    ['package-lock.json', 'js'],
    ['npm-shrinkwrap.json', 'js'],
    ['pnpm-lock.yaml', 'js'],
    ['yarn.lock', 'js'],
    ['bun.lock', 'js'],
    ['bun.lockb', 'js'],
    ['uv.lock', 'uv'],
]);

const UV_WORKSPACE_TABLE = 'tool.uv.workspace';

function patternSegments(pattern: string): string[] {
    let text = pattern.trim();
    while (text.startsWith('./')) {
        text = text.slice(2);
    }
    return text.split('/').filter((segment) => segment.length > 0 && segment !== '.');
}

function segmentMatches(pattern: string, segment: string): boolean {
    let source = '';
    for (const char of pattern) {
        if (char === '*') {
            source += '[^/]*';
        } else if (char === '?') {
            source += '[^/]';
        } else {
            source += /[$()+.[\\\]^{|}]/u.test(char) ? `\\${char}` : char;
        }
    }
    return new RegExp(`^${source}$`, 'u').test(segment);
}

function segmentsMatch(pattern: readonly string[], pi: number, rel: readonly string[], ri: number): boolean {
    const head = pattern[pi];
    if (head === undefined) {
        return ri === rel.length;
    }
    if (head === '**' && pi === pattern.length - 1) {
        // A trailing ** must match at least one segment, so 'packages/**' does not cover 'packages' itself.
        return ri < rel.length;
    }
    if (head === '**') {
        return segmentsMatch(pattern, pi + 1, rel, ri) || (ri < rel.length && segmentsMatch(pattern, pi, rel, ri + 1));
    }
    const segment = rel[ri];
    return segment !== undefined && segmentMatches(head, segment) && segmentsMatch(pattern, pi + 1, rel, ri + 1);
}

// Own matcher instead of path.matchesGlob, whose behavior differs across the supported Node versions.
export function matchesWorkspaceGlob(pattern: string, rel: string): boolean {
    return segmentsMatch(patternSegments(pattern), 0, patternSegments(rel), 0);
}

function readText(file: string): string | undefined {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringsOf(value: unknown): string[] | undefined {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
}

// Cuts a '#' comment that starts outside single or double quotes.
function withoutComment(line: string): string {
    let quote: string | undefined;
    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (quote !== undefined) {
            if (char === quote) {
                quote = undefined;
            }
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === '#' && (index === 0 || /\s/u.test(line[index - 1] ?? ''))) {
            return line.slice(0, index);
        }
    }
    return line;
}

function unquoted(text: string): string {
    const value = text.trim();
    const first = value[0];
    if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) {
        return value.slice(1, -1);
    }
    return value;
}

function flowItems(text: string): string[] {
    const inner = text.trim().replace(/^\[/u, '').replace(/\]$/u, '');
    return inner
        .split(',')
        .map((item) => unquoted(item))
        .filter((item) => item.length > 0);
}

// Minimal reader for the top-level packages list of pnpm-workspace.yaml, block or flow style.
function yamlPackages(text: string): string[] | undefined {
    const lines = text.split(/\r?\n/u);
    const start = lines.findIndex((line) => /^packages\s*:/u.test(line));
    if (start === -1) {
        return undefined;
    }
    const rest = withoutComment(lines[start] ?? '')
        .replace(/^packages\s*:/u, '')
        .trim();
    if (rest.startsWith('[')) {
        let flow = rest;
        for (let index = start + 1; !flow.includes(']') && index < lines.length; index += 1) {
            flow += ` ${withoutComment(lines[index] ?? '')}`;
        }
        return flowItems(flow);
    }
    if (rest.length > 0) {
        return undefined;
    }
    const items: string[] = [];
    for (const raw of lines.slice(start + 1)) {
        const line = withoutComment(raw);
        const trimmed = line.trim();
        if (trimmed.length === 0) {
            continue;
        }
        if (!trimmed.startsWith('-')) {
            break;
        }
        const item = unquoted(trimmed.slice(1));
        if (item.length > 0) {
            items.push(item);
        }
    }
    return items;
}

function quotedStrings(text: string): string[] {
    return [...text.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/gu)].map((match) => match[1] ?? match[2] ?? '');
}

// Minimal reader for string arrays under [tool.uv.workspace], single- or multi-line.
function tomlWorkspaceArrays(text: string): Map<string, string[]> {
    const arrays = new Map<string, string[]>();
    const lines = text.split(/\r?\n/u);
    let inTable = false;
    for (let index = 0; index < lines.length; index += 1) {
        const line = withoutComment(lines[index] ?? '');
        const header = /^\s*\[\[?([^\]]*)\]\]?\s*$/u.exec(line);
        if (header !== null) {
            inTable = (header[1] ?? '').replaceAll(/\s/gu, '') === UV_WORKSPACE_TABLE;
            continue;
        }
        const entry = /^\s*([\w-]+)\s*=\s*(\[.*)$/u.exec(line);
        if (!inTable || entry === null) {
            continue;
        }
        let value = entry[2] ?? '';
        while (!value.replaceAll(/"(?:[^"\\]|\\.)*"|'[^']*'/gu, '').includes(']') && index + 1 < lines.length) {
            index += 1;
            value += ` ${withoutComment(lines[index] ?? '')}`;
        }
        arrays.set(entry[1] ?? '', quotedStrings(value));
    }
    return arrays;
}

function packageJsonWorkspaces(file: string): string[] {
    const text = readText(file);
    if (text === undefined) {
        return [];
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return [];
    }
    if (!isRecord(parsed)) {
        return [];
    }
    const workspaces = parsed.workspaces;
    return stringsOf(workspaces) ?? (isRecord(workspaces) ? (stringsOf(workspaces.packages) ?? []) : []);
}

function jsWorkspace(dir: string): WorkspaceSpec | undefined {
    const yaml = readText(path.join(dir, 'pnpm-workspace.yaml'));
    const patterns = [
        ...packageJsonWorkspaces(path.join(dir, 'package.json')),
        ...((yaml === undefined ? undefined : yamlPackages(yaml)) ?? []),
    ];
    const include = patterns.filter((pattern) => !pattern.startsWith('!'));
    const exclude = patterns.filter((pattern) => pattern.startsWith('!')).map((pattern) => pattern.slice(1));
    return include.length > 0 ? { include, exclude } : undefined;
}

function uvWorkspace(dir: string): WorkspaceSpec | undefined {
    const text = readText(path.join(dir, 'pyproject.toml'));
    if (text === undefined) {
        return undefined;
    }
    const arrays = tomlWorkspaceArrays(text);
    const include = arrays.get('members') ?? [];
    return include.length > 0 ? { include, exclude: arrays.get('exclude') ?? [] } : undefined;
}

function workspaceOf(worktree: string, project: Project): WorkspaceSpec | undefined {
    const dir = path.join(worktree, project.dir);
    return project.ecosystem === 'js' ? jsWorkspace(dir) : uvWorkspace(dir);
}

function relativeBelow(ancestor: string, dir: string): string | undefined {
    if (ancestor === '') {
        return dir === '' ? undefined : dir;
    }
    return dir.startsWith(`${ancestor}/`) ? dir.slice(ancestor.length + 1) : undefined;
}

function isMember(spec: WorkspaceSpec, rel: string): boolean {
    return (
        spec.include.some((pattern) => matchesWorkspaceGlob(pattern, rel)) &&
        !spec.exclude.some((pattern) => matchesWorkspaceGlob(pattern, rel))
    );
}

function groupLocks(files: readonly string[]): Project[] {
    const groups = new Map<string, { dir: string; ecosystem: Ecosystem; lockNames: string[] }>();
    for (const file of files) {
        const ecosystem = LOCK_ECOSYSTEMS.get(path.posix.basename(file));
        if (ecosystem === undefined || file.split('/').includes('node_modules')) {
            continue;
        }
        const parent = path.posix.dirname(file);
        const dir = parent === '.' ? '' : parent;
        const key = `${ecosystem}\0${dir}`;
        const group = groups.get(key) ?? { dir, ecosystem, lockNames: [] };
        group.lockNames.push(path.posix.basename(file));
        groups.set(key, group);
    }
    return [...groups.values()].map((group) => ({ ...group, lockNames: group.lockNames.toSorted() }));
}

function compareProjects(a: Project, b: Project): number {
    if (a.dir !== b.dir) {
        return a.dir < b.dir ? -1 : 1;
    }
    if (a.ecosystem === b.ecosystem) {
        return 0;
    }
    return a.ecosystem < b.ecosystem ? -1 : 1;
}

// Projects are folders with tracked lock files; members of a workspace rooted in an ancestor folder are dropped.
export async function discoverProjects(deps: Deps, worktree: string): Promise<Project[] | undefined> {
    const result = await deps.runner.run({ file: 'git', args: ['-C', worktree, 'ls-files', '-z'] });
    if (result.code !== 0) {
        return undefined;
    }
    const projects = groupLocks(result.stdout.split('\0').filter((file) => file.length > 0));
    const roots = projects
        .map((project) => ({ project, spec: workspaceOf(worktree, project) }))
        .filter((root): root is { project: Project; spec: WorkspaceSpec } => root.spec !== undefined);
    const kept = projects.filter(
        (project) =>
            !roots.some((root) => {
                if (root.project.ecosystem !== project.ecosystem) {
                    return false;
                }
                const rel = relativeBelow(root.project.dir, project.dir);
                return rel !== undefined && isMember(root.spec, rel);
            })
    );
    return kept.toSorted(compareProjects);
}

// Whether FOLDER, relative to the worktree, is a member of the workspace rooted at PROJECT; files are read each call.
export function isWorkspaceMember(worktree: string, project: Project, folder: string): boolean {
    const spec = workspaceOf(worktree, project);
    const rel = relativeBelow(project.dir, folder);
    return spec !== undefined && rel !== undefined && isMember(spec, rel);
}
