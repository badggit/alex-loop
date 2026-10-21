import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { classifyEntry, entryFacts, type EntryClass, type EntryFacts } from '../../src/worktree-add/rules.ts';

import { tempRoot } from './support/tmp.ts';

const FILE: EntryFacts = { directory: false, venv: false, buildManifestBeside: false };
const FOLDER: EntryFacts = { directory: true, venv: false, buildManifestBeside: false };

interface Case {
    rel: string;
    facts: EntryFacts;
    expected: EntryClass;
}

function cases(rels: readonly string[], facts: EntryFacts, expected: EntryClass): Case[] {
    return rels.map((rel) => ({ rel, facts, expected }));
}

function assertCases(list: readonly Case[]): void {
    for (const { rel, facts, expected } of list) {
        assert.equal(classifyEntry(rel, facts), expected, `${rel} ${JSON.stringify(facts)}`);
    }
}

const COPY_NAMES = [
    '.env',
    '.env.local',
    '.env.production',
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
];

await test('copy class matches at the top level and at any depth', () => {
    assertCases(cases(COPY_NAMES, FILE, 'copy'));
    assertCases(cases(['apps/api/.npmrc', 'packages/a/.python-version', 'apps/api/secrets/.env'], FILE, 'copy'));
    assertCases(
        cases(
            COPY_NAMES.map((name) => `deep/a/b/${name}`),
            FILE,
            'copy'
        )
    );
    // temp.local is a folder in practice; the copy class wins over the walk
    assertCases([{ rel: 'temp.local', facts: FOLDER, expected: 'copy' }]);
});

await test('dependency folders: node_modules by name, Python environments by pyvenv.cfg', () => {
    assertCases([
        { rel: 'node_modules', facts: FOLDER, expected: 'dep' },
        { rel: 'apps/web/node_modules', facts: FOLDER, expected: 'dep' },
        { rel: '.venv', facts: { ...FOLDER, venv: true }, expected: 'dep' },
        { rel: 'services/env-any-name', facts: { ...FOLDER, venv: true }, expected: 'dep' },
        // A venv-named folder without pyvenv.cfg is not a dependency
        { rel: 'venv', facts: FOLDER, expected: 'walk' },
    ]);
});

const SKIP_NAMES = [
    '.cache',
    '.eslintcache',
    '.next',
    '.turbo',
    'build',
    'coverage',
    'dist',
    'out',
    'x.tsbuildinfo',
    '__pycache__',
    '.pytest_cache',
    '.mypy_cache',
    '.ruff_cache',
    '.hypothesis',
    'htmlcov',
    '.coverage',
    '.coverage.1',
    'coverage.xml',
    '.tox',
    '.nox',
    '.eggs',
    '.ipynb_checkpoints',
    '.pytype',
    '.pyre',
    'x.egg-info',
    'a.pyc',
    'a.pyo',
    '.DS_Store',
    'Thumbs.db',
    'a.swp',
    'a.swo',
    'a~',
    'a.orig',
    'a.rej',
    'debug.log',
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
];

await test('skip names and patterns match at any depth, files and folders alike', () => {
    assertCases(cases(SKIP_NAMES, FILE, 'skip'));
    assertCases(cases(SKIP_NAMES, FOLDER, 'skip'));
    assertCases(cases(['src/app/__pycache__', 'src/pkg.egg-info', 'a/b/c/mod.pyc', 'x/.DS_Store'], FOLDER, 'skip'));
    // Skip names inside an allowlisted folder are still skipped
    assertCases([{ rel: '.idea/debug.log', facts: FILE, expected: 'skip' }]);
});

await test('allowlisted folders, nested Claude settings and top-level names are linked', () => {
    assertCases([
        { rel: '.idea/workspace.xml', facts: FILE, expected: 'link' },
        { rel: '.claude', facts: FOLDER, expected: 'link' },
        { rel: '.vscode/settings.json', facts: FILE, expected: 'link' },
        { rel: '.codex', facts: FOLDER, expected: 'link' },
        { rel: '.cursor/rules', facts: FOLDER, expected: 'link' },
        { rel: '.gemini', facts: FOLDER, expected: 'link' },
        { rel: '.zed', facts: FOLDER, expected: 'link' },
        { rel: '.claude/settings.local.json', facts: FILE, expected: 'link' },
        { rel: 'pkgs/a/.claude/settings.local.json', facts: FILE, expected: 'link' },
        { rel: 'AGENTS.md', facts: FILE, expected: 'link' },
        { rel: 'CLAUDE.md', facts: FILE, expected: 'link' },
        { rel: 'GEMINI.md', facts: FILE, expected: 'link' },
        { rel: 'docs.local', facts: FOLDER, expected: 'link' },
        { rel: 'config.local.yaml', facts: FILE, expected: 'link' },
    ]);
});

await test('nested or near-miss names are not linked', () => {
    assertCases([
        { rel: 'local.settings.json', facts: FILE, expected: 'not-linked' },
        { rel: 'config/c.local.yaml', facts: FILE, expected: 'not-linked' },
        { rel: 'src/AGENTS.md', facts: FILE, expected: 'not-linked' },
        { rel: 'pkgs/a/.claude/settings.json', facts: FILE, expected: 'not-linked' },
        { rel: 'src/.idea', facts: FILE, expected: 'not-linked' },
        { rel: 'backend/db.sqlite3', facts: FILE, expected: 'not-linked' },
    ]);
});

await test('folders that match no name rule are walked, top level included', () => {
    assertCases([
        { rel: 'data', facts: FOLDER, expected: 'walk' },
        { rel: 'config', facts: FOLDER, expected: 'walk' },
        { rel: '.local', facts: FOLDER, expected: 'walk' },
        { rel: 'src/oldpkg', facts: FOLDER, expected: 'walk' },
        { rel: 'src/.idea', facts: FOLDER, expected: 'walk' },
        { rel: 'src/oldpkg', facts: FILE, expected: 'not-linked' },
        { rel: '.local', facts: FILE, expected: 'not-linked' },
    ]);
});

await test('target is skipped only next to a build manifest', () => {
    assert.notEqual(classifyEntry('target', FOLDER), 'skip');
    assert.equal(classifyEntry('target', FOLDER), 'walk');
    assert.equal(classifyEntry('target', { ...FOLDER, buildManifestBeside: true }), 'skip');
    assert.equal(classifyEntry('crates/a/target', { ...FOLDER, buildManifestBeside: true }), 'skip');
});

await test('the copy class beats the allowlist and the top-level link names', () => {
    assert.equal(classifyEntry('.idea/.env.local', FILE), 'copy');
    assert.equal(classifyEntry('.claude/.npmrc', FILE), 'copy');
    assert.equal(classifyEntry('CLAUDE.local.md', FILE), 'copy');
});

await test('entryFacts: a missing path gives all three facts false', (t) => {
    const main = tempRoot(t);
    assert.deepEqual(entryFacts(main, 'missing/target'), FILE);
});

await test('entryFacts: a symlink to a folder is not a directory', (t) => {
    const main = tempRoot(t);
    fs.mkdirSync(path.join(main, 'real'));
    fs.writeFileSync(path.join(main, 'real', 'pyvenv.cfg'), '');
    fs.symlinkSync(path.join(main, 'real'), path.join(main, 'alias'));
    assert.deepEqual(entryFacts(main, 'alias'), FILE);
    assert.deepEqual(entryFacts(main, 'real'), { directory: true, venv: true, buildManifestBeside: false });
});

await test('entryFacts: a venv folder without pyvenv.cfg is not a Python environment', (t) => {
    const main = tempRoot(t);
    fs.mkdirSync(path.join(main, 'venv', 'bin'), { recursive: true });
    assert.deepEqual(entryFacts(main, 'venv'), FOLDER);
});

await test('entryFacts: a build manifest beside the entry is detected in the same folder only', (t) => {
    const main = tempRoot(t);
    fs.mkdirSync(path.join(main, 'target'));
    fs.writeFileSync(path.join(main, 'Cargo.toml'), '');
    assert.deepEqual(entryFacts(main, 'target'), { directory: true, venv: false, buildManifestBeside: true });
    for (const manifest of ['pom.xml', 'build.gradle', 'build.gradle.kts']) {
        const folder = path.join(main, 'mods', manifest);
        fs.mkdirSync(path.join(folder, 'target'), { recursive: true });
        fs.writeFileSync(path.join(folder, manifest), '');
        assert.equal(entryFacts(main, `mods/${manifest}/target`).buildManifestBeside, true, manifest);
    }
    fs.mkdirSync(path.join(main, 'other', 'target'), { recursive: true });
    assert.equal(entryFacts(main, 'other/target').buildManifestBeside, false);
    fs.mkdirSync(path.join(main, 'out-dir'));
    assert.equal(entryFacts(main, 'out-dir').buildManifestBeside, false);
});
