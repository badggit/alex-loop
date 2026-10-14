import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { createLogger } from '../../src/worktree-add/log.ts';
import { main as runMain } from '../../src/worktree-add/main.ts';
import { TEMP_PREFIX } from '../../src/worktree-add/place.ts';
import type { Env } from '../../src/worktree-add/types.ts';

import { commitFile, gitSync, makeRepo, testEnv } from './support/git.ts';
import { tempRoot } from './support/tmp.ts';
import { realToolPath, writeStubTool } from './support/tools.ts';

interface CliResult {
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: Buffer;
    stderr: string;
}

interface Started {
    pid: number;
    done: Promise<CliResult>;
    kill(): void;
}

interface Fixture {
    root: string;
    env: Env;
    main: string;
}

const CLI = path.resolve(import.meta.dirname, '../../src/worktree-add/cli.ts');
const LINUX_ONLY = process.platform === 'linux' ? false : 'macOS pins /bin/cp';
const LOG_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z (info|warn|error) /u;
const IGNORE_RULES = '.env\ndocs.local/\nnode_modules/\n';
const POLL_MS = 50;
const PID_WAIT_MS = 20_000;
const SIGNAL_LIMIT_MS = 10_000;

function definedEnv(env: Env): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) {
        if (value !== undefined) {
            result[name] = value;
        }
    }
    return result;
}

function startCli(env: Env, args: readonly string[], cwd: string): Started {
    const child = spawn(process.execPath, [CLI, ...args], {
        cwd,
        env: definedEnv(env),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
        stdout.push(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
    });
    const done = new Promise<CliResult>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code, signal) => {
            resolve({ code, signal, stdout: Buffer.concat(stdout), stderr });
        });
    });
    const kill = (): void => {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
        }
    };
    return { pid: child.pid ?? 0, done, kill };
}

function runCli(env: Env, args: readonly string[], cwd: string): Promise<CliResult> {
    return startCli(env, args, cwd).done;
}

function makeFixture(t: TestContext, name = 'app'): Fixture {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env, name);
    commitFile(env, main, '.gitignore', IGNORE_RULES);
    fs.writeFileSync(path.join(main, '.env'), 'A=1\n');
    fs.mkdirSync(path.join(main, 'docs.local'));
    fs.writeFileSync(path.join(main, 'docs.local', 'a.md'), 'doc\n');
    return { root, env, main };
}

function addNodeModules(f: Fixture): void {
    fs.mkdirSync(path.join(f.main, 'node_modules', 'p'), { recursive: true });
    fs.writeFileSync(path.join(f.main, 'node_modules', 'p', 'i.js'), 'x\n');
}

// PATH with BIN first, so a stub tool there shadows the real one.
function withStubs(f: Fixture, bin: string): Env {
    return { ...f.env, PATH: `${bin}:${f.env.PATH ?? ''}` };
}

function errorLines(stderr: string): string[] {
    return stderr.split('\n').filter((line) => line.includes(' error '));
}

function assertUsageExit(result: CliResult): void {
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.stdout.length, 0);
    assert.match(result.stderr, /Usage: worktree-add\.mjs/u);
}

function assertRefusalExit(result: CliResult): void {
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stdout.length, 0);
    assert.equal(errorLines(result.stderr).length, 1, result.stderr);
}

function groupAlive(pid: number): boolean {
    try {
        process.kill(-pid, 0);
        return true;
    } catch (error) {
        return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
    }
}

function killGroup(pid: number): void {
    try {
        process.kill(-pid, 'SIGKILL');
    } catch {
        return;
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        globalThis.setTimeout(resolve, ms);
    });
}

// Bounded poll for the stub's PID file; fails early when the CLI exits before the stub starts waiting.
async function waitForPid(file: string, started: Started): Promise<number> {
    let exited = false;
    const markExited = (): boolean => {
        exited = true;
        return exited;
    };
    void started.done.then(markExited, markExited);
    const deadline = Date.now() + PID_WAIT_MS;
    while (Date.now() < deadline) {
        const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
        if (/^\d+$/u.test(text)) {
            return Number(text);
        }
        if (exited) {
            const result = await started.done;
            throw new Error(`the CLI exited before the stub wrote its PID: ${result.stderr}`);
        }
        await delay(POLL_MS);
    }
    throw new Error('the stub never wrote its PID file');
}

function tempsUnder(dir: string): string[] {
    const found: string[] = [];
    for (const entry of fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
        if (path.basename(entry).startsWith(TEMP_PREFIX)) {
            found.push(entry);
        }
    }
    return found;
}

function isRegistered(f: Fixture, worktree: string): boolean {
    const listed = gitSync(f.env, ['-C', f.main, 'worktree', 'list', '--porcelain']);
    return listed.split('\n').includes(`worktree ${worktree}`);
}

// The PID is written through a rename so the poll never reads a half-written file.
function pidLine(pidFile: string): string {
    return `echo $$ > '${pidFile}.part' && mv '${pidFile}.part' '${pidFile}'`;
}

// Rejects a clone at once; a plain copy writes part of a file into its last argument and then waits.
function hangingCopyStub(pidFile: string): string {
    return [
        'for a do',
        '    case "$a" in --reflink=always) echo "failed to clone" >&2; exit 1 ;; esac',
        'done',
        'for last do :; done',
        'printf PART > "$last"',
        pidLine(pidFile),
        'sleep 30',
    ].join('\n');
}

// Waits inside the clone probe; any other call runs the real cp.
function hangingProbeStub(pidFile: string, realCp: string): string {
    return [
        'for a do',
        `    case "$a" in --reflink=always) ${pidLine(pidFile)}; sleep 30; exit 1 ;; esac`,
        'done',
        `exec '${realCp}' "$@"`,
    ].join('\n');
}

function droppingCloneStub(realCp: string): string {
    return [
        'for a do',
        '    shift',
        '    [ "$a" = "--reflink=always" ] && continue',
        '    set -- "$@" "$a"',
        'done',
        `exec '${realCp}' "$@"`,
    ].join('\n');
}

function rejectingCloneStub(realCp: string): string {
    return [
        'for a do',
        '    case "$a" in --reflink=always) echo "failed to clone" >&2; exit 1 ;; esac',
        'done',
        `exec '${realCp}' "$@"`,
    ].join('\n');
}

async function signalDuringStub(
    t: TestContext,
    signal: NodeJS.Signals,
    stub: (_pidFile: string, _realCp: string) => string
): Promise<{ f: Fixture; worktree: string; result: CliResult; stubPid: number; elapsedMs: number }> {
    const f = makeFixture(t);
    const bin = path.join(f.root, 'bin');
    const pidFile = path.join(f.root, 'stub.pid');
    writeStubTool(bin, 'cp', stub(pidFile, realToolPath('cp', f.env)));
    const started = startCli(withStubs(f, bin), ['--suffix', 'sig'], f.main);
    const stubGroup: { pid?: number } = {};
    t.after(() => {
        started.kill();
        if (stubGroup.pid !== undefined) {
            killGroup(stubGroup.pid);
        }
    });
    stubGroup.pid = await waitForPid(pidFile, started);
    const stubPid = stubGroup.pid;
    const sentMs = Date.now();
    process.kill(started.pid, signal);
    const result = await started.done;
    return { f, worktree: path.join(f.root, 'app-sig'), result, stubPid, elapsedMs: Date.now() - sentMs };
}

function assertCleanTermination(run: Awaited<ReturnType<typeof signalDuringStub>>, signal: NodeJS.Signals): void {
    assert.equal(run.result.signal, signal, run.result.stderr);
    assert.ok(run.elapsedMs < SIGNAL_LIMIT_MS, `took ${String(run.elapsedMs)} ms`);
    assert.equal(groupAlive(run.stubPid), false);
    assert.deepEqual(tempsUnder(run.worktree), []);
    assert.equal(fs.existsSync(path.join(run.worktree, '.env')), false);
    assert.ok(isRegistered(run.f, run.worktree));
}

await test('the CLI prints only the physical path on stdout and timestamps every stderr line', async (t) => {
    const f = makeFixture(t);
    const result = await runCli(f.env, ['--suffix', 'rep-1'], f.main);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.toString('utf8'), `${path.join(f.root, 'app-rep-1')}\n`);
    const lines = result.stderr.split('\n').filter((line) => line.length > 0);
    assert.ok(lines.length > 0);
    for (const line of lines) {
        assert.match(line, LOG_LINE);
    }
});

await test('--help exits 0 with the usage on stderr only', async (t) => {
    const f = makeFixture(t);
    const result = await runCli(f.env, ['--help'], f.main);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.length, 0);
    assert.match(result.stderr, /^Usage: worktree-add\.mjs/u);
});

await test(
    'a worktree with links, copies and a cloned node_modules is removed by a plain git worktree remove',
    { skip: LINUX_ONLY },
    async (t) => {
        const f = makeFixture(t);
        addNodeModules(f);
        const bin = path.join(f.root, 'bin');
        writeStubTool(bin, 'cp', droppingCloneStub(realToolPath('cp', f.env)));
        const result = await runCli(withStubs(f, bin), ['--suffix', 'rep-2'], f.main);
        assert.equal(result.code, 0, result.stderr);
        const worktree = path.join(f.root, 'app-rep-2');
        assert.ok(fs.lstatSync(path.join(worktree, 'node_modules')).isDirectory());
        assert.ok(fs.lstatSync(path.join(worktree, 'docs.local')).isSymbolicLink());
        assert.ok(fs.lstatSync(path.join(worktree, '.env')).isFile());
        gitSync(f.env, ['-C', f.main, 'worktree', 'remove', worktree]);
        assert.equal(fs.existsSync(worktree), false);
        assert.equal(fs.readFileSync(path.join(f.main, 'docs.local', 'a.md'), 'utf8'), 'doc\n');
    }
);

await test('a cp that cannot clone leaves node_modules as an own link', { skip: LINUX_ONLY }, async (t) => {
    const f = makeFixture(t);
    addNodeModules(f);
    const bin = path.join(f.root, 'bin');
    writeStubTool(bin, 'cp', rejectingCloneStub(realToolPath('cp', f.env)));
    const result = await runCli(withStubs(f, bin), ['--suffix', 'rep-3'], f.main);
    assert.equal(result.code, 0, result.stderr);
    const link = path.join(f.root, 'app-rep-3', 'node_modules');
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.readlinkSync(link), path.join(f.main, 'node_modules'));
});

await test('a relative --parent is resolved from the caller directory', async (t) => {
    const f = makeFixture(t);
    const sub = path.join(f.main, 'sub');
    fs.mkdirSync(sub);
    const result = await runCli(f.env, ['--suffix', 'rep-4', '--parent', '../wt'], sub);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.toString('utf8'), `${path.join(f.main, 'wt', 'app-rep-4')}\n`);
});

await test('the printed path of a Cyrillic main folder is byte-identical to the real path', async (t) => {
    const f = makeFixture(t, '\u043F\u0440\u0438\u043B');
    const result = await runCli(f.env, ['--suffix', 'rep-5'], f.main);
    assert.equal(result.code, 0, result.stderr);
    const expected = Buffer.from(`${path.join(f.root, '\u043F\u0440\u0438\u043B-rep-5')}\n`, 'utf8');
    assert.ok(result.stdout.equals(expected), result.stdout.toString('utf8'));
});

await test('wrong arguments exit 2 with the usage on stderr', async (t) => {
    const f = makeFixture(t);
    const file = path.join(f.root, 'plain.txt');
    fs.writeFileSync(file, 'x\n');
    assertUsageExit(await runCli(f.env, [], f.main));
    assertUsageExit(await runCli(f.env, ['--suffix', 'rep-6', '--bogus'], f.main));
    assertUsageExit(await runCli(f.env, ['--suffix', 'rep-6', '--parent', '~user/x'], f.main));
    assertUsageExit(await runCli(f.env, ['--suffix', 'rep-6', '--parent', file], f.main));
});

await test('a branch name git rejects exits 2', async (t) => {
    const f = makeFixture(t);
    const bin = path.join(f.root, 'bin');
    const realGit = realToolPath('git', f.env);
    writeStubTool(bin, 'git', `[ "$3" = check-ref-format ] && exit 1\nexec '${realGit}' "$@"`);
    const result = await runCli(withStubs(f, bin), ['--suffix', 'rep-7'], f.main);
    assertUsageExit(result);
    assert.match(result.stderr, /error invalid branch name: rep-7/u);
});

await test('a main folder name with a control character exits 1 with one error line', async (t) => {
    const f = makeFixture(t, 'a\tb');
    assertRefusalExit(await runCli(f.env, ['--suffix', 'rep-8'], f.main));
});

await test('a target refusal exits 1 with one error line', async (t) => {
    const f = makeFixture(t);
    const target = path.join(f.root, 'app-rep-9');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep.txt'), 'keep\n');
    assertRefusalExit(await runCli(f.env, ['--suffix', 'rep-9'], f.main));
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    await test(`${signal} during a plain copy stops the copy and removes its temp`, { skip: LINUX_ONLY }, async (t) => {
        assertCleanTermination(await signalDuringStub(t, signal, hangingCopyStub), signal);
    });

    await test(
        `${signal} during the clone probe stops the probe and removes its temp`,
        { skip: LINUX_ONLY },
        async (t) => {
            assertCleanTermination(await signalDuringStub(t, signal, hangingProbeStub), signal);
        }
    );
}

await test(
    'after a SIGKILL mid-copy the next run removes the temp and copies again',
    { skip: LINUX_ONLY },
    async (t) => {
        const run = await signalDuringStub(t, 'SIGKILL', hangingCopyStub);
        assert.equal(run.result.signal, 'SIGKILL');
        assert.equal(tempsUnder(run.worktree).length, 1);
        assert.equal(gitSync(run.f.env, ['-C', run.worktree, 'status', '--porcelain']), '');
        killGroup(run.stubPid);
        const again = await runCli(run.f.env, ['--suffix', 'sig'], run.f.main);
        assert.equal(again.code, 0, again.stderr);
        assert.deepEqual(tempsUnder(run.worktree), []);
        assert.equal(fs.readFileSync(path.join(run.worktree, '.env'), 'utf8'), 'A=1\n');
    }
);

await test('an unexpected exception exits 1 with one error line', async () => {
    const lines: string[] = [];
    const log = createLogger(
        (line) => {
            lines.push(line);
        },
        () => new Date()
    );
    const previous = process.exitCode;
    let code: typeof process.exitCode;
    try {
        await runMain({ run: () => Promise.reject(new Error('boom')), log });
        code = process.exitCode;
    } finally {
        process.exitCode = previous;
    }
    assert.equal(code, 1);
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0] ?? '', LOG_LINE);
    assert.match(lines[0] ?? '', / error boom$/u);
});
