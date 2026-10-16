import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { discoverProjects, matchesWorkspaceGlob } from '../../src/worktree-add/discover.ts';

import { testDeps } from './support/deps.ts';
import { commitFile, makeRepo, testEnv } from './support/git.ts';
import { tempRoot } from './support/tmp.ts';

await test('npm workspaces drop a member that has its own committed lock', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    commitFile(env, main, 'package.json', JSON.stringify({ workspaces: ['packages/*'] }));
    commitFile(env, main, 'package-lock.json', '{}\n');
    commitFile(env, main, 'packages/a/package-lock.json', '{}\n');
    assert.deepEqual(await discoverProjects(testDeps(env), main), [
        { dir: '', ecosystem: 'js', lockNames: ['package-lock.json'] },
    ]);
});

await test('an object workspaces field with a packages array also marks a workspace root', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    commitFile(env, main, 'package.json', JSON.stringify({ workspaces: { packages: ['./libs/**/'] } }));
    commitFile(env, main, 'yarn.lock', '\n');
    commitFile(env, main, 'libs/x/y/yarn.lock', '\n');
    assert.deepEqual(await discoverProjects(testDeps(env), main), [
        { dir: '', ecosystem: 'js', lockNames: ['yarn.lock'] },
    ]);
});

await test('pnpm, uv and unrelated projects are grouped and filtered by their workspaces', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    commitFile(
        env,
        main,
        'pnpm-workspace.yaml',
        'packages:\n  - \'apps/*\'\n  # comment\n  - "!apps/legacy"\nother: 1\n'
    );
    commitFile(env, main, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
    commitFile(env, main, 'apps/web/pnpm-lock.yaml', 'lockfileVersion: 9\n');
    commitFile(env, main, 'apps/legacy/package-lock.json', '{}\n');
    commitFile(env, main, 'apps/legacy/npm-shrinkwrap.json', '{}\n');
    commitFile(
        env,
        main,
        'pyproject.toml',
        '[project]\nname = "x"\n\n[tool.uv.workspace]\nmembers = [\n    "services/*", # all services\n]\nexclude = [\'services/old\']\n'
    );
    commitFile(env, main, 'uv.lock', 'version = 1\n');
    commitFile(env, main, 'services/api/uv.lock', 'version = 1\n');
    commitFile(env, main, 'services/old/uv.lock', 'version = 1\n');
    commitFile(env, main, 'examples/demo/bun.lock', '{}\n');
    assert.deepEqual(await discoverProjects(testDeps(env), main), [
        { dir: '', ecosystem: 'js', lockNames: ['pnpm-lock.yaml'] },
        { dir: '', ecosystem: 'uv', lockNames: ['uv.lock'] },
        { dir: 'apps/legacy', ecosystem: 'js', lockNames: ['npm-shrinkwrap.json', 'package-lock.json'] },
        { dir: 'examples/demo', ecosystem: 'js', lockNames: ['bun.lock'] },
        { dir: 'services/old', ecosystem: 'uv', lockNames: ['uv.lock'] },
    ]);
});

await test('an inline pnpm packages list is read', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    commitFile(env, main, 'tools/pnpm-workspace.yaml', 'packages: [ "pkg/*" ]\n');
    commitFile(env, main, 'tools/pnpm-lock.yaml', '\n');
    commitFile(env, main, 'tools/pkg/one/pnpm-lock.yaml', '\n');
    assert.deepEqual(await discoverProjects(testDeps(env), main), [
        { dir: 'tools', ecosystem: 'js', lockNames: ['pnpm-lock.yaml'] },
    ]);
});

await test('a uv member is not dropped by a js workspace and an invalid package.json is no workspace', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    commitFile(env, main, 'package.json', '{ not json');
    commitFile(env, main, 'package-lock.json', '{}\n');
    commitFile(env, main, 'packages/a/package-lock.json', '{}\n');
    commitFile(env, main, 'packages/a/uv.lock', '\n');
    assert.deepEqual(await discoverProjects(testDeps(env), main), [
        { dir: '', ecosystem: 'js', lockNames: ['package-lock.json'] },
        { dir: 'packages/a', ecosystem: 'js', lockNames: ['package-lock.json'] },
        { dir: 'packages/a', ecosystem: 'uv', lockNames: ['uv.lock'] },
    ]);
});

await test('a root with both package-lock.json and uv.lock gives two projects', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    commitFile(env, main, 'uv.lock', '\n');
    commitFile(env, main, 'package-lock.json', '{}\n');
    assert.deepEqual(await discoverProjects(testDeps(env), main), [
        { dir: '', ecosystem: 'js', lockNames: ['package-lock.json'] },
        { dir: '', ecosystem: 'uv', lockNames: ['uv.lock'] },
    ]);
});

await test('untracked locks and tracked locks under node_modules are ignored', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    commitFile(env, main, 'node_modules/pkg/package-lock.json', '{}\n');
    commitFile(env, main, 'a/node_modules/yarn.lock', '\n');
    fs.mkdirSync(path.join(main, 'loose'));
    fs.writeFileSync(path.join(main, 'loose', 'yarn.lock'), '\n');
    fs.writeFileSync(path.join(main, 'uv.lock'), '\n');
    assert.deepEqual(await discoverProjects(testDeps(env), main), []);
});

await test('a folder that is not a git checkout gives undefined', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    assert.equal(await discoverProjects(testDeps(env), plain), undefined);
});

await test('matchesWorkspaceGlob needs at least one segment for a trailing double star', () => {
    assert.equal(matchesWorkspaceGlob('packages/**', 'packages'), false);
    assert.equal(matchesWorkspaceGlob('packages/**', 'packages/a'), true);
    assert.equal(matchesWorkspaceGlob('packages/**', 'packages/a/b'), true);
    assert.equal(matchesWorkspaceGlob('**/x', 'x'), true);
    assert.equal(matchesWorkspaceGlob('a/**/x', 'a/x'), true);
});

await test('matchesWorkspaceGlob follows the single-segment, multi-segment and single-character rules', () => {
    assert.equal(matchesWorkspaceGlob('packages/*', 'packages/a'), true);
    assert.equal(matchesWorkspaceGlob('packages/*', 'packages/a/b'), false);
    assert.equal(matchesWorkspaceGlob('**/x', 'x'), true);
    assert.equal(matchesWorkspaceGlob('**/x', 'a/b/x'), true);
    assert.equal(matchesWorkspaceGlob('**/x', 'a/b/y'), false);
    assert.equal(matchesWorkspaceGlob('pkg-?', 'pkg-1'), true);
    assert.equal(matchesWorkspaceGlob('pkg-?', 'pkg-12'), false);
    assert.equal(matchesWorkspaceGlob('./apps/web/', 'apps/web'), true);
    assert.equal(matchesWorkspaceGlob('a/**', 'a/b/c'), true);
    assert.equal(matchesWorkspaceGlob('a.b', 'axb'), false);
});
