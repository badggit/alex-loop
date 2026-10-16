import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { createCloneGate } from '../../src/worktree-add/cowGate.ts';
import { EXCLUDE_HEADER, TEMP_PATTERN } from '../../src/worktree-add/exclude.ts';
import { TEMP_PREFIX } from '../../src/worktree-add/place.ts';
import { createProcessRunner } from '../../src/worktree-add/proc.ts';
import { syncIgnored } from '../../src/worktree-add/sync.ts';
import { createTransfer } from '../../src/worktree-add/transfer.ts';
import type { CloneGate, CommandRequest, CommandRunner, Deps, Env } from '../../src/worktree-add/types.ts';

import { testDeps } from './support/deps.ts';
import { commitFile, gitSync, makeRepo, testEnv } from './support/git.ts';
import { recording, withCowEmulation, withOverride, withoutCow } from './support/runners.ts';
import { tempRoot } from './support/tmp.ts';

type Wrap = (_inner: CommandRunner, _main: string) => CommandRunner;

interface Fixture {
    env: Env;
    main: string;
    worktree: string;
    deps: Deps & { lines: string[] };
    exclude: string;
}

const LOG_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z (.*)$/u;
const COPY_LINE = /^\S+ info copied (\S+) into the worktree: \d+ KB in \d+\.\d s \((plain copy|copy-on-write)\)$/u;
const IGNORE_RULES = [
    '.env',
    '.env.*',
    '!.env.example',
    'CLAUDE.local.md',
    'temp.local/',
    'node_modules/',
    'docs.local/',
    'dist/',
    '*.tsbuildinfo',
    '.claude/',
    '.venv/',
    'venv/',
    'config/',
    '',
].join('\n');
const IGNORED_FILES = [
    'apps/web/.env.local',
    'CLAUDE.local.md',
    'temp.local/notes/a.txt',
    'node_modules/pkg/index.js',
    'docs.local/x.md',
    'dist/a.js',
    'x.tsbuildinfo',
    '.claude/settings.local.json',
    '.venv/bin/python',
    'venv/bin/python',
    'config/.env',
];
const COPY_RELS = ['.env', 'CLAUDE.local.md', 'apps/web/.env.local', 'temp.local'];
const DEP_RELS = ['.venv', 'node_modules', 'venv'];
const DEAD_PID = 999_999_999;
const UNAVAILABLE_GATE: CloneGate = {
    check: () => Promise.resolve({ kind: 'unavailable', reason: 'no copy-on-write here' }),
};
const AVAILABLE_GATE: CloneGate = { check: () => Promise.resolve({ kind: 'available' }) };

function writeFile(file: string, text: string, mode?: number): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { mode });
}

function makeFixture(t: TestContext, wrap: Wrap): Fixture {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    commitFile(env, main, '.gitignore', IGNORE_RULES);
    commitFile(env, main, '.env.example', 'KEY=\n');
    commitFile(env, main, 'apps/web/index.js', 'web\n');
    writeFile(path.join(main, '.env'), 'SECRET=1\n', 0o600);
    fs.chmodSync(path.join(main, '.env'), 0o600);
    for (const rel of IGNORED_FILES) {
        writeFile(path.join(main, rel), `${rel}\n`);
    }
    fs.symlinkSync('notes/a.txt', path.join(main, 'temp.local', 'link'));
    const worktree = path.join(root, 'app-task');
    gitSync(env, ['-C', main, 'worktree', 'add', '--quiet', '-b', 'task', worktree]);
    const deps = testDeps(env, { runner: wrap(createProcessRunner(env), main) });
    return { env, main, worktree, deps, exclude: path.join(main, '.git', 'info', 'exclude') };
}

async function sync(fixture: Fixture): Promise<string[]> {
    const { deps, main, worktree } = fixture;
    const transfer = createTransfer(deps, { main, worktree, gate: createCloneGate() });
    const depRels = await syncIgnored(deps, main, worktree, transfer);
    assert.ok(depRels, 'the ignored files of the main clone could not be listed');
    return depRels;
}

function messages(lines: readonly string[]): string[] {
    return lines.map((line) => LOG_LINE.exec(line)?.[1] ?? `unformatted: ${line}`);
}

function copyMethods(lines: readonly string[]): Map<string, string> {
    const methods = new Map<string, string>();
    for (const line of lines) {
        const match = COPY_LINE.exec(line);
        if (match?.[1] !== undefined && match[2] !== undefined) {
            methods.set(match[1], match[2]);
        }
    }
    return methods;
}

function linkText(file: string): string | undefined {
    try {
        return fs.readlinkSync(file);
    } catch {
        return;
    }
}

function isFile(file: string): boolean {
    return fs.lstatSync(file, { throwIfNoEntry: false })?.isFile() === true;
}

// Every path under dir relative to it, without following links and without descending into .git.
function walk(dir: string): string[] {
    const found: string[] = [];
    const pending = [''];
    for (const rel of pending) {
        for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
            const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
            if (child === '.git') {
                continue;
            }
            found.push(child);
            if (entry.isDirectory()) {
                pending.push(child);
            }
        }
    }
    return found.toSorted();
}

function trackedWithFolders(fixture: Fixture): Set<string> {
    const tracked = new Set<string>();
    const files = gitSync(fixture.env, ['-C', fixture.worktree, 'ls-files']).split('\n');
    for (const file of files.filter((line) => line.length > 0)) {
        let current = file;
        while (current !== '.') {
            tracked.add(current);
            current = path.posix.dirname(current);
        }
    }
    return tracked;
}

function untrackedPaths(fixture: Fixture): string[] {
    const tracked = trackedWithFolders(fixture);
    return walk(fixture.worktree).filter((rel) => !tracked.has(rel));
}

// Kind, link text and file bytes of every path, so any change to the worktree shows up as a difference.
function snapshot(dir: string): string[] {
    return walk(dir).map((rel) => {
        const full = path.join(dir, rel);
        const stat = fs.lstatSync(full);
        if (stat.isSymbolicLink()) {
            return `${rel} -> ${fs.readlinkSync(full)}`;
        }
        return stat.isFile() ? `${rel}: ${fs.readFileSync(full, 'utf8')}` : `${rel}/`;
    });
}

function lineCount(file: string, line: string): number {
    return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((each) => each === line).length;
}

function assertCleanStatus(fixture: Fixture): void {
    assert.equal(gitSync(fixture.env, ['-C', fixture.worktree, 'status', '--porcelain']), '');
    for (const line of ['/docs.local', TEMP_PATTERN, EXCLUDE_HEADER]) {
        assert.equal(lineCount(fixture.exclude, line), 1, line);
    }
}

// The sync leaves dependency folders to the install stage: none stands in the worktree and none gets a pattern.
function assertDepsLeftToStage(fixture: Fixture, depRels: readonly string[]): void {
    assert.deepEqual(depRels.toSorted(), DEP_RELS);
    for (const rel of DEP_RELS) {
        assert.equal(fs.lstatSync(path.join(fixture.worktree, rel), { throwIfNoEntry: false }), undefined, rel);
        assert.equal(lineCount(fixture.exclude, `/${rel}`), 0, rel);
    }
}

function assertCopies(fixture: Fixture): void {
    const { main, worktree } = fixture;
    const env = fs.lstatSync(path.join(worktree, '.env'));
    assert.equal(env.isFile(), true);
    assert.equal(env.mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(path.join(worktree, '.env'), 'utf8'), 'SECRET=1\n');
    for (const rel of ['apps/web/.env.local', 'CLAUDE.local.md', 'temp.local/notes/a.txt']) {
        assert.equal(isFile(path.join(worktree, rel)), true, rel);
        assert.equal(fs.readFileSync(path.join(worktree, rel), 'utf8'), `${rel}\n`);
    }
    assert.equal(fs.lstatSync(path.join(worktree, 'temp.local')).isDirectory(), true);
    assert.equal(linkText(path.join(worktree, 'temp.local', 'link')), 'notes/a.txt');
    assert.equal(linkText(path.join(main, 'temp.local', 'link')), 'notes/a.txt');
}

function tempsUnder(dir: string): string[] {
    return walk(dir).filter((rel) => path.posix.basename(rel).startsWith(TEMP_PREFIX));
}

// Fails the first cloning cp of placeCopy (it carries -R, the gate probe does not) for source.
function failFirstClone(inner: CommandRunner, source: string, failed: CommandRequest[]): CommandRunner {
    return {
        run: (request) => {
            const { args } = request;
            const cloning = args.includes('--reflink=always') && args.includes('-R') && args.includes(source);
            if (cloning && failed.length === 0) {
                failed.push(request);
                return Promise.resolve({ code: 1, stdout: '', stderr: 'clone failed' });
            }
            return inner.run(request);
        },
        terminateAll: () => inner.terminateAll(),
    };
}

await test('without copy-on-write the copies are plain and dependency folders are left to the stage', async (t) => {
    const fixture = makeFixture(t, withoutCow);
    const depRels = await sync(fixture);
    const { deps } = fixture;
    assertCopies(fixture);
    assertDepsLeftToStage(fixture, depRels);
    assert.equal(
        messages(deps.lines).some((line) => line.includes('node_modules')),
        false
    );
    const methods = copyMethods(deps.lines);
    assert.deepEqual([...methods.keys()].toSorted(), COPY_RELS.toSorted());
    assert.deepEqual(new Set(methods.values()), new Set(['plain copy']));
    assertCleanStatus(fixture);
});

await test('with copy-on-write the copies are clones and dependency folders are left to the stage', async (t) => {
    const fixture = makeFixture(t, withCowEmulation);
    const depRels = await sync(fixture);
    const { deps } = fixture;
    assertCopies(fixture);
    assertDepsLeftToStage(fixture, depRels);
    assert.equal(
        messages(deps.lines).some((line) => line.includes('node_modules')),
        false
    );
    const methods = copyMethods(deps.lines);
    assert.deepEqual([...methods.keys()].toSorted(), COPY_RELS.toSorted());
    assert.deepEqual(new Set(methods.values()), new Set(['copy-on-write']));
    assertCleanStatus(fixture);
});

await test('nested entries land at exactly their own paths', async (t) => {
    const fixture = makeFixture(t, withoutCow);
    await sync(fixture);
    const { main, worktree } = fixture;
    assert.deepEqual(
        untrackedPaths(fixture),
        [
            '.claude',
            '.env',
            'apps/web/.env.local',
            'CLAUDE.local.md',
            'config',
            'docs.local',
            'temp.local',
            'temp.local/link',
            'temp.local/notes',
            'temp.local/notes/a.txt',
        ].toSorted()
    );
    assert.equal(linkText(path.join(worktree, 'docs.local')), path.join(main, 'docs.local'));
    for (const rel of ['.env.local', 'apps/web/temp.local', 'apps/web/docs.local']) {
        assert.equal(fs.lstatSync(path.join(worktree, rel), { throwIfNoEntry: false }), undefined, rel);
    }
});

await test('a second sync changes nothing and keeps an edited .env', async (t) => {
    const fixture = makeFixture(t, withoutCow);
    await sync(fixture);
    const { worktree, deps, exclude } = fixture;
    fs.writeFileSync(path.join(worktree, '.env'), 'SECRET=edited\n');
    const before = snapshot(worktree);
    const excludeBefore = fs.readFileSync(exclude, 'utf8');
    deps.lines.length = 0;
    await sync(fixture);
    assert.deepEqual(snapshot(worktree), before);
    assert.equal(fs.readFileSync(exclude, 'utf8'), excludeBefore);
    assert.equal(fs.readFileSync(path.join(worktree, '.env'), 'utf8'), 'SECRET=edited\n');
    assert.deepEqual(copyMethods(deps.lines).size, 0);
});

await test('an own link at .env becomes a copy and a dead temp next to it is swept', async (t) => {
    const fixture = makeFixture(t, withoutCow);
    const { main, worktree } = fixture;
    fs.symlinkSync(path.join(main, '.env'), path.join(worktree, '.env'));
    const deadTemp = path.join(worktree, `${TEMP_PREFIX}${String(DEAD_PID)}-1`);
    fs.writeFileSync(deadTemp, 'left over\n');
    await sync(fixture);
    assert.equal(isFile(path.join(worktree, '.env')), true);
    assert.equal(fs.readFileSync(path.join(worktree, '.env'), 'utf8'), 'SECRET=1\n');
    assert.equal(fs.existsSync(deadTemp), false);
    assert.deepEqual(tempsUnder(worktree), []);
});

await test('a failing copy warns, leaves nothing behind and the rest still syncs', async (t) => {
    const fixture = makeFixture(t, (inner, main) =>
        withOverride(
            withoutCow(inner),
            (request) => path.basename(request.file) === 'cp' && request.args.includes(path.join(main, 'temp.local')),
            { code: 1, stdout: '', stderr: 'disk full' }
        )
    );
    const { main, worktree, deps } = fixture;
    await sync(fixture);
    assert.equal(
        messages(deps.lines).includes('warn cannot copy temp.local into the worktree: cp exited with 1: disk full'),
        true
    );
    assert.equal(fs.lstatSync(path.join(worktree, 'temp.local'), { throwIfNoEntry: false }), undefined);
    assert.deepEqual(tempsUnder(worktree), []);
    const methods = copyMethods(deps.lines);
    assert.deepEqual([...methods.keys()].toSorted(), ['.env', 'CLAUDE.local.md', 'apps/web/.env.local']);
    assert.equal(linkText(path.join(worktree, 'docs.local')), path.join(main, 'docs.local'));
    assert.equal(fs.lstatSync(path.join(worktree, 'node_modules'), { throwIfNoEntry: false }), undefined);
});

await test('a failed clone of a copy entry is retried once as a plain copy', async (t) => {
    const failed: CommandRequest[] = [];
    const fixture = makeFixture(t, (inner, main) =>
        failFirstClone(withCowEmulation(inner), path.join(main, '.env'), failed)
    );
    const { worktree, deps } = fixture;
    await sync(fixture);
    assert.equal(failed.length, 1);
    assert.equal(fs.readFileSync(path.join(worktree, '.env'), 'utf8'), 'SECRET=1\n');
    const methods = copyMethods(deps.lines);
    assert.equal(methods.get('.env'), 'plain copy');
    assert.equal(methods.get('CLAUDE.local.md'), 'copy-on-write');
    assert.equal(
        messages(deps.lines).includes(
            'info cannot clone .env with copy-on-write (cp exited with 1: clone failed); copying it instead'
        ),
        true
    );
});

await test('the elapsed time has one decimal and an unavailable gate means a plain copy', async (t) => {
    const root = tempRoot(t);
    const main = path.join(root, 'main');
    const worktree = path.join(root, 'wt');
    writeFile(path.join(main, '.env'), 'A=1\n');
    fs.mkdirSync(worktree);
    const runner = recording(createProcessRunner(testEnv(root)));
    const deps = testDeps(testEnv(root), { runner });
    const times = [1000, 2500];
    const transfer = createTransfer(deps, {
        main,
        worktree,
        gate: UNAVAILABLE_GATE,
        nowMs: () => times.shift() ?? 0,
    });
    assert.equal(await transfer.copyEntry('.env'), 'copied');
    assert.deepEqual(messages(deps.lines), ['info copied .env into the worktree: 1 KB in 1.5 s (plain copy)']);
    assert.equal(
        runner.calls.some((call) => call.args.includes('--reflink=always')),
        false
    );
    assert.equal(fs.readFileSync(path.join(worktree, '.env'), 'utf8'), 'A=1\n');
});

await test('cloneDependency reports an unavailable gate without running cp', async (t) => {
    const root = tempRoot(t);
    const main = path.join(root, 'main');
    const worktree = path.join(root, 'wt');
    writeFile(path.join(main, 'node_modules', 'a.js'), 'a\n');
    fs.mkdirSync(worktree);
    const runner = recording(createProcessRunner(testEnv(root)));
    const deps = testDeps(testEnv(root), { runner });
    const transfer = createTransfer(deps, { main, worktree, gate: UNAVAILABLE_GATE });
    assert.deepEqual(await transfer.cloneDependency('node_modules'), {
        kind: 'unavailable',
        reason: 'no copy-on-write here',
    });
    assert.deepEqual(runner.calls, []);
    assert.deepEqual(deps.lines, []);
});

await test('cloneDependency reports a failed clone and leaves no temp', async (t) => {
    const root = tempRoot(t);
    const main = path.join(root, 'main');
    const worktree = path.join(root, 'wt');
    writeFile(path.join(main, 'node_modules', 'a.js'), 'a\n');
    fs.mkdirSync(worktree);
    const deps = testDeps(testEnv(root), { runner: withoutCow(createProcessRunner(testEnv(root))) });
    const transfer = createTransfer(deps, { main, worktree, gate: AVAILABLE_GATE });
    assert.deepEqual(await transfer.cloneDependency('node_modules'), {
        kind: 'failed',
        reason: 'cp exited with 1: failed to clone',
    });
    assert.deepEqual(messages(deps.lines), ['info cloning node_modules into the worktree with copy-on-write']);
    assert.deepEqual(fs.readdirSync(worktree), []);
});
