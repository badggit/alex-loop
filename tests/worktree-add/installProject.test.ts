import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import type { AssignedProject } from '../../src/worktree-add/assign.ts';
import {
    installProject,
    projectCommand,
    targetFolders,
    type ProjectContext,
} from '../../src/worktree-add/installProject.ts';
import { lstatOrUndefined } from '../../src/worktree-add/paths.ts';
import { PARTIAL_MARKER, privateDir, readPartialMarks } from '../../src/worktree-add/privateArea.ts';
import { createProcessRunner } from '../../src/worktree-add/proc.ts';
import type { CommandRequest, CommandRunner, Env } from '../../src/worktree-add/types.ts';

import { testDeps } from './support/deps.ts';
import { commitFile, gitSync, makeRepo, testEnv } from './support/git.ts';
import { recording, withOverride } from './support/runners.ts';
import { isolatedBin, withPath } from './support/stubManagers.ts';
import { tempRoot } from './support/tmp.ts';
import { writeStubTool } from './support/tools.ts';

const TOKEN = 'npm_secret_value_1234';
const NPM_LOCK = '{"lockfileVersion":3}\n';
const NPM_VERSION = 'case "$1" in --version) echo 10.9.0; exit 0;; esac';
// Enough for the version query on a slow machine, so the install itself is what times out.
const TIMEOUT_MARGIN_MS = 2000;
const OFFLINE_MISS_NPM = 'case "$*" in *--offline*) echo "npm error code ENOTCACHED" >&2; exit 1;; esac';

interface Fixture {
    main: string;
    worktree: string;
    bin: string;
    env: Env;
    deps: ReturnType<typeof testDeps>;
    calls: CommandRequest[];
    ctx: ProjectContext;
}

function rootProject(lockNames: readonly string[] = ['package-lock.json']): AssignedProject {
    return { dir: '', ecosystem: 'js', lockNames, depRels: ['node_modules'], reportOnly: [], auto: true };
}

// A main clone with FILES committed, a linked worktree on branch task and a stub per entry of STUBS on an isolated
// PATH.
async function makeFixture(
    t: TestContext,
    files: Readonly<Record<string, string>>,
    stubs: Readonly<Record<string, string>>
): Promise<Fixture> {
    const root = tempRoot(t);
    const gitEnv = testEnv(root);
    const { main } = makeRepo(root, gitEnv);
    for (const [file, text] of Object.entries(files)) {
        commitFile(gitEnv, main, file, text);
    }
    const worktree = path.join(root, 'app-task');
    gitSync(gitEnv, ['-C', main, 'worktree', 'add', '--quiet', '-b', 'task', worktree]);
    const bin = isolatedBin(root);
    for (const [name, body] of Object.entries(stubs)) {
        writeStubTool(bin, name, body);
    }
    const env: Env = { ...withPath(gitEnv, bin), NPM_TOKEN: TOKEN };
    const runner = recording(createProcessRunner(env));
    t.after(() => runner.terminateAll());
    const deps = testDeps(env, { runner });
    const ctx: ProjectContext = {
        deps,
        env,
        main,
        worktree,
        privateDir: await privateDir(deps, worktree),
        nowMs: () => Date.now(),
        networkTimeoutMs: 30_000,
        progressMs: 60_000,
    };
    return { main, worktree, bin, env, deps, calls: runner.calls, ctx };
}

function npmFixture(t: TestContext, body: string): Promise<Fixture> {
    return makeFixture(
        t,
        { 'package.json': '{"name":"demo"}\n', 'package-lock.json': NPM_LOCK },
        { npm: `${NPM_VERSION}\n${body}` }
    );
}

function markerOf(fixture: Fixture): string[] {
    return readPartialMarks(fixture.ctx.privateDir ?? '');
}

function minuteAhead(): number {
    return Date.now() + 60_000;
}

function linesWith(fixture: Fixture, text: string): string[] {
    return fixture.deps.lines.filter((line) => line.includes(text));
}

function assertNoToken(fixture: Fixture): void {
    for (const line of fixture.deps.lines) {
        assert.ok(!line.includes(TOKEN), `a logged line holds the token: ${line}`);
    }
}

// Every git ls-files call after the first fails, so the listing after the install cannot be taken.
function failingSecondListing(inner: CommandRunner): CommandRunner {
    let listings = 0;
    return {
        run: (request) => {
            if (request.file === 'git' && request.args.includes('ls-files')) {
                listings += 1;
                if (listings > 1) {
                    return Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: index file corrupt\n' });
                }
            }
            return inner.run(request);
        },
        terminateAll: () => inner.terminateAll(),
    };
}

function isListing(request: CommandRequest): boolean {
    return request.file === 'git' && request.args.includes('ls-files');
}

function installCalls(fixture: Fixture): CommandRequest[] {
    return fixture.calls.filter((call) => !call.args.includes('--version') && call.file !== 'git');
}

await test('targetFolders adds the default folder once and projectCommand runs in the project', () => {
    assert.deepEqual(targetFolders(rootProject()), ['node_modules']);
    const workspace: AssignedProject = {
        dir: 'web',
        ecosystem: 'js',
        lockNames: ['pnpm-lock.yaml'],
        depRels: ['web/packages/a/node_modules'],
        reportOnly: [],
        auto: true,
    };
    assert.deepEqual(targetFolders(workspace), ['web/packages/a/node_modules', 'web/node_modules']);
    const api: AssignedProject = {
        dir: 'services/api',
        ecosystem: 'uv',
        lockNames: ['uv.lock'],
        depRels: [],
        reportOnly: [],
        auto: true,
    };
    assert.deepEqual(targetFolders(api), ['services/api/.venv']);
    assert.equal(projectCommand(rootProject(), 'npm ci'), 'npm ci');
    assert.equal(projectCommand(api, 'uv sync --frozen'), 'cd services/api && uv sync --frozen');
});

await test('a successful install leaves the folder, the info line and an empty marker', async (t) => {
    const fixture = await npmFixture(t, 'mkdir -p node_modules/x\nexit 0');
    const outcome = await installProject(fixture.ctx, rootProject(), minuteAhead());
    assert.deepEqual(outcome, { kind: 'installed' });
    assert.equal(
        linesWith(fixture, ' info installed dependencies with npm in ').length,
        1,
        fixture.deps.lines.join('\n')
    );
    assert.match(fixture.deps.lines.join('\n'), / info installed dependencies with npm in \d+\.\d s$/m);
    assert.ok(lstatOrUndefined(path.join(fixture.worktree, 'node_modules', 'x'))?.isDirectory());
    assert.deepEqual(markerOf(fixture), []);
});

await test('an own link at node_modules is unlinked before the install and its target is kept', async (t) => {
    const fixture = await npmFixture(t, 'mkdir -p node_modules/x\nexit 0');
    fs.mkdirSync(path.join(fixture.main, 'node_modules', 'kept'), { recursive: true });
    fs.symlinkSync(path.join(fixture.main, 'node_modules'), path.join(fixture.worktree, 'node_modules'));
    const outcome = await installProject(fixture.ctx, rootProject(), minuteAhead());
    assert.deepEqual(outcome, { kind: 'installed' });
    const installed = lstatOrUndefined(path.join(fixture.worktree, 'node_modules'));
    assert.ok(installed?.isDirectory() === true && !installed.isSymbolicLink());
    assert.deepEqual(fs.readdirSync(path.join(fixture.main, 'node_modules')), ['kept']);
});

await test('a real folder at node_modules blocks the install and stays as it was', async (t) => {
    const fixture = await npmFixture(t, 'mkdir -p node_modules/x\nexit 0');
    fs.mkdirSync(path.join(fixture.worktree, 'node_modules', 'own'), { recursive: true });
    const outcome = await installProject(fixture.ctx, rootProject(), minuteAhead());
    assert.deepEqual(outcome, { kind: 'not-installed' });
    const warning =
        ' warn not installed with npm: node_modules already stands in the worktree and is left as it is ' +
        '(remove it and rerun to install)';
    assert.equal(linesWith(fixture, warning).length, 1, fixture.deps.lines.join('\n'));
    assert.deepEqual(fs.readdirSync(path.join(fixture.worktree, 'node_modules')), ['own']);
    assert.deepEqual(installCalls(fixture), []);
});

await test('a marked leftover from an earlier run is removed and the install runs', async (t) => {
    const fixture = await npmFixture(t, 'mkdir -p node_modules/x\nexit 0');
    fs.mkdirSync(path.join(fixture.worktree, 'node_modules', 'stale'), { recursive: true });
    fs.writeFileSync(path.join(fixture.ctx.privateDir ?? '', PARTIAL_MARKER), 'node_modules\n');
    const outcome = await installProject(fixture.ctx, rootProject(), minuteAhead());
    assert.deepEqual(outcome, { kind: 'installed' });
    assert.deepEqual(fs.readdirSync(path.join(fixture.worktree, 'node_modules')), ['x']);
    assert.deepEqual(markerOf(fixture), []);
});

await test('a missing tool gives tool-missing and creates nothing', async (t) => {
    const fixture = await makeFixture(t, { 'package.json': '{}\n', 'package-lock.json': NPM_LOCK }, {});
    const before = fixture.deps.lines.length;
    const outcome = await installProject(fixture.ctx, rootProject(), minuteAhead());
    assert.deepEqual(outcome, { kind: 'tool-missing', manager: 'npm' });
    assert.equal(fixture.deps.lines.length, before);
    assert.equal(lstatOrUndefined(path.join(fixture.worktree, 'node_modules')), undefined);
    assert.equal(lstatOrUndefined(path.join(fixture.ctx.privateDir ?? '', PARTIAL_MARKER)), undefined);
});

await test('yarn 1 for a berry lock gives the wrong-version group and no install', async (t) => {
    const fixture = await makeFixture(
        t,
        { 'package.json': '{}\n', 'yarn.lock': '__metadata:\n  version: 8\n' },
        { yarn: 'echo 1.22.22\nexit 0' }
    );
    const outcome = await installProject(fixture.ctx, rootProject(['yarn.lock']), minuteAhead());
    assert.deepEqual(outcome, { kind: 'not-installed' });
    const headline = linesWith(fixture, 'cannot install dependencies with yarn: wrong manager version');
    assert.equal(headline.length, 1, fixture.deps.lines.join('\n'));
    assert.match(headline[0] ?? '', /expected yarn 2 or newer, found 1\.22\.22/);
    assert.equal(linesWith(fixture, 'enable corepack or install the named version').length, 1);
    assert.ok(!fixture.calls.some((call) => call.args.includes('install')));
});

await test('two lock kinds without packageManager give the conflict warning', async (t) => {
    const fixture = await makeFixture(
        t,
        { 'package.json': '{}\n', 'package-lock.json': NPM_LOCK, 'yarn.lock': '# yarn lockfile v1\n' },
        { npm: 'exit 0' }
    );
    const outcome = await installProject(fixture.ctx, rootProject(['package-lock.json', 'yarn.lock']), minuteAhead());
    assert.deepEqual(outcome, { kind: 'not-installed' });
    const warning = linesWith(
        fixture,
        ' warn cannot install dependencies in the worktree root: several package managers'
    );
    assert.equal(warning.length, 1, fixture.deps.lines.join('\n'));
    assert.deepEqual(
        fixture.calls.filter((call) => call.file !== 'git'),
        []
    );
});

await test('a failed install is cleaned up, logged with the masked output and reported in four lines', async (t) => {
    const body = [
        'mkdir -p node_modules/partial',
        'echo "npm error code E401" >&2',
        'echo "npm error Unable to authenticate with token $NPM_TOKEN" >&2',
        'exit 1',
    ].join('\n');
    const fixture = await npmFixture(t, body);
    const outcome = await installProject(fixture.ctx, rootProject(), minuteAhead());
    assert.deepEqual(outcome, { kind: 'failed' });
    const index = fixture.deps.lines.findIndex((line) =>
        line.includes(' warn cannot install dependencies with npm: authentication failed (npm error code E401')
    );
    assert.notEqual(index, -1, fixture.deps.lines.join('\n'));
    const group = fixture.deps.lines.slice(index, index + 4);
    assert.match(group[1] ?? '', /node_modules is left missing/);
    assert.match(
        group[2] ?? '',
        /to install: log in to the registry or refresh the token, then run in the worktree: npm ci$/
    );
    const logFile = path.join(fixture.ctx.privateDir ?? '', 'alex-loop-install-npm.log');
    assert.match(group[3] ?? '', new RegExp(`full npm output: ${logFile}$`));
    assert.equal(fixture.deps.lines.length, index + 4);
    assert.equal(lstatOrUndefined(path.join(fixture.worktree, 'node_modules')), undefined);
    assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);
    const logged = fs.readFileSync(logFile, 'utf8');
    assert.match(logged, /token \*\*\*/);
    assert.ok(!logged.includes(TOKEN));
    assertNoToken(fixture);
    assert.deepEqual(markerOf(fixture), []);
});

await test('a failed install removes the node_modules it made and keeps a file the user wrote meanwhile', async (t) => {
    const fixture = await npmFixture(t, 'mkdir -p node_modules/partial\necho draft > notes.txt\nexit 1');
    const outcome = await installProject(fixture.ctx, rootProject(), minuteAhead());
    assert.deepEqual(outcome, { kind: 'failed' });
    assert.equal(lstatOrUndefined(path.join(fixture.worktree, 'node_modules')), undefined);
    assert.equal(fs.readFileSync(path.join(fixture.worktree, 'notes.txt'), 'utf8'), 'draft\n');
    assert.deepEqual(linesWith(fixture, 'remove it with'), []);
    assert.deepEqual(markerOf(fixture), []);
});

await test('a cleanup that cannot finish warns with a removal command and keeps the leftover marked', async (t) => {
    if (process.getuid?.() === 0) {
        t.skip('root can remove a folder with mode 0500');
        return;
    }
    const body = [
        'mkdir -p node_modules/locked',
        'touch node_modules/locked/file',
        'chmod 500 node_modules/locked',
        'exit 1',
    ];
    const fixture = await npmFixture(t, body.join('\n'));
    const locked = path.join(fixture.worktree, 'node_modules', 'locked');
    try {
        const outcome = await installProject(fixture.ctx, rootProject(), minuteAhead());
        assert.deepEqual(outcome, { kind: 'failed' });
        const warning = linesWith(fixture, ' warn cannot remove the partial install: ');
        assert.equal(warning.length, 1, fixture.deps.lines.join('\n'));
        assert.match(warning[0] ?? '', /; remove it with: rm -rf -- '.*\/node_modules'$/);
        assert.deepEqual(markerOf(fixture), ['node_modules']);
    } finally {
        if (lstatOrUndefined(locked) !== undefined) {
            fs.chmodSync(locked, 0o700);
        }
    }
});

await test('a listing that fails after the install warns how to check the project and marks nothing', async (t) => {
    const fixture = await npmFixture(t, 'mkdir -p node_modules/partial\ntouch stray.txt\nexit 1');
    const ctx: ProjectContext = {
        ...fixture.ctx,
        deps: { ...fixture.deps, runner: failingSecondListing(fixture.deps.runner) },
    };
    const outcome = await installProject(ctx, rootProject(), minuteAhead());
    assert.deepEqual(outcome, { kind: 'failed' });
    const all = fixture.deps.lines.join('\n');
    const warning = linesWith(fixture, ' warn cannot list what the install created in ');
    assert.equal(warning.length, 1, all);
    assert.ok(
        warning[0]?.endsWith(
            `cannot list what the install created in ${fixture.worktree} (fatal: index file corrupt); ` +
                `check it with: git -C '${fixture.worktree}' status --ignored`
        ),
        warning[0]
    );
    assert.deepEqual(linesWith(fixture, 'remove it with'), []);
    assert.equal(lstatOrUndefined(path.join(fixture.worktree, 'node_modules')), undefined);
    assert.deepEqual(markerOf(fixture), []);
});

await test('a target inside a folder that was untracked before is still removed by name', async (t) => {
    const fixture = await npmFixture(t, 'mkdir -p vendor/node_modules/x\nexit 1');
    fs.mkdirSync(path.join(fixture.worktree, 'vendor'));
    fs.writeFileSync(path.join(fixture.worktree, 'vendor', 'own.txt'), 'own\n');
    const project: AssignedProject = { ...rootProject(), depRels: ['vendor/node_modules'] };
    const outcome = await installProject(fixture.ctx, project, minuteAhead());
    assert.deepEqual(outcome, { kind: 'failed' });
    assert.equal(lstatOrUndefined(path.join(fixture.worktree, 'vendor', 'node_modules')), undefined);
    assert.deepEqual(fs.readdirSync(path.join(fixture.worktree, 'vendor')), ['own.txt']);
    assert.deepEqual(markerOf(fixture), []);
});

await test('a timeout after a lifecycle header names the last step seen', async (t) => {
    const fixture = await npmFixture(t, 'echo "> demo@1.0.0 postinstall"\nsleep 30');
    const outcome = await installProject(fixture.ctx, rootProject(), fixture.ctx.nowMs() + TIMEOUT_MARGIN_MS);
    assert.deepEqual(outcome, { kind: 'failed' });
    assert.equal(linesWith(fixture, 'cannot install dependencies with npm: timed out').length, 1);
    assert.equal(linesWith(fixture, ' warn last step seen: postinstall of demo@1.0.0').length, 1);
});

await test('a silent timeout carries the dropped-packets hint', async (t) => {
    const fixture = await npmFixture(t, 'sleep 30');
    const outcome = await installProject(fixture.ctx, rootProject(), fixture.ctx.nowMs() + TIMEOUT_MARGIN_MS);
    assert.deepEqual(outcome, { kind: 'failed' });
    assert.equal(linesWith(fixture, 'cannot install dependencies with npm: timed out').length, 1);
    assert.equal(linesWith(fixture, 'often a network that silently drops packets (VPN or proxy)').length, 1);
});

await test('an install that rewrites the lock file fails and the lock is restored', async (t) => {
    const fixture = await npmFixture(t, 'echo "{}" > package-lock.json\nexit 0');
    const outcome = await installProject(fixture.ctx, rootProject(), minuteAhead());
    assert.deepEqual(outcome, { kind: 'failed' });
    assert.equal(linesWith(fixture, 'npm: the install changed the lock file').length, 1, fixture.deps.lines.join('\n'));
    assert.equal(fs.readFileSync(path.join(fixture.worktree, 'package-lock.json'), 'utf8'), NPM_LOCK);
});

await test('the online attempt after an offline miss decides the class and the log holds both', async (t) => {
    const fixture = await npmFixture(t, `${OFFLINE_MISS_NPM}\necho "npm error code E401" >&2\nexit 1`);
    const outcome = await installProject(fixture.ctx, rootProject(), minuteAhead());
    assert.deepEqual(outcome, { kind: 'failed' });
    const headline = linesWith(fixture, 'cannot install dependencies with npm: authentication failed');
    assert.equal(headline.length, 1, fixture.deps.lines.join('\n'));
    assert.match(headline[0] ?? '', /\(npm error code E401\)$/);
    const logged = fs.readFileSync(path.join(fixture.ctx.privateDir ?? '', 'alex-loop-install-npm.log'), 'utf8');
    assert.match(logged, /ENOTCACHED/);
    assert.match(logged, /E401/);
});

await test('a version query that prints only the token is a wrong version and the token is never logged', async (t) => {
    const fixture = await makeFixture(
        t,
        { 'package.json': '{}\n', 'package-lock.json': NPM_LOCK },
        { npm: 'echo "$NPM_TOKEN"\nexit 0' }
    );
    const outcome = await installProject(fixture.ctx, rootProject(), minuteAhead());
    assert.deepEqual(outcome, { kind: 'not-installed' });
    assert.equal(linesWith(fixture, 'cannot install dependencies with npm: wrong manager version').length, 1);
    assertNoToken(fixture);
});

await test('a version query that fails with the token on stderr never logs the token', async (t) => {
    const fixture = await makeFixture(
        t,
        { 'package.json': '{}\n', 'package-lock.json': NPM_LOCK },
        { npm: 'echo "bad $NPM_TOKEN" >&2\nexit 2' }
    );
    const outcome = await installProject(fixture.ctx, rootProject(), minuteAhead());
    assert.deepEqual(outcome, { kind: 'not-installed' });
    assert.equal(linesWith(fixture, 'found unknown (--version exited with code 2: bad ***)').length, 1);
    assertNoToken(fixture);
});

await test('a hanging version query settles at the project deadline as a wrong version', async (t) => {
    const fixture = await makeFixture(
        t,
        { 'package.json': '{}\n', 'package-lock.json': NPM_LOCK },
        { npm: 'exec sleep 60' }
    );
    const started = performance.now();
    const outcome = await installProject(fixture.ctx, rootProject(), fixture.ctx.nowMs() + 300);
    assert.ok(performance.now() - started < 11_000);
    assert.deepEqual(outcome, { kind: 'not-installed' });
    const headline = linesWith(fixture, 'cannot install dependencies with npm: wrong manager version');
    assert.equal(headline.length, 1, fixture.deps.lines.join('\n'));
    assert.match(headline[0] ?? '', /found unknown \(/);
});

await test('no time left skips the version query and reports a timeout', async (t) => {
    const fixture = await npmFixture(t, 'exit 0');
    const outcome = await installProject(fixture.ctx, rootProject(), fixture.ctx.nowMs() - 1);
    assert.deepEqual(outcome, { kind: 'not-installed' });
    assert.equal(linesWith(fixture, 'cannot install dependencies with npm: timed out').length, 1);
    assert.deepEqual(installCalls(fixture), []);
    assert.ok(!fixture.calls.some((call) => call.args.includes('--version')));
});

await test('a marked leftover that cannot be removed blocks the install with a removal command', async (t) => {
    if (process.getuid?.() === 0) {
        t.skip('root can remove a folder with mode 0500');
        return;
    }
    const fixture = await npmFixture(t, 'mkdir -p node_modules/x\nexit 0');
    const locked = path.join(fixture.worktree, 'node_modules', 'locked');
    fs.mkdirSync(locked, { recursive: true });
    fs.writeFileSync(path.join(locked, 'file'), 'stale\n');
    fs.chmodSync(locked, 0o500);
    fs.writeFileSync(path.join(fixture.ctx.privateDir ?? '', PARTIAL_MARKER), 'node_modules\n');
    try {
        const outcome = await installProject(fixture.ctx, rootProject(), minuteAhead());
        assert.deepEqual(outcome, { kind: 'not-installed' });
        const warning = linesWith(
            fixture,
            ' warn not installed with npm: cannot remove the partial install of an earlier run: '
        );
        assert.equal(warning.length, 1, fixture.deps.lines.join('\n'));
        assert.ok(
            warning[0]?.endsWith(`; remove it with: rm -rf -- '${path.join(fixture.worktree, 'node_modules')}'`),
            warning[0]
        );
        assert.deepEqual(installCalls(fixture), []);
        assert.deepEqual(markerOf(fixture), ['node_modules']);
    } finally {
        fs.chmodSync(locked, 0o700);
    }
});

await test('untracked entries that cannot be listed before the install give not-installed', async (t) => {
    const fixture = await npmFixture(t, 'mkdir -p node_modules/x\nexit 0');
    const failed = { code: 128, stdout: '', stderr: 'fatal: index file corrupt\n' };
    const ctx: ProjectContext = {
        ...fixture.ctx,
        deps: { ...fixture.deps, runner: withOverride(fixture.deps.runner, isListing, failed) },
    };
    const outcome = await installProject(ctx, rootProject(), minuteAhead());
    assert.deepEqual(outcome, { kind: 'not-installed' });
    const warning = linesWith(fixture, ' warn not installed with npm: cannot list the untracked entries of ');
    assert.equal(warning.length, 1, fixture.deps.lines.join('\n'));
    assert.ok(warning[0]?.endsWith(`cannot list the untracked entries of ${fixture.worktree}`), warning[0]);
    assert.deepEqual(installCalls(fixture), []);
    assert.equal(lstatOrUndefined(path.join(fixture.worktree, 'node_modules')), undefined);
    assert.deepEqual(markerOf(fixture), []);
});

await test('a lock file that cannot be restored after the install gets its own warning', async (t) => {
    if (process.getuid?.() === 0) {
        t.skip('root can write a file with mode 0444');
        return;
    }
    const fixture = await npmFixture(t, 'echo "{}" > package-lock.json\nchmod 444 package-lock.json\nexit 0');
    const lock = path.join(fixture.worktree, 'package-lock.json');
    try {
        const outcome = await installProject(fixture.ctx, rootProject(), minuteAhead());
        assert.deepEqual(outcome, { kind: 'failed' });
        const warning = linesWith(fixture, ' warn cannot restore the lock file after npm: ');
        assert.equal(warning.length, 1, fixture.deps.lines.join('\n'));
        assert.ok(warning[0]?.includes(`${lock}: `), warning[0]);
        assert.equal(linesWith(fixture, 'npm: the install changed the lock file').length, 1);
        assert.equal(fs.readFileSync(lock, 'utf8'), '{}\n');
    } finally {
        fs.chmodSync(lock, 0o644);
    }
});
