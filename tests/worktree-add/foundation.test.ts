import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createLogger } from '../../src/worktree-add/log.ts';
import { canonical, canonicalLoose, isLinkWithText, lstatOrUndefined } from '../../src/worktree-add/paths.ts';
import { createProcessRunner, pidAlive } from '../../src/worktree-add/proc.ts';
import { createTempRegistry } from '../../src/worktree-add/temps.ts';
import { hasControlCharacter, showText } from '../../src/worktree-add/text.ts';
import type { CommandRequest, Env } from '../../src/worktree-add/types.ts';

import { testDeps } from './support/deps.ts';
import { commitFile, gitSync, makeRepo, testEnv } from './support/git.ts';
import { recording, withCowEmulation, withOverride, withoutCow, withoutLockLines } from './support/runners.ts';
import { tempRoot } from './support/tmp.ts';
import { realToolPath, writeStubTool } from './support/tools.ts';

const CYRILLIC_NAME = '\u041F\u0440\u0438\u0432\u0435\u0442';
const QUOTE_NAME = 'my "task" \'name\'';
const LOG_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z info hello$/u;

function errorCode(error: unknown): unknown {
    return error instanceof Error && 'code' in error ? error.code : undefined;
}

function groupErrorCode(pid: number): unknown {
    try {
        process.kill(-pid, 0);
        return 'alive';
    } catch (error) {
        return errorCode(error);
    }
}

async function waitForFile(file: string): Promise<void> {
    for (let attempt = 0; attempt < 300; attempt += 1) {
        if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').length > 0) {
            return;
        }
        await delay(10);
    }
    assert.fail(`${file} never appeared`);
}

function keepCwd(t: TestContext): void {
    const before = process.cwd();
    t.after(() => {
        process.chdir(before);
    });
}

// ROOT/work/proj, ROOT/work/file and the symlink ROOT/worklink to ROOT/work.
function symlinkedTree(root: string): void {
    fs.mkdirSync(path.join(root, 'work', 'proj'), { recursive: true });
    fs.writeFileSync(path.join(root, 'work', 'file'), 'x\n');
    fs.symlinkSync(path.join(root, 'work'), path.join(root, 'worklink'));
}

await test('logger writes one formatted line per level with a fixed clock', () => {
    const lines: string[] = [];
    const log = createLogger(
        (line) => {
            lines.push(line);
        },
        () => new Date('2026-10-13T10:00:00.456Z')
    );
    log.info('hello');
    log.warn('careful');
    log.error('broken');
    assert.deepEqual(lines, [
        '2026-10-13T10:00:00Z info hello',
        '2026-10-13T10:00:00Z warn careful',
        '2026-10-13T10:00:00Z error broken',
    ]);
});

await test('showText keeps printable text and replaces control characters', () => {
    assert.equal(showText(CYRILLIC_NAME), CYRILLIC_NAME);
    assert.equal(showText(QUOTE_NAME), QUOTE_NAME);
    assert.equal(showText(String.raw`a\b c`), String.raw`a\b c`);
    assert.equal(showText('a\tb\nc'), 'a?b?c');
});

await test('hasControlCharacter detects C0 controls and DEL only', () => {
    for (const value of ['a\tb', 'a\nb', 'a\u0001b', 'a\u001Fb', 'a\u007Fb']) {
        assert.equal(hasControlCharacter(value), true, JSON.stringify(value));
    }
    for (const value of ['a b', String.raw`a\b`, CYRILLIC_NAME, QUOTE_NAME, '']) {
        assert.equal(hasControlCharacter(value), false, JSON.stringify(value));
    }
});

await test('runner returns exit code, stdout and stderr', async () => {
    const runner = createProcessRunner(process.env);
    const result = await runner.run({ file: '/bin/sh', args: ['-c', 'printf out; printf err >&2; exit 3'] });
    assert.equal(result.code, 3);
    assert.equal(result.stdout, 'out');
    assert.equal(result.stderr, 'err');
    assert.equal(result.spawnError, undefined);
});

await test('runner runs in the requested folder with only the given environment', async (t) => {
    const root = tempRoot(t);
    const runner = createProcessRunner({ PATH: process.env.PATH, WTA_TEST_VALUE: 'v', WTA_TEST_UNSET: undefined });
    const result = await runner.run({
        file: '/bin/sh',
        args: ['-c', 'pwd -P; printf "%s|%s" "$WTA_TEST_VALUE" "${WTA_TEST_UNSET-unset}"'],
        cwd: root,
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, `${root}\nv|unset`);
});

await test('runner resolves a missing file with code 127 and ENOENT', async () => {
    const runner = createProcessRunner(process.env);
    const result = await runner.run({ file: '/nonexistent/wta-missing-tool', args: [] });
    assert.equal(result.code, 127);
    assert.equal(result.spawnError, 'ENOENT');
});

await test('terminateAll stops a running sleep with code 143 within 6 s', async (t) => {
    const runner = createProcessRunner(process.env);
    t.after(() => runner.terminateAll());
    const run = runner.run({ file: 'sleep', args: ['30'] });
    const started = performance.now();
    await runner.terminateAll();
    assert.ok(performance.now() - started < 6000);
    const result = await run;
    assert.equal(result.code, 143);
});

await test('terminateAll stops a shell stub and its grandchild that hold the pipes', async (t) => {
    const root = tempRoot(t);
    const bin = path.join(root, 'bin');
    const pidFile = path.join(root, 'pid');
    writeStubTool(bin, 'stub-sleep', `printf '%s' "$$" > '${pidFile}'\nsleep 30\nexit 0`);
    const runner = createProcessRunner(process.env);
    t.after(() => runner.terminateAll());
    const run = runner.run({ file: path.join(bin, 'stub-sleep'), args: [] });
    await waitForFile(pidFile);
    const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
    assert.equal(groupErrorCode(pid), 'alive');
    const started = performance.now();
    await runner.terminateAll();
    assert.ok(performance.now() - started < 6000);
    assert.equal(groupErrorCode(pid), 'ESRCH');
    const result = await run;
    assert.equal(result.code, 143);
});

await test('terminateAll with nothing running resolves at once', async () => {
    const runner = createProcessRunner(process.env);
    await runner.terminateAll();
});

await test('pidAlive is false for a finished child and true for this process', () => {
    const finished = spawnSync('/bin/sh', ['-c', 'exit 0']);
    assert.equal(pidAlive(finished.pid), false);
    assert.equal(pidAlive(process.pid), true);
    assert.equal(pidAlive(1), false);
    assert.equal(pidAlive(0), false);
});

await test('canonical resolves symlinks and returns a missing path unchanged', (t) => {
    const root = tempRoot(t);
    symlinkedTree(root);
    assert.equal(canonical(path.join(root, 'worklink', 'proj')), path.join(root, 'work', 'proj'));
    const missing = path.join(root, 'missing', 'x');
    assert.equal(canonical(missing), missing);
});

await test('canonicalLoose resolves the existing part through a symlinked folder', (t) => {
    const root = tempRoot(t);
    symlinkedTree(root);
    assert.equal(
        canonicalLoose(path.join(root, 'worklink', 'missing', 'deeper')),
        path.join(root, 'work', 'missing', 'deeper')
    );
});

await test('canonicalLoose normalizes like the canon_loose table', (t) => {
    const root = tempRoot(t);
    symlinkedTree(root);
    fs.mkdirSync(path.join(root, 'r', 'a'), { recursive: true });
    const work = path.join(root, 'work');
    assert.equal(canonicalLoose(`${root}/worklink/proj/`), path.join(work, 'proj'));
    assert.equal(canonicalLoose(`${root}/worklink/file`), path.join(work, 'file'));
    assert.equal(canonicalLoose(`${root}/worklink/./missing/./x/.`), path.join(work, 'missing', 'x'));
    assert.equal(canonicalLoose(`${root}//worklink///missing//x//`), path.join(work, 'missing', 'x'));
    const parentOfR = root;
    assert.equal(canonicalLoose(`${root}/r/a/miss/../../../outside`), path.join(parentOfR, 'outside'));
    assert.equal(canonicalLoose(`${root}/worklink/missing/../..`), root);
    assert.equal(canonicalLoose('/wta-missing-root-entry/x'), '/wta-missing-root-entry/x');
    assert.equal(canonicalLoose('/../wta-missing-a/../wta-missing-b'), '/wta-missing-b');
});

await test('canonicalLoose climbs out of a symlink into its physical parent', (t) => {
    const root = tempRoot(t);
    fs.mkdirSync(path.join(root, 'deep'), { recursive: true });
    fs.mkdirSync(path.join(root, 'other', 'target'), { recursive: true });
    fs.symlinkSync(path.join(root, 'other', 'target'), path.join(root, 'deep', 'link'));
    assert.equal(canonicalLoose(`${root}/deep/link/..`), path.join(root, 'other'));
    assert.equal(canonicalLoose(`${root}/deep/link/../missing`), path.join(root, 'other', 'missing'));
    assert.equal(canonicalLoose(`${root}/deep/link/missing/../..`), path.join(root, 'other'));
});

await test('canonicalLoose resolves a relative input against the physical current folder', (t) => {
    const root = tempRoot(t);
    symlinkedTree(root);
    keepCwd(t);
    process.chdir(path.join(root, 'worklink'));
    const work = path.join(root, 'work');
    assert.equal(canonicalLoose('missing/deeper'), path.join(work, 'missing', 'deeper'));
    assert.equal(canonicalLoose('missing/../proj'), path.join(work, 'proj'));
});

await test('lstatOrUndefined and isLinkWithText inspect links without following them', (t) => {
    const root = tempRoot(t);
    symlinkedTree(root);
    const link = path.join(root, 'worklink');
    assert.equal(lstatOrUndefined(link)?.isSymbolicLink(), true);
    assert.equal(lstatOrUndefined(path.join(root, 'missing')), undefined);
    assert.equal(isLinkWithText(link, path.join(root, 'work')), true);
    assert.equal(isLinkWithText(link, 'work'), false);
    assert.equal(isLinkWithText(path.join(root, 'work'), path.join(root, 'work')), false);
    assert.equal(isLinkWithText(path.join(root, 'missing'), 'x'), false);
});

await test('makeRepo gives a main clone with origin/HEAD and an empty global config', (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const repo = makeRepo(root, env);
    assert.equal(repo.main, path.join(root, 'app'));
    assert.equal(repo.origin, path.join(root, 'origin.git'));
    assert.equal(
        gitSync(env, ['-C', repo.main, 'symbolic-ref', 'refs/remotes/origin/HEAD']).trim(),
        'refs/remotes/origin/main'
    );
    assert.equal(gitSync(env, ['-C', repo.main, 'branch', '--show-current']).trim(), 'main');
    assert.equal(gitSync(env, ['config', '--global', '--list'], repo.main), '');
    const id = commitFile(env, repo.main, 'notes/extra.txt', 'extra\n');
    assert.equal(gitSync(env, ['-C', repo.main, 'rev-parse', 'HEAD']).trim(), id);
});

await test('testEnv isolates git from the inherited environment', (t) => {
    const leaked: Record<string, string> = {
        GIT_DEFAULT_HASH: 'sha256',
        GIT_TRACE: '1',
        GIT_AUTHOR_NAME: 'Leaky',
        GIT_ODD: 'x\nGIT_PHANTOM=y',
    };
    const saved = new Map(Object.keys(leaked).map((name) => [name, process.env[name]]));
    t.after(() => {
        for (const [name, value] of saved) {
            if (value === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = value;
            }
        }
    });
    Object.assign(process.env, leaked);
    const root = tempRoot(t);
    const env = testEnv(root);
    const repo = makeRepo(root, env);
    assert.equal(gitSync(env, ['-C', repo.main, 'log', '-1', '--format=%an']).trim(), 'test');
    assert.match(gitSync(env, ['-C', repo.main, 'rev-parse', 'HEAD']).trim(), /^[\da-f]{40}$/u);
    const status = spawnSync('git', ['-C', repo.main, 'status'], { env: { ...env }, encoding: 'utf8' });
    assert.equal(status.status, 0);
    assert.equal(status.stderr, '');
    assert.equal(env.GIT_ODD, undefined);
    assert.equal(env.GIT_PHANTOM, undefined);
    assert.equal(env.GIT_TRACE, undefined);
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(env.GIT_CEILING_DIRECTORIES, path.dirname(root));
});

await test('temp registry removes registered paths and ignores vanished or unregistered ones', (t) => {
    const root = tempRoot(t);
    const full = path.join(root, 'full');
    const gone = path.join(root, 'gone');
    const kept = path.join(root, 'kept');
    for (const dir of [full, gone, kept]) {
        fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'sub', 'file'), 'x');
    }
    const temps = createTempRegistry();
    temps.add(full);
    temps.add(gone);
    temps.add(kept);
    temps.remove(kept);
    fs.rmSync(gone, { recursive: true });
    temps.removeAll();
    assert.equal(fs.existsSync(full), false);
    assert.equal(fs.existsSync(kept), true);
});

await test('withoutLockLines drops locked lines of a real locked worktree', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const repo = makeRepo(root, env);
    const linked = path.join(root, 'linked');
    gitSync(env, ['-C', repo.main, 'worktree', 'add', '--quiet', '-b', 'linked', linked]);
    gitSync(env, ['-C', repo.main, 'worktree', 'lock', '--reason', 'test', linked]);
    const request: CommandRequest = { file: 'git', args: ['-C', repo.main, 'worktree', 'list', '--porcelain'] };
    const inner = createProcessRunner(env);
    const plain = await inner.run(request);
    assert.match(plain.stdout, /^locked/mu);
    const result = await withoutLockLines(inner).run(request);
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.stdout, /^(?:locked|prunable)/mu);
    assert.ok(result.stdout.split('\n').includes(`worktree ${linked}`));
});

await test('withoutCow refuses a cloning cp and passes a plain cp through', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const source = path.join(root, 'a');
    const cloned = path.join(root, 'b');
    const copied = path.join(root, 'c');
    fs.writeFileSync(source, 'data');
    const runner = withoutCow(createProcessRunner(env));
    const refused = await runner.run({ file: 'cp', args: ['--reflink=always', source, cloned] });
    assert.equal(refused.code, 1);
    assert.equal(refused.stderr, 'failed to clone');
    assert.equal(fs.existsSync(cloned), false);
    const macRefused = await runner.run({ file: '/bin/cp', args: ['-c', source, cloned] });
    assert.equal(macRefused.code, 1);
    assert.equal(fs.existsSync(cloned), false);
    const plain = await runner.run({ file: 'cp', args: [source, copied] });
    assert.equal(plain.code, 0);
    assert.equal(fs.readFileSync(copied, 'utf8'), 'data');
});

await test('withCowEmulation copies without the clone flags and records the original request', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const source = path.join(root, 'a');
    const target = path.join(root, 'b');
    fs.writeFileSync(source, 'data');
    const runner = withCowEmulation(createProcessRunner(env));
    const args = ['--reflink=always', '-R', source, target];
    const result = await runner.run({ file: 'cp', args });
    assert.equal(result.code, 0);
    assert.equal(fs.readFileSync(target, 'utf8'), 'data');
    assert.deepEqual(
        runner.calls.map((call) => call.args),
        [args]
    );
});

await test('recording and withOverride wrap an inner runner', async () => {
    const inner = createProcessRunner(process.env);
    const canned = { code: 9, stdout: 'canned', stderr: '' };
    const runner = recording(withOverride(inner, (request) => request.args.includes('override'), canned));
    const overridden = await runner.run({ file: '/bin/sh', args: ['-c', 'exit 0', 'override'] });
    const passed = await runner.run({ file: '/bin/sh', args: ['-c', 'printf real'] });
    assert.deepEqual(overridden, canned);
    assert.equal(passed.stdout, 'real');
    assert.equal(runner.calls.length, 2);
    await runner.terminateAll();
});

await test('testDeps logs full lines and runs real commands', async (t) => {
    const root = tempRoot(t);
    const env: Env = testEnv(root);
    const deps = testDeps(env);
    deps.log.info('hello');
    assert.equal(deps.lines.length, 1);
    assert.match(deps.lines[0] ?? '', LOG_LINE);
    assert.equal(deps.platform, 'linux');
    assert.equal(deps.pid, process.pid);
    const result = await deps.runner.run({ file: 'git', args: ['--version'] });
    assert.equal(result.code, 0);
    assert.equal(testDeps(env, { platform: 'darwin' }).platform, 'darwin');
});

await test('realToolPath finds an executable on PATH and writeStubTool makes one', (t) => {
    const root = tempRoot(t);
    const bin = path.join(root, 'bin');
    writeStubTool(bin, 'wta-stub', 'printf stub');
    const env: Env = { PATH: `${bin}:${process.env.PATH ?? ''}` };
    assert.equal(realToolPath('wta-stub', env), path.join(bin, 'wta-stub'));
    assert.equal(spawnSync(realToolPath('wta-stub', env), { encoding: 'utf8' }).stdout, 'stub');
    assert.ok(path.isAbsolute(realToolPath('sh', env)));
    assert.throws(() => realToolPath('wta-no-such-tool', env));
});
