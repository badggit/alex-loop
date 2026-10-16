import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { revertConfigChanges, snapshotSharedConfig, type ConfigSnapshot } from '../../src/worktree-add/configGuard.ts';
import type { Deps, Env } from '../../src/worktree-add/types.ts';

import { testDeps } from './support/deps.ts';
import { commitFile, gitSync, makeRepo, testEnv } from './support/git.ts';
import { withOverride } from './support/runners.ts';
import { tempRoot } from './support/tmp.ts';
import { realToolPath } from './support/tools.ts';

interface Fixture {
    root: string;
    env: Env;
    main: string;
    worktree: string;
    deps: Deps & { lines: string[] };
}

function makeFixture(t: TestContext): Fixture {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    const worktree = path.join(root, 'app-task');
    gitSync(env, ['-C', main, 'worktree', 'add', '--quiet', '-b', 'task', worktree]);
    return { root, env, main, worktree, deps: testDeps(env) };
}

function definedEnv(env: Env): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) {
        if (value !== undefined) {
            result[name] = value;
        }
    }
    return result;
}

function sharedValues(fixture: Fixture, key: string): string[] {
    const result = spawnSync('git', ['-C', fixture.main, 'config', '--local', '--get-all', key], {
        env: definedEnv(fixture.env),
        encoding: 'utf8',
    });
    return result.stdout.split('\n').filter((line) => line.length > 0);
}

function warnings(fixture: Fixture): string[] {
    return fixture.deps.lines.filter((line) => line.includes(' warn '));
}

async function snapshotOf(fixture: Fixture): Promise<ConfigSnapshot> {
    const snapshot = await snapshotSharedConfig(fixture.deps, fixture.worktree);
    assert.ok(snapshot !== undefined);
    return snapshot;
}

function hasNpm(): boolean {
    try {
        realToolPath('npm', process.env);
        return true;
    } catch {
        return false;
    }
}

await test('the snapshot names the config file in the common git folder', async (t) => {
    const fixture = makeFixture(t);
    const snapshot = await snapshotOf(fixture);
    assert.equal(fs.realpathSync.native(snapshot.file), path.join(fixture.main, '.git', 'config'));
    assert.deepEqual(snapshot.entries.get('remote.origin.url'), [path.join(fixture.root, 'origin.git')]);
});

await test('a key changed inside the linked worktree is restored with one warning naming both values', async (t) => {
    const fixture = makeFixture(t);
    gitSync(fixture.env, ['-C', fixture.main, 'config', 'core.hooksPath', '.githooks']);
    const snapshot = await snapshotOf(fixture);
    gitSync(fixture.env, ['config', 'core.hooksPath', '.husky/_'], fixture.worktree);
    assert.deepEqual(sharedValues(fixture, 'core.hooksPath'), ['.husky/_']);
    const reverted = await revertConfigChanges(fixture.deps, fixture.env, snapshot);
    assert.deepEqual(reverted, ['core.hookspath']);
    assert.deepEqual(sharedValues(fixture, 'core.hooksPath'), ['.githooks']);
    const warned = warnings(fixture);
    assert.equal(warned.length, 1);
    assert.match(
        warned[0] ?? '',
        /reverted core\.hookspath in the shared repository config: an install changed it from \.githooks to \.husky\/_; set it by hand if the branch needs it$/u
    );
});

await test('an added key is removed and a removed key is restored', async (t) => {
    const fixture = makeFixture(t);
    gitSync(fixture.env, ['-C', fixture.main, 'config', 'app.keep', 'yes']);
    const snapshot = await snapshotOf(fixture);
    gitSync(fixture.env, ['config', 'app.added', 'new'], fixture.worktree);
    gitSync(fixture.env, ['config', '--unset', 'app.keep'], fixture.worktree);
    const reverted = await revertConfigChanges(fixture.deps, fixture.env, snapshot);
    assert.deepEqual(reverted.toSorted(), ['app.added', 'app.keep']);
    assert.deepEqual(sharedValues(fixture, 'app.added'), []);
    assert.deepEqual(sharedValues(fixture, 'app.keep'), ['yes']);
    const warned = warnings(fixture).join('\n');
    assert.match(warned, /reverted app\.added .* from \(unset\) to new;/u);
    assert.match(warned, /reverted app\.keep .* from yes to \(unset\);/u);
});

await test('a multi-valued key gets both values back', async (t) => {
    const fixture = makeFixture(t);
    const first = 'https://mirror-one.example.test/';
    const second = 'https://mirror-two.example.test/';
    const key = 'url.https://registry.example.test/.insteadof';
    gitSync(fixture.env, ['-C', fixture.main, 'config', '--add', key, first]);
    gitSync(fixture.env, ['-C', fixture.main, 'config', '--add', key, second]);
    const snapshot = await snapshotOf(fixture);
    gitSync(fixture.env, ['config', '--unset-all', key], fixture.worktree);
    gitSync(fixture.env, ['config', key, 'other'], fixture.worktree);
    const reverted = await revertConfigChanges(fixture.deps, fixture.env, snapshot);
    assert.deepEqual(reverted, [key]);
    assert.deepEqual(sharedValues(fixture, key), [first, second]);
    assert.ok(warnings(fixture)[0]?.includes(`from ${first}, ${second} to other;`), warnings(fixture)[0]);
});

await test('branch and remote keys set during the install stay while other changes are reverted', async (t) => {
    const fixture = makeFixture(t);
    const snapshot = await snapshotOf(fixture);
    const fetch = sharedValues(fixture, 'remote.origin.fetch');
    gitSync(fixture.env, ['config', 'branch.x.merge', 'refs/heads/x'], fixture.worktree);
    gitSync(fixture.env, ['config', 'Branch.Other.remote', 'origin'], fixture.worktree);
    gitSync(fixture.env, ['config', '--add', 'REMOTE.origin.fetch', '+refs/tags/*:refs/tags/*'], fixture.worktree);
    gitSync(fixture.env, ['config', 'core.hooksPath', '.husky/_'], fixture.worktree);
    const reverted = await revertConfigChanges(fixture.deps, fixture.env, snapshot);
    assert.deepEqual(reverted, ['core.hookspath']);
    assert.deepEqual(sharedValues(fixture, 'core.hooksPath'), []);
    assert.deepEqual(sharedValues(fixture, 'branch.x.merge'), ['refs/heads/x']);
    assert.deepEqual(sharedValues(fixture, 'branch.Other.remote'), ['origin']);
    assert.deepEqual(sharedValues(fixture, 'remote.origin.fetch'), [...fetch, '+refs/tags/*:refs/tags/*']);
    const warned = warnings(fixture);
    assert.equal(warned.length, 1);
    assert.match(warned[0] ?? '', /reverted core\.hookspath /u);
});

await test('no change gives no warning and an empty list', async (t) => {
    const fixture = makeFixture(t);
    const snapshot = await snapshotOf(fixture);
    assert.deepEqual(await revertConfigChanges(fixture.deps, fixture.env, snapshot), []);
    assert.deepEqual(warnings(fixture), []);
});

await test('a valueless key reads as true', async (t) => {
    const fixture = makeFixture(t);
    fs.appendFileSync(path.join(fixture.main, '.git', 'config'), '[app]\n\tflag\n');
    const snapshot = await snapshotOf(fixture);
    assert.deepEqual(snapshot.entries.get('app.flag'), ['true']);
});

await test('a credential in a value is masked in the warning', async (t) => {
    const fixture = makeFixture(t);
    const snapshot = await snapshotOf(fixture);
    gitSync(fixture.env, ['config', 'app.mirror', 'https://user:secret@host/repo.git'], fixture.worktree);
    await revertConfigChanges(fixture.deps, fixture.env, snapshot);
    const warned = warnings(fixture).join('\n');
    assert.ok(warned.includes('https://user:***@host/repo.git'), warned);
    assert.ok(!warned.includes('secret'), warned);
});

await test('a failed revert is its own warning and the key is not listed', async (t) => {
    const fixture = makeFixture(t);
    gitSync(fixture.env, ['-C', fixture.main, 'config', 'app.keep', 'yes']);
    const snapshot = await snapshotOf(fixture);
    gitSync(fixture.env, ['config', 'app.keep', 'changed'], fixture.worktree);
    const failingAdd = withOverride(fixture.deps.runner, (request) => request.args.includes('--add'), {
        code: 1,
        stdout: '',
        stderr: 'error: could not lock config file\n',
    });
    const deps = { ...fixture.deps, runner: failingAdd };
    assert.deepEqual(await revertConfigChanges(deps, fixture.env, snapshot), []);
    const warned = warnings(fixture);
    assert.equal(warned.length, 1);
    assert.ok(
        warned[0]?.endsWith(
            `cannot revert app.keep in ${snapshot.file}: error: could not lock config file; it stays (unset)`
        ),
        warned[0]
    );
    assert.deepEqual(sharedValues(fixture, 'app.keep'), []);
});

await test('a failed unset leaves the key as the install set it and the warning says so', async (t) => {
    const fixture = makeFixture(t);
    gitSync(fixture.env, ['-C', fixture.main, 'config', 'app.keep', 'yes']);
    const snapshot = await snapshotOf(fixture);
    gitSync(fixture.env, ['config', 'app.keep', 'changed'], fixture.worktree);
    const failingUnset = withOverride(fixture.deps.runner, (request) => request.args.includes('--unset-all'), {
        code: 1,
        stdout: '',
        stderr: 'error: could not lock config file\n',
    });
    const deps = { ...fixture.deps, runner: failingUnset };
    assert.deepEqual(await revertConfigChanges(deps, fixture.env, snapshot), []);
    const warned = warnings(fixture);
    assert.equal(warned.length, 1);
    assert.ok(warned[0]?.endsWith('error: could not lock config file; it stays changed'), warned[0]);
});

await test('a revert that fails halfway shows the values the file holds now', async (t) => {
    const fixture = makeFixture(t);
    gitSync(fixture.env, ['-C', fixture.main, 'config', '--add', 'app.multi', 'first']);
    gitSync(fixture.env, ['-C', fixture.main, 'config', '--add', 'app.multi', 'second']);
    const snapshot = await snapshotOf(fixture);
    gitSync(fixture.env, ['config', '--unset-all', 'app.multi'], fixture.worktree);
    gitSync(fixture.env, ['config', 'app.multi', 'changed'], fixture.worktree);
    const failingSecond = withOverride(
        fixture.deps.runner,
        (request) => request.args.includes('--add') && request.args.includes('second'),
        { code: 1, stdout: '', stderr: 'error: could not lock config file\n' }
    );
    const deps = { ...fixture.deps, runner: failingSecond };
    assert.deepEqual(await revertConfigChanges(deps, fixture.env, snapshot), []);
    assert.deepEqual(sharedValues(fixture, 'app.multi'), ['first']);
    const warned = warnings(fixture);
    assert.equal(warned.length, 1);
    assert.ok(warned[0]?.endsWith('error: could not lock config file; it stays first'), warned[0]);
});

await test('the values of a sensitive key are hidden in the warning', async (t) => {
    const fixture = makeFixture(t);
    const key = 'http.https://example.invalid/.extraheader';
    gitSync(fixture.env, ['-C', fixture.main, 'config', key, 'AUTHORIZATION: bearer oldsecretvalue']);
    const snapshot = await snapshotOf(fixture);
    gitSync(fixture.env, ['config', key, 'AUTHORIZATION: bearer abc123secretvalue'], fixture.worktree);
    assert.deepEqual(await revertConfigChanges(fixture.deps, fixture.env, snapshot), [key]);
    assert.deepEqual(sharedValues(fixture, key), ['AUTHORIZATION: bearer oldsecretvalue']);
    const warned = warnings(fixture);
    assert.equal(warned.length, 1);
    assert.ok(warned[0]?.includes(`reverted ${key} in the shared repository config`), warned[0]);
    assert.ok(warned[0]?.includes('from *** to ***;'), warned[0]);
    for (const line of fixture.deps.lines) {
        assert.ok(!line.includes('abc123secretvalue'), line);
        assert.ok(!line.includes('oldsecretvalue'), line);
    }
});

await test('a failed revert of a sensitive key hides the values it keeps', async (t) => {
    const fixture = makeFixture(t);
    const key = 'http.https://example.invalid/.extraheader';
    const snapshot = await snapshotOf(fixture);
    gitSync(fixture.env, ['config', key, 'AUTHORIZATION: bearer abc123secretvalue'], fixture.worktree);
    const failingUnset = withOverride(fixture.deps.runner, (request) => request.args.includes('--unset-all'), {
        code: 1,
        stdout: '',
        stderr: 'error: could not lock config file\n',
    });
    const deps = { ...fixture.deps, runner: failingUnset };
    assert.deepEqual(await revertConfigChanges(deps, fixture.env, snapshot), []);
    const warned = warnings(fixture);
    assert.equal(warned.length, 1);
    assert.ok(warned[0]?.endsWith('; it stays ***'), warned[0]);
    for (const line of fixture.deps.lines) {
        assert.ok(!line.includes('abc123secretvalue'), line);
    }
});

await test('a config that cannot be read after the install gives one warning and an empty list', async (t) => {
    const fixture = makeFixture(t);
    const snapshot = await snapshotOf(fixture);
    const broken: ConfigSnapshot = { file: path.join(fixture.root, 'missing', 'config'), entries: snapshot.entries };
    assert.deepEqual(await revertConfigChanges(fixture.deps, fixture.env, broken), []);
    const warned = warnings(fixture);
    assert.equal(warned.length, 1);
    assert.match(warned[0] ?? '', /cannot check the shared repository config /u);
});

await test('a folder that is not a git checkout gives undefined', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    assert.equal(await snapshotSharedConfig(testDeps(env), plain), undefined);
});

await test('a real npm prepare script that sets core.hooksPath is reverted', async (t) => {
    if (!hasNpm()) {
        t.skip('npm is not installed');
        return;
    }
    const root = tempRoot(t);
    const env: Env = { ...testEnv(root), npm_config_cache: path.join(root, 'npm-cache'), npm_config_audit: 'false' };
    const { main } = makeRepo(root, env);
    const manifest = {
        name: 'app',
        version: '1.0.0',
        private: true,
        scripts: { prepare: 'git config core.hooksPath .husky/_' },
    };
    fs.writeFileSync(path.join(main, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`);
    const locked = spawnSync('npm', ['install', '--package-lock-only', '--offline', '--ignore-scripts'], {
        cwd: main,
        env: definedEnv(env),
        encoding: 'utf8',
    });
    assert.equal(locked.status, 0, locked.stderr);
    gitSync(env, ['-C', main, 'add', 'package.json', 'package-lock.json']);
    commitFile(env, main, 'notes.txt', 'notes\n');
    const worktree = path.join(root, 'app-task');
    gitSync(env, ['-C', main, 'worktree', 'add', '--quiet', '-b', 'task', worktree]);
    const fixture: Fixture = { root, env, main, worktree, deps: testDeps(env) };
    const snapshot = await snapshotOf(fixture);
    const installed = spawnSync('npm', ['ci', '--offline'], {
        cwd: worktree,
        env: definedEnv(env),
        encoding: 'utf8',
    });
    assert.equal(installed.status, 0, installed.stderr);
    assert.deepEqual(sharedValues(fixture, 'core.hooksPath'), ['.husky/_']);
    assert.deepEqual(await revertConfigChanges(fixture.deps, env, snapshot), ['core.hookspath']);
    assert.deepEqual(sharedValues(fixture, 'core.hooksPath'), []);
});
