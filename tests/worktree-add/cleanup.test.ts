import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { removalCommand, removeNewEntries, removeSafely, untrackedEntries } from '../../src/worktree-add/cleanup.ts';
import { lstatOrUndefined } from '../../src/worktree-add/paths.ts';
import type { CommandRunner, Deps } from '../../src/worktree-add/types.ts';

import { testDeps } from './support/deps.ts';
import { gitSync, makeRepo, testEnv } from './support/git.ts';
import { tempRoot } from './support/tmp.ts';

interface Fixture {
    root: string;
    main: string;
    worktree: string;
    deps: Deps;
}

function writeFile(file: string, text: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}

function makeFixture(t: TestContext): Fixture {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    const worktree = path.join(root, 'app-task');
    gitSync(env, ['-C', main, 'worktree', 'add', '--quiet', '-b', 'task', worktree]);
    return { root, main, worktree, deps: testDeps(env) };
}

function linkedNodeModules(fixture: Fixture): string {
    const target = path.join(fixture.main, 'node_modules', 'pkg', 'index.js');
    writeFile(target, 'pkg\n');
    fs.symlinkSync(path.join(fixture.main, 'node_modules'), path.join(fixture.worktree, 'node_modules'));
    return target;
}

for (const rel of ['node_modules/', 'node_modules']) {
    await test(`removeSafely unlinks a linked folder given as ${rel} and keeps the link target`, (t) => {
        const fixture = makeFixture(t);
        const target = linkedNodeModules(fixture);
        assert.deepEqual(removeSafely(fixture.worktree, rel), { ok: true });
        assert.equal(lstatOrUndefined(path.join(fixture.worktree, 'node_modules')), undefined);
        assert.equal(fs.readFileSync(target, 'utf8'), 'pkg\n');
    });
}

await test('removeSafely refuses a path under a parent linked into the main clone', (t) => {
    const fixture = makeFixture(t);
    const python = path.join(fixture.main, 'services', 'api', '.venv', 'bin', 'python');
    writeFile(python, 'python\n');
    fs.symlinkSync(path.join(fixture.main, 'services'), path.join(fixture.worktree, 'services'));
    const result = removeSafely(fixture.worktree, 'services/api/.venv');
    assert.equal(result.ok, false);
    assert.equal(fs.readFileSync(python, 'utf8'), 'python\n');
});

await test('removeSafely removes a real folder and treats a missing path as removed', (t) => {
    const fixture = makeFixture(t);
    writeFile(path.join(fixture.worktree, 'build', 'nested', 'out.js'), 'out\n');
    assert.deepEqual(removeSafely(fixture.worktree, 'build/'), { ok: true });
    assert.equal(lstatOrUndefined(path.join(fixture.worktree, 'build')), undefined);
    assert.deepEqual(removeSafely(fixture.worktree, 'missing'), { ok: true });
});

await test('removeSafely refuses empty, absolute and ".." paths', (t) => {
    const fixture = makeFixture(t);
    const outside = path.join(fixture.root, 'outside.txt');
    writeFile(outside, 'keep\n');
    for (const rel of ['', '/', outside, '../outside.txt', 'a/../../outside.txt']) {
        const result = removeSafely(fixture.worktree, rel);
        assert.equal(result.ok, false, rel);
    }
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep\n');
});

await test('untrackedEntries lists untracked and ignored entries without a trailing slash', async (t) => {
    const fixture = makeFixture(t);
    writeFile(path.join(fixture.worktree, '.gitignore'), 'node_modules/\n');
    writeFile(path.join(fixture.worktree, 'node_modules', 'a', 'b.js'), 'b\n');
    writeFile(path.join(fixture.worktree, 'notes.txt'), 'n\n');
    fs.mkdirSync(path.join(fixture.worktree, 'empty'));
    const entries = await untrackedEntries(fixture.deps, fixture.worktree);
    assert.deepEqual([...(entries ?? [])].toSorted(), ['.gitignore', 'empty', 'node_modules', 'notes.txt']);
});

await test('untrackedEntries gives undefined outside a git checkout', async (t) => {
    const fixture = makeFixture(t);
    const plain = path.join(fixture.root, 'plain');
    fs.mkdirSync(plain);
    assert.equal(await untrackedEntries(fixture.deps, plain), undefined);
});

await test('removeNewEntries removes only entries absent from before', async (t) => {
    const fixture = makeFixture(t);
    const kept = path.join(fixture.worktree, 'keep.txt');
    writeFile(kept, 'keep\n');
    const before = await untrackedEntries(fixture.deps, fixture.worktree);
    assert.notEqual(before, undefined);
    writeFile(path.join(fixture.worktree, 'node_modules', 'a', 'b.js'), 'b\n');
    writeFile(path.join(fixture.worktree, 'new.txt'), 'new\n');
    const result = await removeNewEntries(fixture.deps, fixture.worktree, before ?? new Set());
    assert.deepEqual(result, { ok: true });
    assert.equal(fs.readFileSync(kept, 'utf8'), 'keep\n');
    assert.equal(lstatOrUndefined(path.join(fixture.worktree, 'node_modules')), undefined);
    assert.equal(lstatOrUndefined(path.join(fixture.worktree, 'new.txt')), undefined);
    assert.equal(fs.readFileSync(path.join(fixture.worktree, 'README.md'), 'utf8'), 'app\n');
});

await test('removeNewEntries keeps an empty folder that stood before even when the install writes into it', async (t) => {
    const fixture = makeFixture(t);
    fs.mkdirSync(path.join(fixture.worktree, 'tmp'));
    const before = await untrackedEntries(fixture.deps, fixture.worktree);
    assert.ok(before?.has('tmp'));
    writeFile(path.join(fixture.worktree, 'tmp', 'cache.bin'), 'cache\n');
    const result = await removeNewEntries(fixture.deps, fixture.worktree, before ?? new Set());
    assert.deepEqual(result, { ok: true });
    assert.equal(fs.readFileSync(path.join(fixture.worktree, 'tmp', 'cache.bin'), 'utf8'), 'cache\n');
});

await test('removeNewEntries removes an empty folder the install created', async (t) => {
    const fixture = makeFixture(t);
    const before = await untrackedEntries(fixture.deps, fixture.worktree);
    assert.notEqual(before, undefined);
    fs.mkdirSync(path.join(fixture.worktree, 'node_modules', 'partial'), { recursive: true });
    fs.mkdirSync(path.join(fixture.worktree, 'empty'));
    const result = await removeNewEntries(fixture.deps, fixture.worktree, before ?? new Set());
    assert.deepEqual(result, { ok: true });
    assert.equal(lstatOrUndefined(path.join(fixture.worktree, 'node_modules')), undefined);
    assert.equal(lstatOrUndefined(path.join(fixture.worktree, 'empty')), undefined);
});

await test('removeNewEntries reports a failed listing with the git reason and no leftovers', async (t) => {
    const fixture = makeFixture(t);
    writeFile(path.join(fixture.worktree, 'new.txt'), 'new\n');
    const runner: CommandRunner = {
        run: () => Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: index file corrupt\nmore\n' }),
        terminateAll: () => Promise.resolve(),
    };
    const result = await removeNewEntries({ ...fixture.deps, runner }, fixture.worktree, new Set());
    assert.deepEqual(result, { ok: false, leftovers: [], reason: 'fatal: index file corrupt' });
    assert.equal(fs.readFileSync(path.join(fixture.worktree, 'new.txt'), 'utf8'), 'new\n');
});

await test('removeNewEntries keeps going past a refusal and reports every leftover', async (t) => {
    const fixture = makeFixture(t);
    const python = path.join(fixture.main, 'services', 'api', '.venv', 'bin', 'python');
    writeFile(python, 'python\n');
    fs.symlinkSync(path.join(fixture.main, 'services'), path.join(fixture.worktree, 'services'));
    writeFile(path.join(fixture.worktree, 'new.txt'), 'new\n');
    const listing = ['services/api/.venv/', 'new.txt', 'services/api/node_modules', ''].join('\0');
    const runner: CommandRunner = {
        run: () => Promise.resolve({ code: 0, stdout: listing, stderr: '' }),
        terminateAll: () => Promise.resolve(),
    };
    const result = await removeNewEntries({ ...fixture.deps, runner }, fixture.worktree, new Set());
    assert.equal(result.ok, false);
    assert.deepEqual(result.ok ? [] : result.leftovers, ['services/api/.venv', 'services/api/node_modules']);
    assert.match(result.ok ? '' : result.reason, /services\/api\/\.venv/u);
    assert.equal(lstatOrUndefined(path.join(fixture.worktree, 'new.txt')), undefined);
    assert.equal(fs.readFileSync(python, 'utf8'), 'python\n');
});

await test('removalCommand quotes absolute paths for a POSIX shell without a trailing slash', () => {
    assert.equal(
        removalCommand(['/tmp/a b/node_modules/', "/tmp/it's/.venv"]),
        String.raw`rm -rf -- '/tmp/a b/node_modules' '/tmp/it'\''s/.venv'`
    );
});
