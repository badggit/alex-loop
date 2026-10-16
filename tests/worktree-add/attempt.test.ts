import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { installCommand, runInstall, type AttemptRequest } from '../../src/worktree-add/attempt.ts';
import { createProcessRunner } from '../../src/worktree-add/proc.ts';
import type { CommandRequest, ManagerName } from '../../src/worktree-add/types.ts';

import { testDeps } from './support/deps.ts';
import { recording } from './support/runners.ts';
import { isolatedBin, withPath } from './support/stubManagers.ts';
import { tempRoot } from './support/tmp.ts';
import { writeStubTool } from './support/tools.ts';

const LOCK_TEXT = '{"lockfileVersion":3}\n';

interface Setup {
    deps: ReturnType<typeof testDeps>;
    calls: CommandRequest[];
    projectDir: string;
    lock: string;
    request: (_overrides?: Partial<AttemptRequest>) => AttemptRequest;
}

// A project with package-lock.json and a stub NAME running body on a PATH holding only the base tools.
function setup(t: TestContext, name: string, body: string, manager: ManagerName = 'npm'): Setup {
    const root = tempRoot(t);
    const bin = isolatedBin(root);
    writeStubTool(bin, name, body);
    const projectDir = path.join(root, 'project');
    fs.mkdirSync(projectDir);
    const lock = path.join(projectDir, 'package-lock.json');
    fs.writeFileSync(lock, LOCK_TEXT);
    const runner = recording(createProcessRunner(withPath(process.env, bin)));
    t.after(() => runner.terminateAll());
    const deps = testDeps(withPath(process.env, bin), { runner });
    const request = (overrides?: Partial<AttemptRequest>): AttemptRequest => ({
        manager,
        projectDir,
        label: manager,
        lockFiles: [lock],
        deadlineMs: Date.now() + 60_000,
        nowMs: () => Date.now(),
        networkTimeoutMs: 30_000,
        progressMs: 60_000,
        ...overrides,
    });
    return { deps, calls: runner.calls, projectDir, lock, request };
}

const OFFLINE_MISS_NPM = 'case "$*" in *--offline*) echo "npm error code ENOTCACHED" >&2; exit 1;; esac';

await test('the shown commands match the plan table', () => {
    assert.equal(installCommand('npm'), 'npm ci');
    assert.equal(installCommand('pnpm'), 'pnpm install --frozen-lockfile');
    assert.equal(installCommand('yarn-classic'), 'yarn install --frozen-lockfile');
    assert.equal(installCommand('yarn-berry'), 'yarn install --immutable');
    assert.equal(installCommand('bun'), 'bun install --frozen-lockfile');
    assert.equal(installCommand('uv'), 'uv sync --frozen');
});

await test('an npm that succeeds offline runs once with --offline', async (t) => {
    const { deps, calls, projectDir, request } = setup(t, 'npm', 'exit 0');
    const result = await runInstall(deps, request());
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.file, 'npm');
    assert.deepEqual(calls[0]?.args, ['ci', '--offline']);
    assert.equal(calls[0]?.cwd, projectDir);
    assert.equal(result.ok, true);
    assert.equal(result.online, false);
    assert.equal(result.code, 0);
    assert.equal(result.lockChanged, false);
});

await test('an offline cache miss leads to one online attempt with network limits', async (t) => {
    const { deps, calls, request } = setup(t, 'npm', `${OFFLINE_MISS_NPM}\nexit 0`);
    const result = await runInstall(deps, request({ networkTimeoutMs: 5000 }));
    assert.equal(calls.length, 2);
    const online = calls[1]?.args ?? [];
    assert.ok(!online.includes('--offline'));
    assert.ok(online.includes('--fetch-timeout=5000'));
    assert.ok(online.includes('--fetch-retries=1'));
    assert.equal(result.ok, true);
    assert.equal(result.online, true);
});

await test('output keeps both attempts while lastOutput keeps only the online one', async (t) => {
    const { deps, request } = setup(t, 'npm', `${OFFLINE_MISS_NPM}\necho "npm error code E401" >&2\nexit 1`);
    const result = await runInstall(deps, request());
    assert.equal(result.ok, false);
    assert.equal(result.code, 1);
    assert.match(result.output, /ENOTCACHED/);
    assert.match(result.output, /E401/);
    assert.match(result.lastOutput, /E401/);
    assert.doesNotMatch(result.lastOutput, /ENOTCACHED/);
});

await test('uv gets its HTTP limits only in the online attempt', async (t) => {
    const body = [
        'case "$*" in *--offline*) mode=offline;; *) mode=online;; esac',
        'echo "$mode UV_HTTP_TIMEOUT=${UV_HTTP_TIMEOUT-unset}"',
        'if [ "$mode" = offline ]; then echo "error: pkg was not found in the cache" >&2; exit 2; fi',
        'exit 0',
    ].join('\n');
    const { deps, calls, request } = setup(t, 'uv', body, 'uv');
    const result = await runInstall(deps, request({ networkTimeoutMs: 30_000 }));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0]?.args, ['sync', '--frozen', '--offline']);
    assert.deepEqual(calls[1]?.args, ['sync', '--frozen']);
    assert.match(result.output, /offline UV_HTTP_TIMEOUT=unset/);
    assert.match(result.output, /online UV_HTTP_TIMEOUT=30/);
    assert.equal(calls[1]?.env?.UV_HTTP_RETRIES, '1');
    assert.equal(calls[1]?.env?.UV_HTTP_CONNECT_TIMEOUT, '10');
    assert.equal(result.ok, true);
    assert.equal(result.online, true);
});

await test('yarn berry runs one online attempt with YARN_HTTP_TIMEOUT', async (t) => {
    const body = 'echo "YARN_HTTP_TIMEOUT=${YARN_HTTP_TIMEOUT-unset} $*"\nexit 0';
    const { deps, calls, request } = setup(t, 'yarn', body, 'yarn-berry');
    const result = await runInstall(deps, request());
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args, ['install', '--immutable']);
    assert.ok(!(calls[0]?.args ?? []).includes('--offline'));
    assert.match(result.output, /YARN_HTTP_TIMEOUT=30000 install --immutable/);
    assert.equal(result.ok, true);
    assert.equal(result.online, true);
});

await test('an offline failure that is not a cache miss makes no online call', async (t) => {
    const { deps, calls, request } = setup(t, 'npm', 'echo "npm error code EUSAGE" >&2\nexit 1');
    const result = await runInstall(deps, request());
    assert.equal(calls.length, 1);
    assert.equal(result.ok, false);
    assert.equal(result.online, false);
    assert.equal(result.code, 1);
    assert.match(result.lastOutput, /EUSAGE/);
});

await test('a rewritten lock file fails the attempt and gets its original bytes back', async (t) => {
    const { deps, lock, request } = setup(t, 'npm', 'echo changed > package-lock.json\nexit 0');
    const result = await runInstall(deps, request());
    assert.equal(result.code, 0);
    assert.equal(result.ok, false);
    assert.equal(result.lockChanged, true);
    assert.equal(result.lockRestoreProblem, undefined);
    assert.equal(fs.readFileSync(lock, 'utf8'), LOCK_TEXT);
});

await test('an attempt past its deadline is stopped and marked timedOut', async (t) => {
    const { deps, request } = setup(t, 'npm', 'sleep 30');
    const started = Date.now();
    const result = await runInstall(deps, request({ deadlineMs: Date.now() + 400 }));
    assert.ok(Date.now() - started < 11_000);
    assert.equal(result.timedOut, true);
    assert.equal(result.ok, false);
});

await test('a long attempt logs progress lines and stops logging once settled', async (t) => {
    const { deps, request } = setup(t, 'npm', 'sleep 1\nexit 0');
    const result = await runInstall(deps, request({ progressMs: 100 }));
    assert.equal(result.ok, true);
    const progress = deps.lines.filter((line) => / info still installing with npm \(\d+ s\)$/.test(line));
    assert.ok(progress.length >= 2, `expected at least two progress lines, got ${progress.length}`);
    const settledCount = deps.lines.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(deps.lines.length, settledCount);
});

await test('an offline attempt that prints a miss signal but exits 0 makes no online call', async (t) => {
    const { deps, calls, request } = setup(t, 'npm', 'echo "npm warn ENOTCACHED something" >&2\nexit 0');
    const result = await runInstall(deps, request());
    assert.equal(calls.length, 1);
    assert.ok((calls[0]?.args ?? []).includes('--offline'));
    assert.equal(result.ok, true);
    assert.equal(result.online, false);
    assert.equal(result.code, 0);
});

await test('a deadline already past runs no attempt and is timedOut', async (t) => {
    const { deps, calls, request } = setup(t, 'npm', 'exit 0');
    const result = await runInstall(deps, request({ deadlineMs: Date.now() - 1 }));
    assert.equal(calls.length, 0);
    assert.equal(result.timedOut, true);
    assert.equal(result.ok, false);
    assert.equal(result.online, false);
});

await test('a deadline that runs out after the offline miss skips the online attempt', async (t) => {
    const { deps, calls, request } = setup(t, 'npm', `${OFFLINE_MISS_NPM}\nexit 0`);
    // The clock jumps past the deadline as soon as the offline attempt has been started.
    const nowMs = (): number => (calls.length === 0 ? 0 : 2000);
    const result = await runInstall(deps, request({ deadlineMs: 1000, nowMs }));
    assert.equal(calls.length, 1);
    assert.ok((calls[0]?.args ?? []).includes('--offline'));
    assert.equal(result.timedOut, true);
    assert.equal(result.online, false);
    assert.equal(result.ok, false);
    assert.match(result.output, /ENOTCACHED/);
});

await test('an offline attempt that times out makes no online call even with time left', async (t) => {
    const body = 'case "$*" in *--offline*) echo "npm error code ENOTCACHED" >&2; sleep 30;; esac\nexit 0';
    const { deps, calls, request } = setup(t, 'npm', body);
    const deadlineMs = Date.now() + 60_000;
    // The offline attempt gets 400 ms; once it has been started the clock shows a full minute left again.
    const nowMs = (): number => (calls.length === 0 ? deadlineMs - 400 : deadlineMs - 60_000);
    const result = await runInstall(deps, request({ deadlineMs, nowMs }));
    assert.equal(calls.length, 1);
    assert.equal(result.timedOut, true);
    assert.equal(result.online, false);
    assert.equal(result.ok, false);
});

await test('a lock file created by the install is removed and counts as a lock change', async (t) => {
    const { deps, projectDir, lock, request } = setup(t, 'npm', 'echo "{}" > npm-shrinkwrap.json\nexit 0');
    const shrinkwrap = path.join(projectDir, 'npm-shrinkwrap.json');
    const result = await runInstall(deps, request({ lockFiles: [lock, shrinkwrap] }));
    assert.equal(result.code, 0);
    assert.equal(result.lockChanged, true);
    assert.equal(result.ok, false);
    assert.equal(result.lockRestoreProblem, undefined);
    assert.equal(fs.existsSync(shrinkwrap), false);
    assert.equal(fs.readFileSync(lock, 'utf8'), LOCK_TEXT);
});

await test('a lock that cannot be read before the install is kept and reported', async (t) => {
    if (process.getuid?.() === 0) {
        t.skip('root reads files regardless of their mode');
        return;
    }
    const { deps, lock, request } = setup(t, 'npm', 'exit 0');
    fs.chmodSync(lock, 0o000);
    const result = await runInstall(deps, request());
    assert.equal(result.code, 0);
    assert.equal(result.ok, false);
    assert.match(result.lockRestoreProblem ?? '', /package-lock\.json: could not be read before the install.*EACCES/);
    assert.equal(fs.existsSync(lock), true);
    fs.chmodSync(lock, 0o644);
    assert.equal(fs.readFileSync(lock, 'utf8'), LOCK_TEXT);
});
