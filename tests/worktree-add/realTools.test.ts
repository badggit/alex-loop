import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { runWorktreeAdd, type CommandIo } from '../../src/worktree-add/command.ts';
import { SANDBOX_NETWORK_VARIABLE } from '../../src/worktree-add/installStage.ts';
import { createProcessRunner } from '../../src/worktree-add/proc.ts';
import type { CommandRequest, Deps, Env, Outcome } from '../../src/worktree-add/types.ts';

import { testDeps } from './support/deps.ts';
import { gitSync, makeRepo, testEnv } from './support/git.ts';
import { tempRoot } from './support/tmp.ts';
import { realToolPath } from './support/tools.ts';

interface Fixture {
    root: string;
    env: Env;
    main: string;
    deps: Deps & { lines: string[] };
    calls: CommandRequest[];
}

interface ToolResult {
    ok: boolean;
    stdout: string;
    output: string;
}

const MAIN_TEXT = 'a from the main clone';
const WORKTREE_TEXT = 'a from the worktree';

function definedEnv(env: Env): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) {
        if (value !== undefined) {
            result[name] = value;
        }
    }
    return result;
}

function runTool(env: Env, file: string, args: readonly string[], cwd: string): ToolResult {
    const result = spawnSync(file, [...args], { cwd, env: definedEnv(env), encoding: 'utf8', timeout: 60_000 });
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const stderr = typeof result.stderr === 'string' ? result.stderr : '';
    return { ok: result.error === undefined && result.status === 0, stdout, output: `${stdout}${stderr}` };
}

// The first missing tool of names on the PATH of env, or undefined when all are there.
function missingTool(env: Env, names: readonly string[]): string | undefined {
    for (const name of names) {
        try {
            realToolPath(name, env);
        } catch {
            return name;
        }
    }
    return undefined;
}

// The test env without npm_config_* keys, which npm test sets and which would override the isolated HOME and
// the committed .npmrc; npm gets its own empty cache instead.
function isolatedEnv(root: string): Env {
    const inherited = Object.entries(testEnv(root)).filter(([name]) => !name.toLowerCase().startsWith('npm_config_'));
    return { ...Object.fromEntries(inherited), npm_config_cache: path.join(root, 'npm-cache') };
}

// A main clone app with the inherited PATH and an isolated HOME; the sandbox switch is cleared so the stage
// always tries the install. Every command the stage runs is recorded in calls.
function makeFixture(t: TestContext, extraEnv: Env = {}): Fixture {
    const root = tempRoot(t);
    const env: Env = { ...isolatedEnv(root), [SANDBOX_NETWORK_VARIABLE]: undefined, ...extraEnv };
    const { main } = makeRepo(root, env);
    const runner = createProcessRunner(env);
    t.after(() => runner.terminateAll());
    const calls: CommandRequest[] = [];
    const recording = {
        run: (request: CommandRequest) => {
            calls.push(request);
            return runner.run(request);
        },
        terminateAll: () => runner.terminateAll(),
    };
    return { root, env, main, calls, deps: testDeps(env, { runner: recording }) };
}

function writeFile(dir: string, rel: string, text: string): void {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
}

function commitAll(env: Env, dir: string): void {
    gitSync(env, ['-C', dir, 'add', '--all']);
    gitSync(env, ['-C', dir, 'commit', '--quiet', '-m', 'project']);
}

function run(f: Fixture, suffix: string, extra: Partial<CommandIo> = {}): Promise<Outcome> {
    return runWorktreeAdd({ deps: f.deps, env: f.env, cwd: f.main, ...extra }, ['--suffix', suffix]);
}

function okPath(outcome: Outcome): string {
    assert.equal(outcome.kind, 'ok', JSON.stringify(outcome));
    return outcome.kind === 'ok' ? outcome.path : '';
}

// Every entry under dir (scoped folders opened) with its link target, or 'dir'/'file' for the rest.
function snapshot(dir: string): string[] {
    const result: string[] = [];
    for (const name of fs.readdirSync(dir).toSorted()) {
        const full = path.join(dir, name);
        const stat = fs.lstatSync(full);
        if (stat.isSymbolicLink()) {
            result.push(`${name} -> ${fs.readlinkSync(full)}`);
        } else if (name.startsWith('@') && stat.isDirectory()) {
            result.push(...snapshot(full).map((entry) => `${name}/${entry}`));
        } else {
            result.push(`${name} ${stat.isDirectory() ? 'dir' : 'file'}`);
        }
    }
    return result;
}

// Listens on 127.0.0.1 at a system-chosen port, accepts every connection and never answers; closed when t ends.
async function silentServer(t: TestContext): Promise<number> {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('error', () => {
            sockets.delete(socket);
        });
        socket.on('close', () => {
            sockets.delete(socket);
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            resolve();
        });
    });
    t.after(
        () =>
            new Promise<void>((resolve) => {
                for (const socket of sockets) {
                    socket.destroy();
                }
                server.close(() => {
                    resolve();
                });
            })
    );
    const address = server.address();
    assert.ok(address !== null && typeof address === 'object');
    return address.port;
}

await test('npm workspaces: the worktree links its own packages and the main clone stays untouched', async (t) => {
    const f = makeFixture(t);
    const missing = missingTool(f.env, ['npm', 'node']);
    if (missing !== undefined) {
        t.skip(`${missing} is not on PATH`);
        return;
    }
    const npm = realToolPath('npm', f.env);
    const node = realToolPath('node', f.env);
    writeFile(f.main, '.gitignore', 'node_modules/\n');
    writeFile(f.main, 'package.json', '{"name":"ws-root","private":true,"workspaces":["packages/*"]}\n');
    writeFile(f.main, 'packages/a/package.json', '{"name":"a","version":"1.0.0","main":"index.js"}\n');
    writeFile(f.main, 'packages/a/index.js', `module.exports = '${MAIN_TEXT}';\n`);
    writeFile(f.main, 'packages/b/package.json', '{"name":"b","version":"1.0.0","dependencies":{"a":"1.0.0"}}\n');
    const install = runTool(f.env, npm, ['install', '--offline', '--no-audit', '--no-fund'], f.main);
    if (!install.ok || !fs.existsSync(path.join(f.main, 'package-lock.json'))) {
        t.skip(`npm install --offline cannot make the lock in setup: ${install.output.trim()}`);
        return;
    }
    commitAll(f.env, f.main);
    const mainModules = path.join(f.main, 'node_modules');
    const before = snapshot(mainModules);
    const worktree = okPath(await run(f, 'npm-ws'));
    assert.equal(
        fs.realpathSync(path.join(worktree, 'node_modules', 'a')),
        fs.realpathSync(path.join(worktree, 'packages', 'a')),
        f.deps.lines.join('\n')
    );
    fs.writeFileSync(path.join(worktree, 'packages', 'a', 'index.js'), `module.exports = '${WORKTREE_TEXT}';\n`);
    const required = runTool(f.env, node, ['-e', "console.log(require('a'))"], worktree);
    assert.ok(required.ok, required.output);
    assert.equal(required.stdout.trim(), WORKTREE_TEXT);
    assert.deepEqual(snapshot(mainModules), before);
    const again = runTool(f.env, npm, ['ci', '--offline', '--no-audit', '--no-fund'], worktree);
    assert.ok(again.ok, again.output);
    assert.deepEqual(snapshot(mainModules), before);
    const fromMain = runTool(f.env, node, ['-e', "console.log(require('a'))"], f.main);
    assert.ok(fromMain.ok, fromMain.output);
    assert.equal(fromMain.stdout.trim(), MAIN_TEXT, fromMain.output);
});

await test('an unreachable registry ends the run ok with a network warning and no node_modules', async (t) => {
    const f = makeFixture(t);
    const missing = missingTool(f.env, ['npm']);
    if (missing !== undefined) {
        t.skip(`${missing} is not on PATH`);
        return;
    }
    const port = await silentServer(t);
    const registry = `http://127.0.0.1:${String(port)}/`;
    const lock = {
        name: 'demo',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: {
            '': { name: 'demo', version: '1.0.0', dependencies: { 'wta-missing': '1.0.0' } },
            'node_modules/wta-missing': {
                version: '1.0.0',
                resolved: `${registry}wta-missing/-/wta-missing-1.0.0.tgz`,
                integrity: `sha512-${'A'.repeat(86)}==`,
            },
        },
    };
    writeFile(f.main, '.gitignore', 'node_modules/\n');
    writeFile(f.main, '.npmrc', `registry=${registry}\n`);
    writeFile(f.main, 'package.json', '{"name":"demo","version":"1.0.0","dependencies":{"wta-missing":"1.0.0"}}\n');
    writeFile(f.main, 'package-lock.json', `${JSON.stringify(lock, undefined, 2)}\n`);
    commitAll(f.env, f.main);
    const started = Date.now();
    const outcome = await run(f, 'npm-net', { timing: { networkTimeoutMs: 2000, phaseMs: 60_000 } });
    const elapsed = Date.now() - started;
    const worktree = okPath(outcome);
    const log = f.deps.lines.join('\n');
    assert.ok(elapsed < 30_000, `the run took ${String(elapsed)} ms\n${log}`);
    assert.ok(
        f.deps.lines.some((line) => / warn .*network unreachable/u.test(line)),
        log
    );
    assert.ok(!f.deps.lines.some((line) => line.includes('ENOTCACHED')), log);
    assert.equal(fs.lstatSync(path.join(worktree, 'node_modules'), { throwIfNoEntry: false }), undefined);
});

await test('uv editable project: each clone imports its own source', async (t) => {
    const missing = missingTool(process.env, ['uv']);
    if (missing !== undefined) {
        t.skip(`${missing} is not on PATH`);
        return;
    }
    const cacheDir = runTool(process.env, realToolPath('uv', process.env), ['cache', 'dir'], process.cwd());
    if (!cacheDir.ok || cacheDir.stdout.trim().length === 0) {
        t.skip(`uv cache dir failed: ${cacheDir.output.trim()}`);
        return;
    }
    const f = makeFixture(t, { UV_CACHE_DIR: cacheDir.stdout.trim() });
    const uv = realToolPath('uv', f.env);
    writeFile(f.main, '.gitignore', '.venv/\n');
    writeFile(
        f.main,
        'pyproject.toml',
        [
            '[project]',
            'name = "demo"',
            'version = "0.1.0"',
            'requires-python = ">=3.8"',
            'dependencies = []',
            '',
            '[build-system]',
            'requires = ["uv_build"]',
            'build-backend = "uv_build"',
            '',
        ].join('\n')
    );
    writeFile(f.main, 'src/demo/__init__.py', 'NAME = "demo"\n');
    for (const args of [
        ['lock', '--offline'],
        ['sync', '--frozen', '--offline'],
    ]) {
        const setup = runTool(f.env, uv, args, f.main);
        if (!setup.ok) {
            t.skip(`uv ${args.join(' ')} fails in setup: ${setup.output.trim()}`);
            return;
        }
    }
    commitAll(f.env, f.main);
    const worktree = okPath(await run(f, 'uv-edit'));
    const log = f.deps.lines.join('\n');
    const uvCalls = f.calls.filter(
        (call) => (call.file === uv || path.basename(call.file) === 'uv') && call.args[0] === 'sync'
    );
    assert.ok(uvCalls.length > 0, log);
    assert.ok(
        uvCalls.every((call) => call.args.includes('--offline')),
        `an online uv attempt ran: ${JSON.stringify(uvCalls.map((call) => call.args))}\n${log}`
    );
    assert.ok(!f.deps.lines.some((line) => line.includes(' warn ')), log);
    assert.ok(
        f.deps.lines.some((line) => line.includes(' info installed dependencies with uv ')),
        log
    );
    const script = ['-c', 'import demo; print(demo.__file__)'];
    const inWorktree = runTool(f.env, path.join(worktree, '.venv', 'bin', 'python'), script, worktree);
    assert.ok(inWorktree.ok, `${inWorktree.output}\n${f.deps.lines.join('\n')}`);
    assert.ok(inWorktree.stdout.trim().startsWith(`${worktree}${path.sep}`), inWorktree.stdout);
    const inMain = runTool(f.env, path.join(f.main, '.venv', 'bin', 'python'), script, f.main);
    assert.ok(inMain.ok, inMain.output);
    assert.ok(inMain.stdout.trim().startsWith(`${f.main}${path.sep}`), inMain.stdout);
});
