import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { createCloneGate } from '../../src/worktree-add/cowGate.ts';
import { applyFallback } from '../../src/worktree-add/fallback.ts';
import { createProcessRunner } from '../../src/worktree-add/proc.ts';
import { createTransfer } from '../../src/worktree-add/transfer.ts';
import type { CloneOutcome, CommandRunner, Deps, EntryTransfer } from '../../src/worktree-add/types.ts';

import { testDeps } from './support/deps.ts';
import { testEnv } from './support/git.ts';
import { withCowEmulation, withoutCow } from './support/runners.ts';
import { tempRoot } from './support/tmp.ts';

const LOG_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z (.*)$/u;

interface Fixture {
    root: string;
    main: string;
    worktree: string;
    deps: Deps & { lines: string[] };
}

interface FakeTransfer extends EntryTransfer {
    clones: string[];
}

function writeFile(file: string, text: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}

function makeFixture(t: TestContext, wrap?: (_inner: CommandRunner) => CommandRunner): Fixture {
    const root = tempRoot(t);
    const env = testEnv(root);
    const main = path.join(root, 'app');
    const worktree = path.join(root, 'app-task');
    for (const rel of ['node_modules/pkg/index.js', '.venv/bin/python', 'packages/a/node_modules/x/index.js']) {
        writeFile(path.join(main, rel), `${rel}\n`);
    }
    fs.mkdirSync(path.join(worktree, 'packages', 'a'), { recursive: true });
    const runner = createProcessRunner(env);
    const deps = testDeps(env, { runner: wrap === undefined ? runner : wrap(runner) });
    return { root, main, worktree, deps };
}

function fakeTransfer(clone?: (_rel: string) => CloneOutcome): FakeTransfer {
    const clones: string[] = [];
    return {
        clones,
        copyEntry: () => Promise.reject(new Error('copyEntry must not be called')),
        cloneDependency: (rel) => {
            clones.push(rel);
            return Promise.resolve(clone?.(rel) ?? { kind: 'cloned' });
        },
    };
}

function realTransfer(fixture: Fixture): EntryTransfer {
    const { deps, main, worktree } = fixture;
    return createTransfer(deps, { main, worktree, gate: createCloneGate() });
}

function messages(lines: readonly string[]): string[] {
    return lines.map((line) => LOG_LINE.exec(line)?.[1] ?? `unformatted: ${line}`);
}

function linkText(file: string): string | undefined {
    try {
        return fs.readlinkSync(file);
    } catch {
        return;
    }
}

function paths(fixture: Fixture): { main: string; worktree: string } {
    return { main: fixture.main, worktree: fixture.worktree };
}

await test('a cloned node_modules gives cloned and no link', async (t) => {
    const fixture = makeFixture(t);
    const transfer = fakeTransfer();
    const results = await applyFallback(fixture.deps, paths(fixture), transfer, ['node_modules']);
    assert.deepEqual(results, [{ rel: 'node_modules', kind: 'cloned' }]);
    assert.deepEqual(transfer.clones, ['node_modules']);
    assert.equal(linkText(path.join(fixture.worktree, 'node_modules')), undefined);
});

await test('node_modules is linked when clones are unavailable', async (t) => {
    const fixture = makeFixture(t);
    const transfer = fakeTransfer(() => ({ kind: 'unavailable', reason: 'no copy-on-write' }));
    const rels = ['node_modules', 'packages/a/node_modules'];
    const results = await applyFallback(fixture.deps, paths(fixture), transfer, rels);
    assert.deepEqual(results, [
        { rel: 'node_modules', kind: 'linked' },
        { rel: 'packages/a/node_modules', kind: 'linked' },
    ]);
    assert.deepEqual(transfer.clones, rels);
    for (const rel of rels) {
        assert.equal(linkText(path.join(fixture.worktree, rel)), path.join(fixture.main, rel));
    }
    assert.deepEqual(messages(fixture.deps.lines), [
        'info linked node_modules: no copy-on-write',
        'info linked packages/a/node_modules: no copy-on-write',
    ]);
});

await test('.venv is linked even when clones are available', async (t) => {
    const fixture = makeFixture(t);
    const transfer = fakeTransfer();
    const results = await applyFallback(fixture.deps, paths(fixture), transfer, ['.venv']);
    assert.deepEqual(results, [{ rel: '.venv', kind: 'linked' }]);
    assert.deepEqual(transfer.clones, []);
    assert.equal(linkText(path.join(fixture.worktree, '.venv')), path.join(fixture.main, '.venv'));
});

await test('an own link already at .venv stays and gives linked', async (t) => {
    const fixture = makeFixture(t);
    const dest = path.join(fixture.worktree, '.venv');
    fs.symlinkSync(path.join(fixture.main, '.venv'), dest);
    const transfer = fakeTransfer();
    const results = await applyFallback(fixture.deps, paths(fixture), transfer, ['.venv']);
    assert.deepEqual(results, [{ rel: '.venv', kind: 'linked' }]);
    assert.deepEqual(transfer.clones, []);
    assert.equal(linkText(dest), path.join(fixture.main, '.venv'));
    assert.deepEqual(messages(fixture.deps.lines), []);
});

await test('an own node_modules link becomes a clone with copy-on-write', async (t) => {
    const fixture = makeFixture(t, withCowEmulation);
    const { main, worktree } = fixture;
    const dest = path.join(worktree, 'node_modules');
    fs.symlinkSync(path.join(main, 'node_modules'), dest);
    const results = await applyFallback(fixture.deps, paths(fixture), realTransfer(fixture), ['node_modules']);
    assert.deepEqual(results, [{ rel: 'node_modules', kind: 'cloned' }]);
    assert.equal(fs.lstatSync(dest).isDirectory(), true);
    assert.equal(fs.readFileSync(path.join(dest, 'pkg', 'index.js'), 'utf8'), 'node_modules/pkg/index.js\n');
    const source = path.join(main, 'node_modules');
    assert.equal(fs.lstatSync(source).isDirectory(), true);
    assert.deepEqual(fs.readdirSync(source), ['pkg']);
    assert.equal(fs.readFileSync(path.join(source, 'pkg', 'index.js'), 'utf8'), 'node_modules/pkg/index.js\n');
});

await test('an own node_modules link stays when clones are unavailable', async (t) => {
    const fixture = makeFixture(t, withoutCow);
    const { main, worktree } = fixture;
    const dest = path.join(worktree, 'node_modules');
    fs.symlinkSync(path.join(main, 'node_modules'), dest);
    const results = await applyFallback(fixture.deps, paths(fixture), realTransfer(fixture), ['node_modules']);
    assert.deepEqual(results, [{ rel: 'node_modules', kind: 'linked' }]);
    assert.equal(linkText(dest), path.join(main, 'node_modules'));
    assert.equal(
        fs.readFileSync(path.join(main, 'node_modules', 'pkg', 'index.js'), 'utf8'),
        'node_modules/pkg/index.js\n'
    );
});

await test('a failed clone gives a link and a warning with the reason', async (t) => {
    const fixture = makeFixture(t);
    const transfer = fakeTransfer(() => ({ kind: 'failed', reason: 'disk full' }));
    const results = await applyFallback(fixture.deps, paths(fixture), transfer, ['node_modules']);
    assert.deepEqual(results, [{ rel: 'node_modules', kind: 'linked' }]);
    assert.equal(linkText(path.join(fixture.worktree, 'node_modules')), path.join(fixture.main, 'node_modules'));
    assert.deepEqual(messages(fixture.deps.lines), [
        'warn cannot clone node_modules into the worktree (disk full); linked it instead',
    ]);
});

await test('a foreign file at the destination gives present and is unchanged', async (t) => {
    const fixture = makeFixture(t);
    const transfer = fakeTransfer();
    const foreign = path.join(fixture.worktree, 'node_modules');
    const venvLink = path.join(fixture.worktree, '.venv');
    fs.writeFileSync(foreign, 'mine\n');
    fs.symlinkSync('elsewhere', venvLink);
    const results = await applyFallback(fixture.deps, paths(fixture), transfer, ['node_modules', '.venv']);
    assert.deepEqual(results, [
        { rel: 'node_modules', kind: 'present' },
        { rel: '.venv', kind: 'present' },
    ]);
    assert.deepEqual(transfer.clones, []);
    assert.equal(fs.readFileSync(foreign, 'utf8'), 'mine\n');
    assert.equal(linkText(venvLink), 'elsewhere');
    assert.deepEqual(messages(fixture.deps.lines), []);
});

await test('a rel under a linked parent creates nothing in the main clone', async (t) => {
    const fixture = makeFixture(t);
    const { main, worktree } = fixture;
    fs.mkdirSync(path.join(main, 'apps', 'web'), { recursive: true });
    fs.symlinkSync(path.join(main, 'apps'), path.join(worktree, 'apps'));
    const transfer = fakeTransfer(() => ({ kind: 'unavailable', reason: 'no copy-on-write' }));
    const rels = ['apps/web/node_modules', 'apps/web/.venv'];
    const results = await applyFallback(fixture.deps, paths(fixture), transfer, rels);
    assert.deepEqual(results, [
        { rel: 'apps/web/node_modules', kind: 'present' },
        { rel: 'apps/web/.venv', kind: 'present' },
    ]);
    assert.deepEqual(transfer.clones, []);
    assert.deepEqual(fs.readdirSync(path.join(main, 'apps', 'web')), []);
});

// A name longer than any file system allows makes symlink fail for every user, root included.
await test('a link that cannot be made warns and gives failed', async (t) => {
    const fixture = makeFixture(t);
    const rel = 'v'.repeat(300);
    const results = await applyFallback(fixture.deps, paths(fixture), fakeTransfer(), [rel]);
    assert.deepEqual(results, [{ rel, kind: 'failed' }]);
    assert.deepEqual(messages(fixture.deps.lines), [`warn cannot link ${rel} into the worktree: ENAMETOOLONG`]);
});

await test('a rel whose parent is missing gives no-parent and creates nothing', async (t) => {
    const fixture = makeFixture(t);
    const results = await applyFallback(fixture.deps, paths(fixture), fakeTransfer(), ['missing/.venv']);
    assert.deepEqual(results, [{ rel: 'missing/.venv', kind: 'no-parent' }]);
    assert.equal(fs.existsSync(path.join(fixture.worktree, 'missing')), false);
});
