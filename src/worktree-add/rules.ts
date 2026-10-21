import path from 'node:path';

import { JS_DEPS, lstatOrUndefined } from './paths.ts';

export type EntryClass = 'copy' | 'dep' | 'skip' | 'link' | 'walk' | 'not-linked';

export interface EntryFacts {
    directory: boolean;
    venv: boolean;
    buildManifestBeside: boolean;
}

export const LINK_FOLDERS: ReadonlySet<string> = new Set([
    '.idea',
    '.vscode',
    '.claude',
    '.codex',
    '.cursor',
    '.gemini',
    '.zed',
]);

const COPY_NAMES: ReadonlySet<string> = new Set([
    '.env',
    'CLAUDE.local.md',
    'temp.local',
    '.npmrc',
    '.yarnrc',
    '.yarnrc.yml',
    'bunfig.toml',
    'uv.toml',
    'poetry.toml',
    '.python-version',
    '.nvmrc',
    '.node-version',
    '.tool-versions',
    '.envrc',
]);
const COPY_PREFIX = '.env.';

const SKIP_NAMES: ReadonlySet<string> = new Set([
    '.cache',
    '.eslintcache',
    '.next',
    '.turbo',
    'build',
    'coverage',
    'dist',
    'out',
    '__pycache__',
    '.pytest_cache',
    '.mypy_cache',
    '.ruff_cache',
    '.hypothesis',
    'htmlcov',
    '.coverage',
    'coverage.xml',
    '.tox',
    '.nox',
    '.eggs',
    '.ipynb_checkpoints',
    '.pytype',
    '.pyre',
    '.DS_Store',
    'Thumbs.db',
    '.terraform',
    '.terragrunt-cache',
    '.vercel',
    '.netlify',
    '.serverless',
    '.aws-sam',
    '.direnv',
    '.dart_tool',
    '.angular',
    '.nx',
    '.astro',
    '.docusaurus',
    '.expo',
    '.wrangler',
    '.svelte-kit',
    '.nuxt',
    '.parcel-cache',
    '.vite',
    '.gradle',
]);
const SKIP_SUFFIXES: readonly string[] = [
    '.tsbuildinfo',
    '.egg-info',
    '.pyc',
    '.pyo',
    '.swp',
    '.swo',
    '.orig',
    '.rej',
    '.log',
    '~',
];
const SKIP_PREFIXES: readonly string[] = ['.coverage.'];
const BUILD_OUTPUT = 'target';
const BUILD_MANIFESTS: readonly string[] = ['Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts'];

const NESTED_LINK_SUFFIX = '.claude/settings.local.json';
const TOP_LINK_NAMES: ReadonlySet<string> = new Set(['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']);
const LOCAL_MARK = '.local';

// Python environments (venv, .venv or any other name) are told by their pyvenv.cfg, never by name alone.
const VENV_MARKER = 'pyvenv.cfg';

function isCopyName(name: string): boolean {
    return COPY_NAMES.has(name) || name.startsWith(COPY_PREFIX);
}

function isSkipName(name: string, facts: EntryFacts): boolean {
    if (name === BUILD_OUTPUT) {
        return facts.buildManifestBeside;
    }
    return (
        SKIP_NAMES.has(name) ||
        SKIP_SUFFIXES.some((suffix) => name.endsWith(suffix)) ||
        SKIP_PREFIXES.some((prefix) => name.startsWith(prefix))
    );
}

// STEM.local or STEM.local.EXT with a non-empty STEM; a bare .local is not a local name.
function isLocalName(name: string): boolean {
    return name.endsWith(LOCAL_MARK) ? name.length > LOCAL_MARK.length : name.indexOf(`${LOCAL_MARK}.`) > 0;
}

function isTopLinkName(name: string): boolean {
    return TOP_LINK_NAMES.has(name) || isLocalName(name);
}

function isNestedLink(rel: string): boolean {
    return rel === NESTED_LINK_SUFFIX || rel.endsWith(`/${NESTED_LINK_SUFFIX}`);
}

// First match wins: copy, dependency, skip, link (nested settings, allowlisted folder, top-level name), walk.
export function classifyEntry(rel: string, facts: EntryFacts): EntryClass {
    const name = path.posix.basename(rel);
    const components = rel.split('/');
    if (isCopyName(name)) {
        return 'copy';
    }
    if (name === JS_DEPS || facts.venv) {
        return 'dep';
    }
    if (isSkipName(name, facts)) {
        return 'skip';
    }
    if (isNestedLink(rel) || LINK_FOLDERS.has(components[0] ?? '')) {
        return 'link';
    }
    if (components.length === 1 && isTopLinkName(name)) {
        return 'link';
    }
    return facts.directory ? 'walk' : 'not-linked';
}

// Facts about REL in the main clone; symlinks are never followed, so a linked folder is not a directory.
export function entryFacts(main: string, rel: string): EntryFacts {
    const full = path.join(main, rel);
    const directory = lstatOrUndefined(full)?.isDirectory() === true;
    const venv = directory && lstatOrUndefined(path.join(full, VENV_MARKER)) !== undefined;
    // Only "target" consults the manifests, so other entries skip the extra lstat calls during a walk.
    const beside = path.dirname(full);
    const buildManifestBeside =
        path.basename(rel) === 'target' &&
        BUILD_MANIFESTS.some((manifest) => lstatOrUndefined(path.join(beside, manifest)) !== undefined);
    return { directory, venv, buildManifestBeside };
}
