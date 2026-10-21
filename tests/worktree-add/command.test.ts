import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { runWorktreeAdd, type CommandIo } from '../../src/worktree-add/command.ts';
import { SANDBOX_NETWORK_VARIABLE } from '../../src/worktree-add/installStage.ts';
import { createProcessRunner } from '../../src/worktree-add/proc.ts';
import type { CloneGate, CommandRequest, CommandRunner, Deps, Env, Outcome } from '../../src/worktree-add/types.ts';

import { testDeps } from './support/deps.ts';
import { commitFile, gitSync, makeRepo, testEnv } from './support/git.ts';
import { recording, withOverride, withoutCow } from './support/runners.ts';
import { linkTextOf, makeScenario, messages, runScenario, type Scenario } from './support/scenario.ts';
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

// The first request that matches is rejected with MESSAGE without running; the rest go to inner.
function rejectingFirst(
    inner: CommandRunner,
    match: (_request: CommandRequest) => boolean,
    message: string
): CommandRunner {
    let rejected = false;
    return {
        run: (request) => {
            if (!rejected && match(request)) {
                rejected = true;
                return Promise.reject(new Error(message));
            }
            return inner.run(request);
        },
        terminateAll: () => inner.terminateAll(),
    };
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

function warnLines(f: Fixture): string[] {
    return f.deps.lines.filter((line) => line.includes(' warn '));
}

await test('a failing ignored-files listing still installs from lock files with one warning', async (t) => {
    const f = makeInstallFixture(t);
    const failed = { code: 128, stdout: '', stderr: 'fatal: broken' };
    const isIgnoredListing = (request: CommandRequest): boolean =>
        request.args.includes('ls-files') && request.args.includes('--ignored');
    const runner = recording(withOverride(f.deps.runner, isIgnoredListing, failed));
    f.deps.runner = runner;
    const warning = 'warn cannot list the ignored files of ';
    const installed = okPath(await runWith(f, ['--suffix', 'inst-5'], {}));
    let all = f.deps.lines.join('\n');
    assert.deepEqual(fs.readdirSync(path.join(installed, 'node_modules')), ['from-stub'], all);
    assert.equal(warnLines(f).length, 1, all);
    assert.ok(warnLines(f)[0]?.includes(warning), all);
    assert.equal(logged(f, 'cannot install dependencies'), false, all);
    assert.equal(runner.calls.filter((request) => path.basename(request.file) === 'npm').length, 2, all);

    f.deps.lines.length = 0;
    const skipped = okPath(await runWith(f, ['--suffix', 'inst-6', '--no-install'], {}));
    all = f.deps.lines.join('\n');
    assert.equal(fs.lstatSync(path.join(skipped, 'node_modules'), { throwIfNoEntry: false }), undefined);
    assert.equal(warnLines(f).length, 1, all);
    assert.ok(warnLines(f)[0]?.includes(warning), all);
    assert.equal(logged(f, 'installs skipped'), false, all);
    assert.equal(runner.calls.filter((request) => path.basename(request.file) === 'npm').length, 2, all);
});

await test('an undefined timing value keeps its default', async (t) => {
    const f = makeInstallFixture(t);
    const timing = { phaseMs: undefined, progressMs: undefined, networkTimeoutMs: undefined };
    const target = okPath(await runWith(f, ['--suffix', 'inst-7'], { timing }));
    assert.deepEqual(fs.readdirSync(path.join(target, 'node_modules')), ['from-stub'], f.deps.lines.join('\n'));
});

await test('a sync that throws still installs from lock files and warns once with the thrown message', async (t) => {
    const f = makeInstallFixture(t);
    const runner = recording(
        rejectingFirst(f.deps.runner, (request) => request.args.includes('--ignored'), 'listing broke')
    );
    f.deps.runner = runner;
    const target = okPath(await runWith(f, ['--suffix', 'inst-8'], {}));
    assert.equal(target, path.join(f.root, 'app-inst-8'));
    const all = f.deps.lines.join('\n');
    assert.deepEqual(warnLines(f).length, 1, all);
    assert.ok(
        warnLines(f)[0]?.endsWith(
            'warn cannot sync ignored paths into the worktree: listing broke; ' +
                'the dependency fallback from the main clone is skipped and nested projects are not installed automatically'
        ),
        all
    );
    assert.equal(logged(f, 'cannot install dependencies'), false, all);
    assert.ok(logged(f, 'info installed dependencies with npm in '), all);
    const modules = fs.lstatSync(path.join(target, 'node_modules'));
    assert.ok(modules.isDirectory() && !modules.isSymbolicLink(), all);
    assert.equal(runner.calls.filter((request) => path.basename(request.file) === 'npm').length, 2, all);
});

// Each applied step that is not a new branch from main (reused, existing local, tracked remote) still installs.
await test('the install stage runs for a reused, an existing and a tracked worktree', async (t) => {
    const f = makeInstallFixture(t);
    const reused = okPath(await runWith(f, ['--suffix', 'inst-9'], {}));
    fs.rmSync(path.join(reused, 'node_modules'), { recursive: true, force: true });
    gitSync(f.env, ['-C', f.main, 'branch', 'inst-10', 'main']);
    gitSync(f.env, ['-C', f.main, 'push', '--quiet', 'origin', 'main:refs/heads/inst-11']);
    gitSync(f.env, ['-C', f.main, 'fetch', '--quiet', 'origin']);
    const cases = [
        { suffix: 'inst-9', line: `info reusing worktree ${reused}` },
        { suffix: 'inst-10', line: 'info checking out EXISTING local branch inst-10' },
        { suffix: 'inst-11', line: 'tracking origin/inst-11' },
    ];
    for (const { suffix, line } of cases) {
        f.deps.lines.length = 0;
        const target = okPath(await runWith(f, ['--suffix', suffix], {}));
        const all = f.deps.lines.join('\n');
        assert.ok(logged(f, line), all);
        assert.ok(logged(f, 'info installed dependencies with npm in '), all);
        const modules = fs.lstatSync(path.join(target, 'node_modules'));
        assert.ok(modules.isDirectory() && !modules.isSymbolicLink(), all);
        assert.deepEqual(fs.readdirSync(path.join(target, 'node_modules')), ['from-stub']);
    }
});

const IGNORED_IN_LINKED =
    'info --suffix and --parent are ignored inside a linked worktree: only the --link paths are linked';

// A main clone app whose ignored data folder the rules leave unlinked, so only --link links it.
function makeLinkScenario(t: TestContext): Scenario {
    return makeScenario(t, { ignore: 'data/\n', ignored: { 'data/a.txt': 'a\n' } });
}

function ownLinkOf(s: Scenario, worktree: string, rel: string): boolean {
    return linkTextOf(path.join(worktree, rel)) === path.join(s.main, rel);
}

await test('--link inside a linked worktree links only that path and runs nothing else', async (t) => {
    const s = makeLinkScenario(t);
    const target = okPath(await runScenario(s, ['--suffix', 't']));
    assert.equal(linkTextOf(path.join(target, 'data')), undefined);
    s.deps.lines.length = 0;
    assert.equal(okPath(await runScenario(s, ['--link', 'data'], target)), target);
    assert.ok(ownLinkOf(s, target, 'data'));
    assert.deepEqual(messages(s), ['info linked data']);
});

await test('--link from the main clone links in the same run', async (t) => {
    const s = makeLinkScenario(t);
    const target = okPath(await runScenario(s, ['--suffix', 't', '--link', 'data']));
    assert.equal(target, path.join(s.root, 'app-t'));
    assert.ok(ownLinkOf(s, target, 'data'));
    assert.ok(messages(s).includes('info linked data'), messages(s).join('\n'));
});

await test('--suffix with --link inside a linked worktree is ignored and creates no worktree', async (t) => {
    const s = makeLinkScenario(t);
    const target = okPath(await runScenario(s, ['--suffix', 't']));
    const before = fs.readdirSync(s.root).toSorted();
    s.deps.lines.length = 0;
    assert.equal(okPath(await runScenario(s, ['--suffix', 'other', '--link', 'data'], target)), target);
    assert.deepEqual(messages(s), [IGNORED_IN_LINKED, 'info linked data']);
    assert.deepEqual(fs.readdirSync(s.root).toSorted(), before);
    assert.ok(ownLinkOf(s, target, 'data'));
});

await test('a run without --link inside a linked worktree links nothing', async (t) => {
    const s = makeLinkScenario(t);
    const target = okPath(await runScenario(s, ['--suffix', 't']));
    s.deps.lines.length = 0;
    assert.equal(okPath(await runScenario(s, ['--suffix', 'other'], target)), target);
    assert.deepEqual(messages(s), [
        `info already in the worktree ${target}: no new worktree is created; run it from the main working tree ${s.main} to create one`,
    ]);
    assert.equal(linkTextOf(path.join(target, 'data')), undefined);
});

await test('--link alone from the main clone still needs --suffix', async (t) => {
    const s = makeLinkScenario(t);
    const before = fs.readdirSync(s.root).toSorted();
    assert.deepEqual(await runScenario(s, ['--link', 'data']), {
        kind: 'usage',
        message: '--suffix SUFFIX is required',
    });
    assert.deepEqual(fs.readdirSync(s.root).toSorted(), before);
});

await test('--link inside a linked worktree of a bare repository is refused', async (t) => {
    const s = makeLinkScenario(t);
    const hubTree = path.join(s.root, 'hub-tree');
    gitSync(s.env, ['-C', path.join(s.root, 'origin.git'), 'worktree', 'add', '--quiet', hubTree, 'main']);
    const real = fs.realpathSync.native(hubTree);
    assert.deepEqual(await runScenario(s, ['--link', 'data'], real), {
        kind: 'refused',
        reason: 'cannot use --link here: the main working tree of this repository was not found',
    });
    assert.equal(linkTextOf(path.join(real, 'data')), undefined);
});

await test('--link of a path missing from the main clone inside a linked worktree only warns', async (t) => {
    const s = makeLinkScenario(t);
    const target = okPath(await runScenario(s, ['--suffix', 't']));
    s.deps.lines.length = 0;
    assert.equal(okPath(await runScenario(s, ['--link', 'missing'], target)), target);
    assert.deepEqual(messages(s), ['warn not linked with --link: missing does not exist in the main clone']);
    assert.equal(fs.existsSync(path.join(target, 'missing')), false);
});

await test('a repeated --link inside a linked worktree names nothing again', async (t) => {
    const s = makeLinkScenario(t);
    const target = okPath(await runScenario(s, ['--suffix', 't']));
    okPath(await runScenario(s, ['--link', 'data'], target));
    s.deps.lines.length = 0;
    assert.equal(okPath(await runScenario(s, ['--link', 'data'], target)), target);
    assert.deepEqual(messages(s), []);
    assert.ok(ownLinkOf(s, target, 'data'));
});

await test('--parent with --link inside a linked worktree is ignored once and creates nothing else', async (t) => {
    const s = makeLinkScenario(t);
    const target = okPath(await runScenario(s, ['--suffix', 't']));
    const before = fs.readdirSync(s.root).toSorted();
    const targetBefore = fs.readdirSync(target).toSorted();
    s.deps.lines.length = 0;
    assert.equal(okPath(await runScenario(s, ['--parent', '../x', '--link', 'data'], target)), target);
    assert.deepEqual(messages(s), [IGNORED_IN_LINKED, 'info linked data']);
    assert.deepEqual(fs.readdirSync(s.root).toSorted(), before);
    assert.deepEqual(fs.readdirSync(target).toSorted(), [...targetBefore, 'data'].toSorted());
    assert.ok(ownLinkOf(s, target, 'data'));
});

await test('--no-install with --link from the main clone links the path and installs nothing', async (t) => {
    const f = makeInstallFixture(t);
    fs.appendFileSync(path.join(f.main, '.git', 'info', 'exclude'), 'data/\n');
    fs.mkdirSync(path.join(f.main, 'data'));
    fs.writeFileSync(path.join(f.main, 'data', 'a.txt'), 'a\n');
    const runner = recording(f.deps.runner);
    f.deps.runner = runner;
    const target = okPath(await runWith(f, ['--suffix', 't', '--no-install', '--link', 'data'], {}));
    const all = f.deps.lines.join('\n');
    assert.equal(linkTextOf(path.join(target, 'data')), path.join(f.main, 'data'), all);
    assert.equal(fs.readlinkSync(path.join(target, 'node_modules')), path.join(f.main, 'node_modules'), all);
    assert.ok(logged(f, 'info installs skipped (--no-install): linked node_modules'), all);
    assert.equal(runner.calls.filter((request) => path.basename(request.file) === 'npm').length, 0, all);
});

await test('--suffix with --link inside a linked worktree of a bare repository is refused without the ignored line', async (t) => {
    const s = makeLinkScenario(t);
    const hubTree = path.join(s.root, 'hub-tree');
    gitSync(s.env, ['-C', path.join(s.root, 'origin.git'), 'worktree', 'add', '--quiet', hubTree, 'main']);
    const real = fs.realpathSync.native(hubTree);
    s.deps.lines.length = 0;
    assert.deepEqual(await runScenario(s, ['--suffix', 'x', '--link', 'data'], real), {
        kind: 'refused',
        reason: 'cannot use --link here: the main working tree of this repository was not found',
    });
    assert.equal(messages(s).includes(IGNORED_IN_LINKED), false, messages(s).join('\n'));
    assert.equal(linkTextOf(path.join(real, 'data')), undefined);
});

await test('--link outside any git repository is refused, not a usage error', async (t) => {
    const s = makeLinkScenario(t);
    const outside = path.join(s.root, 'outside');
    fs.mkdirSync(outside);
    assert.deepEqual(await runScenario(s, ['--link', 'data'], outside), {
        kind: 'refused',
        reason: `not a git repository: ${outside}`,
    });
});
