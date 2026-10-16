import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { createCloneGate } from '../../src/worktree-add/cowGate.ts';
import {
    DEFAULT_TIMING,
    runInstallStage,
    SANDBOX_NETWORK_VARIABLE,
    type InstallStageRequest,
    type InstallTiming,
} from '../../src/worktree-add/installStage.ts';
import { createProcessRunner } from '../../src/worktree-add/proc.ts';
import { createTransfer } from '../../src/worktree-add/transfer.ts';
import type { CommandRequest, CommandRunner, Env } from '../../src/worktree-add/types.ts';

import { testDeps } from './support/deps.ts';
import { commitFile, gitSync, makeRepo, testEnv } from './support/git.ts';
import { recording, withOverride, withoutCow } from './support/runners.ts';
import { isolatedBin, withPath } from './support/stubManagers.ts';
import { tempRoot } from './support/tmp.ts';
import { writeStubTool } from './support/tools.ts';

const LOG_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z (info|warn|error) (.*)$/u;
const NPM_LOCK = '{"lockfileVersion":3}\n';
const PNPM_LOCK = "lockfileVersion: '9.0'\n";
const YARN_LOCK = '# yarn lockfile v1\n';
const NPM_STUB = 'case "$1" in --version) echo 10.9.0; exit 0;; esac\nmkdir -p node_modules\nexit 0';
const UV_STUB = 'case "$1" in --version) echo "uv 0.5.0"; exit 0;; esac\nmkdir -p .venv\nexit 0';
const YARN_STUB = 'case "$1" in --version) echo 1.22.19; exit 0;; esac\nmkdir -p node_modules\nexit 0';
const TIMING: InstallTiming = { phaseMs: 60_000, progressMs: 60_000, networkTimeoutMs: 30_000 };
const MANAGERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun', 'uv']);
const ROOT_NPM = { 'package.json': '{"name":"demo"}\n', 'package-lock.json': NPM_LOCK };
const NPM_CONFIG_STUB = 'case "$1" in --version) echo 10.9.0; exit 0;; esac\ngit config core.hooksPath x\nexit 0';
const NPM_CONFIG_FAIL_STUB = 'case "$1" in --version) echo 10.9.0; exit 0;; esac\ngit config core.hooksPath x\nexit 1';
const NOT_REVERTED = 'cannot read the shared repository config; changes made by installs to it are not reverted';

interface Logged {
    level: string;
    text: string;
}

interface Fixture {
    root: string;
    main: string;
    worktree: string;
    bin: string;
    deps: ReturnType<typeof testDeps>;
    calls: CommandRequest[];
    request: InstallStageRequest;
}

interface FixtureOptions {
    files: Readonly<Record<string, string>>;
    stubs: Readonly<Record<string, string>>;
    mainFolders: readonly string[];
    depRels: readonly string[];
    noInstall?: boolean;
    extraEnv?: Env;
    timing?: InstallTiming;
    startedMs?: number;
    nowMs?: () => number;
    wrap?: (_inner: CommandRunner) => CommandRunner;
}

// A main clone with FILES committed and MAIN_FOLDERS present (untracked), a linked worktree on branch task and the
// stubs on an isolated PATH; cloning always fails, so dependency folders are linked. WRAP sits between the recording
// runner and the real one.
function makeFixture(t: TestContext, options: FixtureOptions): Fixture {
    const root = tempRoot(t);
    const gitEnv = testEnv(root);
    const { main } = makeRepo(root, gitEnv);
    for (const [file, text] of Object.entries(options.files)) {
        commitFile(gitEnv, main, file, text);
    }
    for (const rel of options.mainFolders) {
        fs.mkdirSync(path.join(main, rel, 'pkg'), { recursive: true });
        fs.writeFileSync(path.join(main, rel, 'pkg', 'index.js'), `${rel}\n`);
    }
    const worktree = path.join(root, 'app-task');
    gitSync(gitEnv, ['-C', main, 'worktree', 'add', '--quiet', '-b', 'task', worktree]);
    const bin = isolatedBin(root);
    for (const [name, body] of Object.entries(options.stubs)) {
        writeStubTool(bin, name, body);
    }
    const env: Env = { ...withPath(gitEnv, bin), ...options.extraEnv };
    const real = withoutCow(createProcessRunner(env));
    const runner = recording(options.wrap === undefined ? real : options.wrap(real));
    t.after(() => runner.terminateAll());
    const deps = testDeps(env, { runner });
    const transfer = createTransfer(deps, { main, worktree, gate: createCloneGate() });
    const request: InstallStageRequest = {
        deps,
        env,
        main,
        worktree,
        depRels: options.depRels,
        noInstall: options.noInstall ?? false,
        transfer,
        startedMs: options.startedMs ?? Date.now(),
        nowMs: options.nowMs ?? (() => Date.now()),
        timing: options.timing ?? TIMING,
    };
    return { root, main, worktree, bin, deps, calls: runner.calls, request };
}

function logged(fixture: Fixture): Logged[] {
    return fixture.deps.lines.map((line) => {
        const match = LOG_LINE.exec(line);
        return { level: match?.[1] ?? 'unformatted', text: match?.[2] ?? line };
    });
}

function infos(fixture: Fixture): string[] {
    return logged(fixture)
        .filter((line) => line.level === 'info')
        .map((line) => line.text);
}

function warnings(fixture: Fixture): string[] {
    return logged(fixture)
        .filter((line) => line.level === 'warn')
        .map((line) => line.text);
}

function dump(fixture: Fixture): string {
    return fixture.deps.lines.join('\n');
}

function managerCalls(fixture: Fixture): CommandRequest[] {
    return fixture.calls.filter((call) => MANAGERS.has(path.basename(call.file)));
}

function linkText(file: string): string | undefined {
    try {
        return fs.readlinkSync(file);
    } catch {
        return;
    }
}

function assertOwnLink(fixture: Fixture, rel: string): void {
    assert.equal(linkText(path.join(fixture.worktree, rel)), path.join(fixture.main, rel), dump(fixture));
}

function sharedExclude(fixture: Fixture): string {
    return fs.readFileSync(path.join(fixture.main, '.git', 'info', 'exclude'), 'utf8');
}

function sharedConfig(fixture: Fixture): string {
    return gitSync(testEnv(fixture.root), ['config', '--file', path.join(fixture.main, '.git', 'config'), '--list']);
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

// Every pid a sleeping stub wrote to PIDS_DIR must be gone once the stage has settled.
function assertNoSleepers(pidsDir: string): void {
    const files = fs.existsSync(pidsDir) ? fs.readdirSync(pidsDir) : [];
    for (const file of files) {
        const pid = Number(fs.readFileSync(path.join(pidsDir, file), 'utf8').trim());
        assert.ok(!isAlive(pid), `the stub process ${String(pid)} outlived the stage`);
    }
}

function isManager(request: CommandRequest): boolean {
    return MANAGERS.has(path.basename(request.file));
}

function isInstall(request: CommandRequest): boolean {
    return isManager(request) && !request.args.includes('--version');
}

// The clock stands still at STARTED_MS until the first manager call, then runs in real time from there, so the
// steps before the install loop take no time from the phase however slow the machine is.
function frozenUntilManager(startedMs: number): {
    nowMs: () => number;
    wrap: (_inner: CommandRunner) => CommandRunner;
} {
    let offsetMs: number | undefined;
    return {
        nowMs: () => (offsetMs === undefined ? startedMs : Date.now() - offsetMs),
        wrap: (inner) => ({
            run: (request) => {
                if (offsetMs === undefined && isManager(request)) {
                    offsetMs = Date.now() - startedMs;
                }
                return inner.run(request);
            },
            terminateAll: () => inner.terminateAll(),
        }),
    };
}

// The first request after an install call has settled rejects, so the stage throws once the manager has run.
function throwAfterInstall(inner: CommandRunner): CommandRunner {
    let state: 'waiting' | 'armed' | 'thrown' = 'waiting';
    return {
        run: async (request) => {
            if (state === 'armed') {
                state = 'thrown';
                throw new Error('runner broke');
            }
            const result = await inner.run(request);
            if (state === 'waiting' && isInstall(request)) {
                state = 'armed';
            }
            return result;
        },
        terminateAll: () => inner.terminateAll(),
    };
}

// Like throwAfterInstall, and the config read that follows (the revert after the project) rejects too.
function throwAndBreakRevert(inner: CommandRunner): CommandRunner {
    const first = throwAfterInstall(inner);
    let installed = false;
    let broken = false;
    return {
        run: (request) => {
            if (isInstall(request)) {
                installed = true;
            }
            if (installed && !broken && request.args[0] === 'config' && request.args.includes('--list')) {
                broken = true;
                return Promise.reject(new Error('config broke'));
            }
            return first.run(request);
        },
        terminateAll: () => inner.terminateAll(),
    };
}

function sleepingStub(version: string, pidsDir: string, name: string): string {
    return [
        `case "$1" in --version) echo "${version}"; exit 0;; esac`,
        `mkdir -p '${pidsDir}'`,
        `echo $$ > '${path.join(pidsDir, name)}'`,
        'exec sleep 30',
    ].join('\n');
}

await test('the default timing and the sandbox switch name', () => {
    assert.equal(SANDBOX_NETWORK_VARIABLE, 'CODEX_SANDBOX_NETWORK_DISABLED');
    assert.deepEqual(DEFAULT_TIMING, { phaseMs: 450_000, progressMs: 30_000, networkTimeoutMs: 30_000 });
});

await test('a root npm project and a uv project install in order; a project without folders is reported', async (t) => {
    const fixture = makeFixture(t, {
        files: {
            ...ROOT_NPM,
            'services/api/uv.lock': 'version = 1\n',
            'examples/demo/package.json': '{"name":"example"}\n',
            'examples/demo/yarn.lock': YARN_LOCK,
        },
        stubs: { npm: NPM_STUB, uv: UV_STUB, yarn: YARN_STUB },
        mainFolders: ['node_modules', 'services/api/.venv'],
        depRels: ['node_modules', 'services/api/.venv'],
    });
    await runInstallStage(fixture.request);
    const installed = infos(fixture).filter((line) => line.startsWith('installed dependencies with '));
    assert.equal(installed.length, 2, dump(fixture));
    assert.match(installed[0] ?? '', /^installed dependencies with npm in /u);
    assert.match(installed[1] ?? '', /^installed dependencies with uv in services\/api in /u);
    assert.ok(
        infos(fixture).includes(
            'not installed automatically: examples/demo ' +
                '(run in the worktree: cd examples/demo && yarn install --frozen-lockfile)'
        ),
        dump(fixture)
    );
    assert.ok(!managerCalls(fixture).some((call) => path.basename(call.file) === 'yarn'));
    assert.ok(fs.statSync(path.join(fixture.worktree, 'node_modules')).isDirectory());
    assert.equal(linkText(path.join(fixture.worktree, 'node_modules')), undefined);
    assert.ok(fs.statSync(path.join(fixture.worktree, 'services', 'api', '.venv')).isDirectory());
    assert.deepEqual(warnings(fixture), []);
    const exclude = new Set(sharedExclude(fixture).split('\n'));
    assert.ok(exclude.has('/node_modules'));
    assert.ok(exclude.has('/services/api/.venv'));
});

await test('a reportOnly Python environment gets the not-automatic line with its uv project', async (t) => {
    const fixture = makeFixture(t, {
        files: { ...ROOT_NPM, 'services/api/uv.lock': 'version = 1\n' },
        stubs: { npm: NPM_STUB, uv: UV_STUB },
        mainFolders: ['services/api/tools/env'],
        depRels: ['services/api/tools/env'],
    });
    await runInstallStage(fixture.request);
    assert.ok(
        infos(fixture).includes(
            'not installed automatically: services/api/tools/env belongs to the uv project in services/api ' +
                '(run in the worktree: cd services/api && uv sync --frozen)'
        ),
        dump(fixture)
    );
});

await test('--no-install links the dependency folders and calls no manager', async (t) => {
    const fixture = makeFixture(t, {
        files: { ...ROOT_NPM, 'uv.lock': 'version = 1\n' },
        stubs: { npm: NPM_STUB, uv: UV_STUB },
        mainFolders: ['node_modules', '.venv'],
        depRels: ['node_modules', '.venv'],
        noInstall: true,
    });
    await runInstallStage(fixture.request);
    assert.deepEqual(managerCalls(fixture), []);
    assertOwnLink(fixture, 'node_modules');
    assertOwnLink(fixture, '.venv');
    assert.deepEqual(infos(fixture), ['installs skipped (--no-install): linked node_modules, .venv']);
    assert.deepEqual(warnings(fixture), []);
});

await test('--no-install without dependency folders says so', async (t) => {
    const fixture = makeFixture(t, {
        files: ROOT_NPM,
        stubs: { npm: NPM_STUB },
        mainFolders: [],
        depRels: [],
        noInstall: true,
    });
    await runInstallStage(fixture.request);
    assert.deepEqual(infos(fixture), ['installs skipped (--no-install): no dependency folders in the main clone']);
});

await test('--no-install leaves a foreign entry at the destination as it is', async (t) => {
    const fixture = makeFixture(t, {
        files: ROOT_NPM,
        stubs: { npm: NPM_STUB },
        mainFolders: ['node_modules'],
        depRels: ['node_modules'],
        noInstall: true,
    });
    fs.writeFileSync(path.join(fixture.worktree, 'node_modules'), 'own\n');
    await runInstallStage(fixture.request);
    assert.deepEqual(infos(fixture), ['installs skipped (--no-install): left as it is node_modules']);
    assert.equal(fs.readFileSync(path.join(fixture.worktree, 'node_modules'), 'utf8'), 'own\n');
});

await test('a disabled sandbox network skips installs, links orphans and names the project commands', async (t) => {
    const fixture = makeFixture(t, {
        files: { ...ROOT_NPM, 'services/api/uv.lock': 'version = 1\n' },
        stubs: { npm: NPM_STUB, uv: UV_STUB },
        mainFolders: ['node_modules', 'services/api/.venv', '.venv'],
        depRels: ['node_modules', 'services/api/.venv', '.venv'],
        extraEnv: { [SANDBOX_NETWORK_VARIABLE]: '1' },
    });
    await runInstallStage(fixture.request);
    assert.deepEqual(managerCalls(fixture), []);
    for (const rel of ['node_modules', 'services/api/.venv']) {
        assert.equal(fs.existsSync(path.join(fixture.worktree, rel)), false, rel);
        assert.equal(linkText(path.join(fixture.worktree, rel)), undefined, rel);
    }
    assertOwnLink(fixture, '.venv');
    assert.deepEqual(infos(fixture), [
        'installs skipped: the network is disabled in this sandbox; dependency folders stay missing; ' +
            'run later in the worktree: npm ci; cd services/api && uv sync --frozen',
    ]);
    const orphan = warnings(fixture);
    assert.equal(orphan.length, 1, dump(fixture));
    assert.match(orphan[0] ?? '', /^not installed: \.venv is a Python environment with no uv\.lock next to it/u);
    assert.match(orphan[0] ?? '', /linked it; do not run installs in this worktree until the link is removed$/u);
});

await test('a disabled sandbox network with only an orphan names no command', async (t) => {
    const fixture = makeFixture(t, {
        files: { 'uv.lock': 'version = 1\n' },
        stubs: { uv: UV_STUB },
        mainFolders: ['node_modules'],
        depRels: ['node_modules'],
        extraEnv: { [SANDBOX_NETWORK_VARIABLE]: '1' },
    });
    await runInstallStage(fixture.request);
    assert.deepEqual(managerCalls(fixture), []);
    assertOwnLink(fixture, 'node_modules');
    assert.deepEqual(infos(fixture), [
        'installs skipped: the network is disabled in this sandbox; dependency folders stay missing; ' +
            'run later in the worktree: uv sync --frozen',
    ]);
    assert.equal(warnings(fixture).filter((line) => line.includes('node_modules')).length, 1, dump(fixture));
});

await test('--no-install wins over the sandbox switch', async (t) => {
    const fixture = makeFixture(t, {
        files: ROOT_NPM,
        stubs: { npm: NPM_STUB },
        mainFolders: ['node_modules'],
        depRels: ['node_modules'],
        noInstall: true,
        extraEnv: { [SANDBOX_NETWORK_VARIABLE]: '1' },
    });
    await runInstallStage(fixture.request);
    assertOwnLink(fixture, 'node_modules');
    assert.deepEqual(infos(fixture), ['installs skipped (--no-install): linked node_modules']);
});

await test('a missing pnpm links node_modules and an orphan venv is linked with its warning', async (t) => {
    const fixture = makeFixture(t, {
        files: { 'package.json': '{"name":"demo"}\n', 'pnpm-lock.yaml': PNPM_LOCK },
        stubs: {},
        mainFolders: ['node_modules', '.venv'],
        depRels: ['node_modules', '.venv'],
    });
    await runInstallStage(fixture.request);
    assertOwnLink(fixture, 'node_modules');
    assertOwnLink(fixture, '.venv');
    const warned = warnings(fixture);
    assert.ok(warned.includes('cannot install dependencies with pnpm: pnpm is not on PATH'), dump(fixture));
    assert.ok(
        warned.includes(
            'to install: install pnpm (or enable corepack), then rerun from the main clone; linked node_modules meanwhile'
        ),
        dump(fixture)
    );
    const orphan = warned.filter((line) => line.includes('.venv'));
    assert.equal(orphan.length, 1, dump(fixture));
    assert.match(orphan[0] ?? '', /no uv\.lock next to it/u);
    assert.match(orphan[0] ?? '', /poetry, pip and pipenv are not installed automatically/u);
    assert.match(orphan[0] ?? '', /linked it; do not run installs in this worktree until the link is removed$/u);
    assert.equal(sharedExclude(fixture).split('\n').includes('/.venv'), true);
});

await test('an orphan node_modules is linked with its reason', async (t) => {
    const fixture = makeFixture(t, {
        files: { 'uv.lock': 'version = 1\n' },
        stubs: { uv: UV_STUB },
        mainFolders: ['node_modules'],
        depRels: ['node_modules'],
    });
    await runInstallStage(fixture.request);
    assertOwnLink(fixture, 'node_modules');
    const orphan = warnings(fixture).filter((line) => line.includes('node_modules'));
    assert.equal(orphan.length, 1, dump(fixture));
    assert.match(orphan[0] ?? '', /belongs to no project with a supported lock file/u);
});

await test('a missing pnpm with a foreign node_modules leaves it as it is', async (t) => {
    const fixture = makeFixture(t, {
        files: { 'package.json': '{"name":"demo"}\n', 'pnpm-lock.yaml': PNPM_LOCK },
        stubs: {},
        mainFolders: ['node_modules'],
        depRels: ['node_modules'],
    });
    fs.writeFileSync(path.join(fixture.worktree, 'node_modules'), 'own\n');
    await runInstallStage(fixture.request);
    assert.ok(
        warnings(fixture).includes(
            'to install: install pnpm (or enable corepack), then rerun from the main clone; ' +
                'node_modules already stand in the worktree and are left as they are'
        ),
        dump(fixture)
    );
    assert.equal(fs.readFileSync(path.join(fixture.worktree, 'node_modules'), 'utf8'), 'own\n');
});

await test('a missing pnpm with nothing in the main clone says nothing to link', async (t) => {
    const fixture = makeFixture(t, {
        files: { 'package.json': '{"name":"demo"}\n', 'pnpm-lock.yaml': PNPM_LOCK },
        stubs: {},
        mainFolders: [],
        depRels: [],
    });
    await runInstallStage(fixture.request);
    assert.ok(
        warnings(fixture).includes(
            'to install: install pnpm (or enable corepack), then rerun from the main clone; ' +
                'nothing to link: node_modules stays missing'
        ),
        dump(fixture)
    );
});

await test('a phase too short to start reports a timeout for every project', async (t) => {
    const pids = path.join(tempRoot(t), 'pids');
    const fixture = makeFixture(t, {
        files: { ...ROOT_NPM, 'services/api/uv.lock': 'version = 1\n' },
        stubs: { npm: sleepingStub('10.9.0', pids, 'npm'), uv: sleepingStub('uv 0.5.0', pids, 'uv') },
        mainFolders: ['services/api/.venv'],
        depRels: ['services/api/.venv'],
        timing: { ...TIMING, phaseMs: 1500 },
    });
    const started = performance.now();
    await runInstallStage(fixture.request);
    assert.ok(performance.now() - started < 15_000);
    const warned = warnings(fixture);
    assert.ok(
        warned.includes('cannot install dependencies with npm: timed out (the install phase ended before it started)'),
        dump(fixture)
    );
    assert.ok(
        warned.includes(
            'cannot install dependencies with uv in services/api: timed out (the install phase ended before it started)'
        ),
        dump(fixture)
    );
    assert.ok(warned.includes('node_modules is left missing: code that needs it fails until it is installed'));
    assertNoSleepers(pids);
});

await test('the first project is killed at its share and the second is not started', async (t) => {
    const startedMs = Date.now();
    const pids = path.join(tempRoot(t), 'pids');
    const fixture = makeFixture(t, {
        files: { ...ROOT_NPM, 'services/api/uv.lock': 'version = 1\n' },
        stubs: { npm: sleepingStub('10.9.0', pids, 'npm'), uv: sleepingStub('uv 0.5.0', pids, 'uv') },
        mainFolders: ['services/api/.venv'],
        depRels: ['services/api/.venv'],
        // 6 s leaves the first project at least MIN_START_MS to start and a 3 s share, after which less than
        // MIN_START_MS is left for the second.
        timing: { ...TIMING, phaseMs: 6000 },
        ...frozenUntilManager(startedMs),
        startedMs,
    });
    const started = performance.now();
    await runInstallStage(fixture.request);
    assert.ok(performance.now() - started < 15_000);
    const warned = warnings(fixture);
    assert.ok(warned.includes('cannot install dependencies with npm: timed out'), dump(fixture));
    assert.ok(
        warned.includes(
            'cannot install dependencies with uv in services/api: timed out (the install phase ended before it started)'
        ),
        dump(fixture)
    );
    assertNoSleepers(pids);
});

await test('a config change made by an install is reverted with one warning', async (t) => {
    const fixture = makeFixture(t, {
        files: ROOT_NPM,
        stubs: { npm: NPM_CONFIG_STUB },
        mainFolders: [],
        depRels: [],
    });
    const before = sharedConfig(fixture);
    await runInstallStage(fixture.request);
    assert.equal(sharedConfig(fixture), before);
    const reverted = warnings(fixture).filter((line) => line.startsWith('reverted core.hookspath'));
    assert.equal(reverted.length, 1, dump(fixture));
});

// The clock throws at its first call, before any project starts, so this covers only the exclude-first order.
await test('exclude patterns are written first, so a link stays out of git status when the stage throws', async (t) => {
    const fixture = makeFixture(t, {
        files: ROOT_NPM,
        stubs: { npm: NPM_STUB },
        mainFolders: ['.venv'],
        depRels: ['.venv'],
        nowMs: () => {
            throw new Error('clock broke');
        },
    });
    await assert.rejects(runInstallStage(fixture.request), /clock broke/u);
    assertOwnLink(fixture, '.venv');
    const status = gitSync(testEnv(fixture.root), ['-C', fixture.worktree, 'status', '--porcelain']);
    assert.equal(status, '');
});

await test('a config change is reverted when the project throws after the manager ran', async (t) => {
    const fixture = makeFixture(t, {
        files: ROOT_NPM,
        stubs: { npm: NPM_CONFIG_FAIL_STUB },
        mainFolders: [],
        depRels: [],
        wrap: throwAfterInstall,
    });
    const before = sharedConfig(fixture);
    await runInstallStage(fixture.request);
    assert.equal(managerCalls(fixture).filter((call) => isInstall(call)).length, 1, dump(fixture));
    assert.equal(sharedConfig(fixture), before);
    const warned = warnings(fixture);
    assert.ok(warned.includes('cannot install dependencies in the worktree root: runner broke'), dump(fixture));
    const reverted = warned.filter((line) => line.startsWith('reverted core.hookspath'));
    assert.equal(reverted.length, 1, dump(fixture));
});

await test('a project that throws is a warning and the next project still installs', async (t) => {
    const fixture = makeFixture(t, {
        files: { ...ROOT_NPM, 'services/api/uv.lock': 'version = 1\n' },
        stubs: { npm: NPM_CONFIG_FAIL_STUB, uv: UV_STUB },
        mainFolders: ['services/api/.venv'],
        depRels: ['services/api/.venv'],
        wrap: throwAfterInstall,
    });
    await runInstallStage(fixture.request);
    assert.ok(
        warnings(fixture).includes('cannot install dependencies in the worktree root: runner broke'),
        dump(fixture)
    );
    assert.ok(
        infos(fixture).some((line) => line.startsWith('installed dependencies with uv in services/api in ')),
        dump(fixture)
    );
    assert.ok(fs.statSync(path.join(fixture.worktree, 'services', 'api', '.venv')).isDirectory());
});

await test('a revert that throws after a project that threw reports both', async (t) => {
    const fixture = makeFixture(t, {
        files: { ...ROOT_NPM, 'services/api/uv.lock': 'version = 1\n' },
        stubs: { npm: NPM_CONFIG_FAIL_STUB, uv: UV_STUB },
        mainFolders: ['services/api/.venv'],
        depRels: ['services/api/.venv'],
        wrap: throwAndBreakRevert,
    });
    await runInstallStage(fixture.request);
    const warned = warnings(fixture);
    assert.ok(warned.includes('cannot install dependencies in the worktree root: runner broke'), dump(fixture));
    assert.ok(
        warned.includes(
            'cannot revert the shared repository config after installing in the worktree root: config broke'
        ),
        dump(fixture)
    );
    assert.ok(
        infos(fixture).some((line) => line.startsWith('installed dependencies with uv in services/api in ')),
        dump(fixture)
    );
});

await test('a nested node_modules outside any workspace does not block the root install in a reused worktree', async (t) => {
    const fixture = makeFixture(t, {
        files: ROOT_NPM,
        stubs: { npm: NPM_STUB },
        mainFolders: ['node_modules', 'tools/x/node_modules'],
        depRels: ['node_modules', 'tools/x/node_modules'],
    });
    const nested = path.join(fixture.worktree, 'tools', 'x', 'node_modules');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'own.txt'), 'own\n');
    await runInstallStage(fixture.request);
    assert.ok(
        infos(fixture).some((line) => line.startsWith('installed dependencies with npm in ')),
        dump(fixture)
    );
    assert.deepEqual(warnings(fixture), [
        'not installed: tools/x/node_modules belongs to no project with a supported lock file; ' +
            'it already stands in the worktree and is left as it is',
    ]);
    assert.equal(fs.readFileSync(path.join(nested, 'own.txt'), 'utf8'), 'own\n');
});

await test('a nested node_modules of a workspace member belongs to the root install', async (t) => {
    const fixture = makeFixture(t, {
        files: { ...ROOT_NPM, 'package.json': '{"name":"demo","workspaces":{"packages":["tools/*"]}}\n' },
        stubs: { npm: NPM_STUB },
        mainFolders: ['node_modules', 'tools/x/node_modules'],
        depRels: ['node_modules', 'tools/x/node_modules'],
    });
    const nested = path.join(fixture.worktree, 'tools', 'x', 'node_modules');
    fs.mkdirSync(nested, { recursive: true });
    await runInstallStage(fixture.request);
    assert.deepEqual(
        managerCalls(fixture).filter((call) => isInstall(call)),
        [],
        dump(fixture)
    );
    assert.ok(
        warnings(fixture).includes(
            'not installed with npm: tools/x/node_modules already stands in the worktree and is left as it is ' +
                '(remove it and rerun to install)'
        ),
        dump(fixture)
    );
});

await test('a config change made by a failed install is reverted too', async (t) => {
    const fixture = makeFixture(t, {
        files: ROOT_NPM,
        stubs: { npm: NPM_CONFIG_FAIL_STUB },
        mainFolders: [],
        depRels: [],
    });
    const before = sharedConfig(fixture);
    await runInstallStage(fixture.request);
    assert.equal(sharedConfig(fixture), before);
    const warned = warnings(fixture);
    assert.ok(
        warned.some((line) => line.startsWith('cannot install dependencies with npm')),
        dump(fixture)
    );
    const reverted = warned.filter((line) => line.startsWith('reverted core.hookspath'));
    assert.equal(reverted.length, 1, dump(fixture));
});

await test('a failed lock file listing installs nothing and says so', async (t) => {
    const fixture = makeFixture(t, {
        files: ROOT_NPM,
        stubs: { npm: NPM_STUB },
        mainFolders: ['node_modules'],
        depRels: ['node_modules'],
        wrap: (inner) =>
            withOverride(inner, (request) => request.args.includes('ls-files') && !request.args.includes('--others'), {
                code: 128,
                stdout: '',
                stderr: 'fatal: broken index',
            }),
    });
    await runInstallStage(fixture.request);
    assert.deepEqual(managerCalls(fixture), []);
    assert.deepEqual(warnings(fixture), ['cannot list the lock files of the worktree; no dependencies installed']);
    assert.equal(fs.existsSync(path.join(fixture.worktree, 'node_modules')), false);
});

await test('an unreadable shared config is warned about and the install still runs', async (t) => {
    const fixture = makeFixture(t, {
        files: ROOT_NPM,
        stubs: { npm: NPM_STUB },
        mainFolders: [],
        depRels: [],
        wrap: (inner) =>
            withOverride(inner, (request) => request.args.includes('--git-common-dir'), {
                code: 128,
                stdout: '',
                stderr: 'fatal: not a git repository',
            }),
    });
    await runInstallStage(fixture.request);
    assert.deepEqual(warnings(fixture), [NOT_REVERTED]);
    assert.equal(managerCalls(fixture).filter((call) => isInstall(call)).length, 1, dump(fixture));
    assert.ok(
        infos(fixture).some((line) => line.startsWith('installed dependencies with npm in ')),
        dump(fixture)
    );
});
