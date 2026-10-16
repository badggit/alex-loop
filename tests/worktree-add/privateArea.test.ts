import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
    addPartialMarks,
    clearPartialMarks,
    logFileName,
    PARTIAL_MARKER,
    privateDir,
    readPartialMarks,
    writeInstallLog,
} from '../../src/worktree-add/privateArea.ts';

import { testDeps } from './support/deps.ts';
import { gitSync, makeRepo, testEnv } from './support/git.ts';
import { tempRoot } from './support/tmp.ts';

await test('privateDir of a linked worktree is its folder under .git/worktrees', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    const worktree = path.join(root, 'app-task');
    gitSync(env, ['-C', main, 'worktree', 'add', '--quiet', '-b', 'task', worktree]);
    const dir = await privateDir(testDeps(env), worktree);
    assert.equal(dir, path.join(main, '.git', 'worktrees', 'app-task'));
});

await test('privateDir gives undefined outside a git checkout', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    assert.equal(await privateDir(testDeps(env), plain), undefined);
});

await test('logFileName names the root project by manager and others by a slug', () => {
    assert.equal(logFileName('npm', ''), 'alex-loop-install-npm.log');
    assert.equal(logFileName('npm', '.'), 'alex-loop-install-npm.log');
    assert.equal(logFileName('uv', 'services/api'), 'alex-loop-install-uv-services%2Fapi.log');
    assert.equal(logFileName('pnpm', 'apps/my app+x'), 'alex-loop-install-pnpm-apps%2Fmy%20app%2Bx.log');
    assert.equal(logFileName('npm', 'caf\u00E9'), 'alex-loop-install-npm-caf%C3%A9.log');
});

await test('logFileName never gives two project folders the same name', () => {
    const dirs = ['a-b', 'a/b', 'a_b', 'a b', 'a%2Fb', 'a%b', 'a-/b', 'a/-b'];
    const names = dirs.map((dir) => logFileName('npm', dir));
    assert.equal(new Set(names).size, dirs.length, names.join('\n'));
});

await test('writeInstallLog overwrites an existing wider file and leaves it at 0600', (t) => {
    const dir = tempRoot(t);
    const file = path.join(dir, 'alex-loop-install-npm.log');
    fs.writeFileSync(file, 'old text that is longer than the new one\n');
    fs.chmodSync(file, 0o644);
    const result = writeInstallLog(dir, 'alex-loop-install-npm.log', 'new\n');
    assert.deepEqual(result, { ok: true, path: file });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(file, 'utf8'), 'new\n');
});

await test('writeInstallLog creates a new file with mode 0600', (t) => {
    const dir = tempRoot(t);
    const result = writeInstallLog(dir, 'alex-loop-install-uv.log', 'log\n');
    assert.equal(result.ok, true);
    assert.equal(fs.statSync(path.join(dir, 'alex-loop-install-uv.log')).mode & 0o777, 0o600);
});

await test('writeInstallLog into a missing folder fails with an error code', (t) => {
    const dir = path.join(tempRoot(t), 'missing');
    const result = writeInstallLog(dir, 'alex-loop-install-npm.log', 'log\n');
    assert.deepEqual(result, { ok: false, reason: 'ENOENT' });
});

await test('writeInstallLog refuses a symlink at the log path and leaves its target alone', (t) => {
    const root = tempRoot(t);
    const dir = path.join(root, 'private');
    fs.mkdirSync(dir);
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'outside\n');
    fs.chmodSync(outside, 0o644);
    fs.symlinkSync(outside, path.join(dir, 'alex-loop-install-npm.log'));
    const result = writeInstallLog(dir, 'alex-loop-install-npm.log', 'log\n');
    assert.deepEqual(result, { ok: false, reason: 'ELOOP' });
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside\n');
    assert.equal(fs.statSync(outside).mode & 0o777, 0o644);
});

await test('partial marks add, read and clear round-trip with each path once', (t) => {
    const dir = tempRoot(t);
    assert.deepEqual(readPartialMarks(dir), []);
    assert.equal(addPartialMarks(dir, ['node_modules', 'services/api/.venv']), true);
    assert.equal(addPartialMarks(dir, ['services/api/.venv', 'apps/web/node_modules']), true);
    assert.deepEqual(readPartialMarks(dir), ['node_modules', 'services/api/.venv', 'apps/web/node_modules']);
    assert.equal(
        fs.readFileSync(path.join(dir, PARTIAL_MARKER), 'utf8'),
        'node_modules\nservices/api/.venv\napps/web/node_modules\n'
    );
    assert.equal(clearPartialMarks(dir, ['services/api/.venv']), true);
    assert.deepEqual(readPartialMarks(dir), ['node_modules', 'apps/web/node_modules']);
    assert.equal(clearPartialMarks(dir, ['node_modules', 'apps/web/node_modules']), true);
    assert.deepEqual(readPartialMarks(dir), []);
});

await test('partial marks report failure when the folder is missing', (t) => {
    const dir = path.join(tempRoot(t), 'missing');
    assert.equal(addPartialMarks(dir, ['node_modules']), false);
});
