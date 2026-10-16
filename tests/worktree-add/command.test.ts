import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { runWorktreeAdd, type CommandIo } from '../../src/worktree-add/command.ts';
import { SANDBOX_NETWORK_VARIABLE } from '../../src/worktree-add/installStage.ts';
import { createProcessRunner } from '../../src/worktree-add/proc.ts';
import type { CloneGate, Deps, Env, Outcome } from '../../src/worktree-add/types.ts';

import { testDeps } from './support/deps.ts';
import { commitFile, gitSync, makeRepo, testEnv } from './support/git.ts';
import { recording, withOverride, withoutCow } from './support/runners.ts';
import { isolatedBin, withPath } from './support/stubManagers.ts';
import { tempRoot } from './support/tmp.ts';
import { writeStubTool } from './support/tools.ts';

interface Fixture {
    root: string;
    env: Env;
    main: string;
    origin: string;
    deps: Deps & { lines: string[] };
}

const IGNORE_RULES = '.env\ndocs.local/\n';
const BROKEN_GATE: CloneGate = {
    check: () => Promise.reject(new Error('gate broke')),
};
const NPM_LOCK = '{"lockfileVersion":3}\n';
const NPM_STUB = 'case "$1" in --version) echo 10.9.0; exit 0;; esac\nmkdir -p node_modules/from-stub\nexit 0';

// A main clone app on a feature branch with an ignored .env (a copy) and docs.local (a link); no-CoW is forced.
function makeFixture(t: TestContext): Fixture {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main, origin } = makeRepo(root, env);
    commitFile(env, main, '.gitignore', IGNORE_RULES);
    gitSync(env, ['-C', main, 'push', '--quiet', 'origin', 'main']);
    gitSync(env, ['-C', main, 'switch', '--quiet', '-c', 'feature']);
    commitFile(env, main, 'feature.txt', 'feature\n');
    fs.writeFileSync(path.join(main, '.env'), 'A=1\n');
    fs.mkdirSync(path.join(main, 'docs.local'));
    fs.writeFileSync(path.join(main, 'docs.local', 'a.md'), 'doc\n');
    const deps = testDeps(env, { runner: withoutCow(createProcessRunner(env)) });
    return { root, env, main, origin, deps };
}

// A main clone app with a tracked npm project, its node_modules ignored and present, and a stub npm on an isolated
// PATH that makes node_modules/from-stub; cloning is forced to fail, so a fallback node_modules is an own link.
function makeInstallFixture(t: TestContext): Fixture {
    const root = tempRoot(t);
    const bin = isolatedBin(root);
    writeStubTool(bin, 'npm', NPM_STUB);
    const env: Env = { ...withPath(testEnv(root), bin), [SANDBOX_NETWORK_VARIABLE]: undefined };
    const { main, origin } = makeRepo(root, env);
    commitFile(env, main, '.gitignore', 'node_modules/\n');
    commitFile(env, main, 'package.json', '{"name":"demo"}\n');
    commitFile(env, main, 'package-lock.json', NPM_LOCK);
    gitSync(env, ['-C', main, 'push', '--quiet', 'origin', 'main']);
    fs.mkdirSync(path.join(main, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(main, 'node_modules', 'pkg', 'index.js'), 'pkg\n');
    const runner = withoutCow(createProcessRunner(env));
    t.after(() => runner.terminateAll());
    return { root, env, main, origin, deps: testDeps(env, { runner }) };
}

function runWith(f: Fixture, argv: readonly string[], extra: Partial<CommandIo>): Promise<Outcome> {
    return runWorktreeAdd({ deps: f.deps, env: f.env, cwd: f.main, ...extra }, argv);
}

function run(f: Fixture, argv: readonly string[], cwd = f.main, gate?: CloneGate): Promise<Outcome> {
    return runWorktreeAdd({ deps: f.deps, env: f.env, cwd, gate }, argv);
}

function okPath(outcome: Outcome): string {
    assert.equal(outcome.kind, 'ok', JSON.stringify(outcome));
    return outcome.kind === 'ok' ? outcome.path : '';
}

function refusedReason(outcome: Outcome): string {
    assert.equal(outcome.kind, 'refused', JSON.stringify(outcome));
    return outcome.kind === 'refused' ? outcome.reason : '';
}

function lineIndex(f: Fixture, text: string): number {
    const index = f.deps.lines.findIndex((line) => line.includes(text));
    assert.notEqual(index, -1, `no log line with ${text}:\n${f.deps.lines.join('\n')}`);
    return index;
}

function logged(f: Fixture, text: string): boolean {
    return f.deps.lines.some((line) => line.includes(text));
}

function branchExists(f: Fixture, branch: string): boolean {
    try {
        gitSync(f.env, ['-C', f.main, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
        return true;
    } catch {
        return false;
    }
}

function tipOf(f: Fixture, ref: string): string {
    return gitSync(f.env, ['-C', f.main, 'rev-parse', ref]).trim();
}

await test('a new worktree is created next to the main clone on a branch from main', async (t) => {
    const f = makeFixture(t);
    const target = path.join(f.root, 'app-abc-123-oauth-login');
    assert.equal(okPath(await run(f, ['--suffix', 'abc-123-oauth-login'])), target);
    assert.equal(tipOf(f, 'refs/heads/abc-123-oauth-login'), tipOf(f, 'refs/heads/main'));
    assert.ok(fs.lstatSync(path.join(target, '.env')).isFile());
    assert.equal(fs.readFileSync(path.join(target, '.env'), 'utf8'), 'A=1\n');
    assert.ok(fs.lstatSync(path.join(target, 'docs.local')).isSymbolicLink());
    const order = [
        lineIndex(f, 'info name based on main clone folder app'),
        lineIndex(f, 'info created worktree'),
        lineIndex(f, 'info copied .env into the worktree'),
        lineIndex(f, 'info linked docs.local'),
    ];
    assert.deepEqual(
        order,
        [...order].toSorted((a, b) => a - b)
    );
});

await test('a second identical run reuses the worktree and changes nothing', async (t) => {
    const f = makeFixture(t);
    const target = okPath(await run(f, ['--suffix', 'abc-123-oauth-login']));
    fs.writeFileSync(path.join(target, '.env'), 'local edit\n');
    const tip = tipOf(f, 'refs/heads/abc-123-oauth-login');
    const entries = fs.readdirSync(target).toSorted();
    f.deps.lines.length = 0;
    assert.equal(okPath(await run(f, ['--suffix', 'abc-123-oauth-login'])), target);
    assert.ok(logged(f, `info reusing worktree ${target}`));
    assert.equal(fs.readFileSync(path.join(target, '.env'), 'utf8'), 'local edit\n');
    assert.equal(tipOf(f, 'refs/heads/abc-123-oauth-login'), tip);
    assert.deepEqual(fs.readdirSync(target).toSorted(), entries);
});

await test('a run from inside a linked worktree answers that worktree and names the main tree', async (t) => {
    const f = makeFixture(t);
    const target = okPath(await run(f, ['--suffix', 'rep-1']));
    const before = fs.readdirSync(f.root).toSorted();
    f.deps.lines.length = 0;
    assert.equal(okPath(await run(f, ['--suffix', 'rep-2'], target)), target);
    assert.ok(
        logged(
            f,
            `info already in the worktree ${target}: no new worktree is created; run it from the main working tree ${f.main} to create one`
        )
    );
    assert.deepEqual(fs.readdirSync(f.root).toSorted(), before);
});

await test('a linked worktree of a bare repository answers itself without naming a main tree', async (t) => {
    const f = makeFixture(t);
    const hubTree = path.join(f.root, 'hub-tree');
    gitSync(f.env, ['-C', f.origin, 'worktree', 'add', '--quiet', hubTree, 'main']);
    const real = fs.realpathSync.native(hubTree);
    assert.equal(okPath(await run(f, ['--suffix', 'rep-3'], real)), real);
    const line = f.deps.lines[lineIndex(f, 'already in the worktree')] ?? '';
    assert.ok(line.endsWith(`info already in the worktree ${real}: no new worktree is created`), line);
});

await test('a ~/ parent is expanded from HOME and created', async (t) => {
    const f = makeFixture(t);
    const home = f.env.HOME ?? '';
    const target = path.join(home, 'wt', 'app-rep-4');
    assert.equal(okPath(await run(f, ['--suffix', 'rep-4', '--parent', '~/wt'])), target);
    assert.ok(fs.lstatSync(target).isDirectory());
    assert.ok(logged(f, `info created parent folder ${path.join(home, 'wt')}`));
});

await test('other worktrees of the same ticket are listed', async (t) => {
    const f = makeFixture(t);
    okPath(await run(f, ['--suffix', 'gh-7-a']));
    f.deps.lines.length = 0;
    okPath(await run(f, ['--suffix', 'gh-7-b']));
    assert.ok(logged(f, `info other worktrees for ticket gh-7: ${path.join(f.root, 'app-gh-7-a')} (gh-7-a)`));
});

await test('an existing local branch is checked out and described', async (t) => {
    const f = makeFixture(t);
    gitSync(f.env, ['-C', f.main, 'branch', 'rep-9-x', 'main']);
    okPath(await run(f, ['--suffix', 'rep-9-x']));
    assert.ok(logged(f, 'info checking out EXISTING local branch rep-9-x'));
});

await test('a sync that throws is only a warning', async (t) => {
    const f = makeFixture(t);
    const target = path.join(f.root, 'app-rep-5');
    assert.equal(okPath(await run(f, ['--suffix', 'rep-5'], f.main, BROKEN_GATE)), target);
    assert.ok(logged(f, 'warn cannot sync ignored paths into the worktree: gate broke'));
});

await test('a non-empty folder at the target is refused and nothing is created', async (t) => {
    const f = makeFixture(t);
    const target = path.join(f.root, 'app-rep-6');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep.txt'), 'keep\n');
    assert.match(refusedReason(await run(f, ['--suffix', 'rep-6'])), /something already exists/u);
    assert.deepEqual(fs.readdirSync(target), ['keep.txt']);
    assert.equal(branchExists(f, 'rep-6'), false);
});

await test('a bare repository and a folder outside any repository are refused', async (t) => {
    const f = makeFixture(t);
    const before = fs.readdirSync(f.root).toSorted();
    refusedReason(await run(f, ['--suffix', 'rep-7'], f.origin));
    const outside = path.join(f.root, 'outside');
    fs.mkdirSync(outside);
    assert.match(refusedReason(await run(f, ['--suffix', 'rep-7'], outside)), /not a git repository/u);
    assert.deepEqual(fs.readdirSync(f.root).toSorted(), [...before, 'outside'].toSorted());
    assert.equal(branchExists(f, 'rep-7'), false);
});

await test('a git older than 2.29 is refused', async (t) => {
    const f = makeFixture(t);
    const old = { code: 0, stdout: 'git version 2.28.0\n', stderr: '' };
    f.deps.runner = withOverride(f.deps.runner, (request) => request.args.includes('--version'), old);
    const reason = refusedReason(await run(f, ['--suffix', 'rep-8']));
    assert.equal(reason, 'git 2.29 or newer is required, found 2.28.0');
    assert.equal(fs.existsSync(path.join(f.root, 'app-rep-8')), false);
});

await test('usage and help outcomes come from the arguments', async (t) => {
    const f = makeFixture(t);
    assert.deepEqual(await run(f, ['--help']), { kind: 'help' });
    const missing = await run(f, []);
    assert.equal(missing.kind, 'usage');
    const fileParent = await run(f, ['--suffix', 'rep-9', '--parent', path.join(f.main, '.gitignore')]);
    assert.equal(fileParent.kind, 'usage');
});

await test('a tracked npm lock file installs node_modules in the worktree with the stub npm', async (t) => {
    const f = makeInstallFixture(t);
    const target = okPath(await runWith(f, ['--suffix', 'inst-1'], {}));
    const modules = path.join(target, 'node_modules');
    assert.ok(fs.lstatSync(modules).isDirectory(), f.deps.lines.join('\n'));
    assert.deepEqual(fs.readdirSync(modules), ['from-stub']);
    assert.deepEqual(fs.readdirSync(path.join(f.main, 'node_modules')), ['pkg']);
    assert.equal(fs.readFileSync(path.join(f.main, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'pkg\n');
});

await test('--no-install leaves node_modules in the worktree as an own link', async (t) => {
    const f = makeInstallFixture(t);
    const target = okPath(await runWith(f, ['--suffix', 'inst-2', '--no-install'], {}));
    const modules = path.join(target, 'node_modules');
    assert.ok(fs.lstatSync(modules).isSymbolicLink(), f.deps.lines.join('\n'));
    assert.equal(fs.readlinkSync(modules), path.join(f.main, 'node_modules'));
    assert.ok(logged(f, 'info installs skipped (--no-install): linked node_modules'));
});

await test('an install stage that throws is only a warning', async (t) => {
    const f = makeInstallFixture(t);
    const nowMs = (): number => {
        throw new Error('clock broke');
    };
    const target = path.join(f.root, 'app-inst-3');
    assert.equal(okPath(await runWith(f, ['--suffix', 'inst-3'], { nowMs })), target);
    assert.ok(logged(f, 'warn cannot install dependencies: clock broke'), f.deps.lines.join('\n'));
});

await test('a thrown value that cannot become text is an unknown install warning', async (t) => {
    const f = makeInstallFixture(t);
    const nowMs = (): number => {
        throw Object.create(null);
    };
    const target = path.join(f.root, 'app-inst-4');
    assert.equal(okPath(await runWith(f, ['--suffix', 'inst-4'], { nowMs })), target);
    assert.ok(logged(f, 'warn cannot install dependencies: unknown error'), f.deps.lines.join('\n'));
});

await test('a failing ignored-files listing skips the install stage with one warning', async (t) => {
    const f = makeInstallFixture(t);
    const failed = { code: 128, stdout: '', stderr: 'fatal: broken' };
    const runner = recording(withOverride(f.deps.runner, (request) => request.args.includes('ls-files'), failed));
    f.deps.runner = runner;
    const warning = 'warn cannot install dependencies: the ignored files of the main clone could not be listed';
    for (const argv of [
        ['--suffix', 'inst-5'],
        ['--suffix', 'inst-6', '--no-install'],
    ]) {
        const target = okPath(await runWith(f, argv, {}));
        assert.equal(fs.lstatSync(path.join(target, 'node_modules'), { throwIfNoEntry: false }), undefined);
    }
    assert.equal(f.deps.lines.filter((line) => line.includes(warning)).length, 2, f.deps.lines.join('\n'));
    assert.equal(logged(f, 'installs skipped'), false, f.deps.lines.join('\n'));
    assert.deepEqual(
        runner.calls.filter((request) => path.basename(request.file) === 'npm'),
        []
    );
});

await test('an undefined timing value keeps its default', async (t) => {
    const f = makeInstallFixture(t);
    const timing = { phaseMs: undefined, progressMs: undefined, networkTimeoutMs: undefined };
    const target = okPath(await runWith(f, ['--suffix', 'inst-7'], { timing }));
    assert.deepEqual(fs.readdirSync(path.join(target, 'node_modules')), ['from-stub'], f.deps.lines.join('\n'));
});
