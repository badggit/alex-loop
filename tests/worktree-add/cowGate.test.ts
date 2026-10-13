import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import {
    cloneFlags,
    createCloneGate,
    findSampleFile,
    isApfsMount,
    parseDfMount,
} from '../../src/worktree-add/cowGate.ts';
import { cpFile, TEMP_PREFIX } from '../../src/worktree-add/place.ts';
import { createProcessRunner } from '../../src/worktree-add/proc.ts';
import { createTempRegistry } from '../../src/worktree-add/temps.ts';
import type {
    CommandRequest,
    CommandResult,
    CommandRunner,
    Deps,
    GateRequest,
    TempRegistry,
} from '../../src/worktree-add/types.ts';

import { testDeps } from './support/deps.ts';
import { testEnv } from './support/git.ts';
import { recording, withCowEmulation, withOverride, withoutCow } from './support/runners.ts';
import { tempRoot } from './support/tmp.ts';

const DF_HEADER = 'Filesystem 1024-blocks Used Available Capacity Mounted on';
const SPACED_DF = `${DF_HEADER}\n/dev/disk4s1   100  1  2   3%   /Volumes/My Disk\n`;
const NO_COW = { kind: 'unavailable', reason: 'no copy-on-write between the clone and the worktree' } as const;
const NOT_APFS = { kind: 'unavailable', reason: 'the worktree volume is not APFS' } as const;
const VOLUME_READ_FAILURE = { kind: 'unavailable', reason: 'cannot read the volume type' } as const;

interface Fixture {
    root: string;
    request: GateRequest;
    source: string;
}

// ROOT/main/node_modules (empty) and ROOT/worktree, with a gate request for node_modules.
function fixture(t: TestContext): Fixture {
    const root = tempRoot(t);
    const main = path.join(root, 'main');
    const worktree = path.join(root, 'worktree');
    const source = path.join(main, 'node_modules');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(worktree);
    return { root, request: { main, worktree, rel: 'node_modules' }, source };
}

function addSample(source: string): string {
    const sample = path.join(source, 'pkg', 'index.js');
    fs.mkdirSync(path.dirname(sample), { recursive: true });
    fs.writeFileSync(sample, 'module\n');
    return sample;
}

function recordingTemps(): TempRegistry & { events: string[] } {
    const inner = createTempRegistry();
    const events: string[] = [];
    return {
        events,
        add: (file) => {
            events.push(`add ${file}`);
            inner.add(file);
        },
        remove: (file) => {
            events.push(`remove ${file}`);
            inner.remove(file);
        },
        removeAll: () => {
            inner.removeAll();
        },
    };
}

function probeLeftovers(dir: string): string[] {
    return fs.readdirSync(dir).filter((name) => name.startsWith(TEMP_PREFIX));
}

function linuxDeps(root: string, wrap: (_inner: CommandRunner) => CommandRunner): Deps & { lines: string[] } {
    const env = testEnv(root);
    return testDeps(env, { runner: wrap(createProcessRunner(env)) });
}

// The darwin tools run through /usr/bin/env LC_ALL=C, so the tool path is the second argument.
function isDarwinTool(request: CommandRequest, tool: string): boolean {
    return request.file === '/usr/bin/env' && request.args[0] === 'LC_ALL=C' && request.args[1] === tool;
}

const refuseEverything: CommandRunner = {
    run: () => Promise.resolve({ code: 127, stdout: '', stderr: '', spawnError: 'ENOENT' }),
    terminateAll: () => Promise.resolve(),
};

function darwinRunner(df: CommandResult, mount: CommandResult): CommandRunner & { calls: CommandRequest[] } {
    const answered = withOverride(
        withOverride(refuseEverything, (request) => isDarwinTool(request, '/bin/df'), df),
        (request) => isDarwinTool(request, '/sbin/mount'),
        mount
    );
    return recording(answered);
}

function ok(stdout: string): CommandResult {
    return { code: 0, stdout, stderr: '' };
}

function darwinDeps(root: string, runner: CommandRunner): Deps {
    return testDeps(testEnv(root), { runner, platform: 'darwin' });
}

// Whether cp --reflink=always works inside dir on this host; the copy is removed again.
function hostSupportsReflink(dir: string): boolean {
    const file = path.join(dir, 'host-probe-source');
    const copy = path.join(dir, 'host-probe-copy');
    fs.writeFileSync(file, 'probe\n');
    const result = spawnSync('cp', ['--reflink=always', file, copy], { encoding: 'utf8' });
    fs.rmSync(copy, { force: true });
    fs.rmSync(file, { force: true });
    return result.error === undefined && result.status === 0;
}

await describe('cloneFlags and cpFile', async () => {
    await test('give the clone flag and cp per platform', () => {
        assert.deepEqual(cloneFlags('linux'), ['--reflink=always']);
        assert.deepEqual(cloneFlags('darwin'), ['-c']);
        assert.equal(cloneFlags('freebsd'), undefined);
        assert.equal(cloneFlags('win32'), undefined);
        assert.equal(cpFile('darwin'), '/bin/cp');
        assert.equal(cpFile('linux'), 'cp');
        assert.equal(cpFile('freebsd'), 'cp');
    });
});

await describe('parseDfMount and isApfsMount', async () => {
    await test('parseDfMount keeps a space inside and at the end of a mount point', () => {
        assert.deepEqual(parseDfMount(SPACED_DF), { device: '/dev/disk4s1', mountPoint: '/Volumes/My Disk' });
        const trailing = `${DF_HEADER}\n/dev/disk4s1 100 1 2 3% /Volumes/Disk \n`;
        assert.deepEqual(parseDfMount(trailing), { device: '/dev/disk4s1', mountPoint: '/Volumes/Disk ' });
    });

    await test('parseDfMount gives undefined for a header only or a line without capacity', () => {
        assert.equal(parseDfMount(''), undefined);
        assert.equal(parseDfMount(`${DF_HEADER}\n`), undefined);
        assert.equal(parseDfMount(`${DF_HEADER}\n/dev/disk3s5 1 2 3 52 /System/Volumes/Data\n`), undefined);
    });

    await test('isApfsMount accepts only an apfs line for exactly that device and mount point', () => {
        const mount = { device: '/dev/disk4s1', mountPoint: '/Volumes/My Disk' };
        assert.equal(isApfsMount('/dev/disk4s1 on /Volumes/My Disk (apfs, local, journaled)\n', mount), true);
        assert.equal(isApfsMount('/dev/disk4s1 on /Volumes/My Disk (hfs, local, journaled)\n', mount), false);
        assert.equal(isApfsMount('/dev/disk9s1 on /Volumes/My Disk (apfs, local)\n', mount), false);
        assert.equal(isApfsMount('/dev/disk4s1 on /Volumes/My (apfs, local)\n', mount), false);
    });
});

await describe('findSampleFile', async () => {
    await test('returns a nested regular file and skips symlinks', (t) => {
        const root = tempRoot(t);
        fs.mkdirSync(path.join(root, 'tree', 'pkg'), { recursive: true });
        fs.writeFileSync(path.join(root, 'tree', 'pkg', 'index.js'), 'x');
        fs.symlinkSync(path.join(root, 'tree', 'pkg', 'index.js'), path.join(root, 'tree', 'link.js'));
        assert.equal(findSampleFile(path.join(root, 'tree')), path.join(root, 'tree', 'pkg', 'index.js'));
    });

    await test('never follows a symlinked folder', (t) => {
        const root = tempRoot(t);
        fs.mkdirSync(path.join(root, 'outside'));
        fs.writeFileSync(path.join(root, 'outside', 'real.js'), 'x');
        fs.mkdirSync(path.join(root, 'tree', 'empty'), { recursive: true });
        fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'tree', 'dir-link'));
        assert.equal(findSampleFile(path.join(root, 'tree')), undefined);
    });

    await test('gives up after its entry limit', (t) => {
        const root = tempRoot(t);
        fs.mkdirSync(path.join(root, 'a', 'b', 'c'), { recursive: true });
        fs.writeFileSync(path.join(root, 'a', 'b', 'c', 'index.js'), 'x');
        assert.equal(findSampleFile(root, 2), undefined);
        assert.equal(findSampleFile(root), path.join(root, 'a', 'b', 'c', 'index.js'));
    });

    await test('a missing folder gives undefined', (t) => {
        assert.equal(findSampleFile(path.join(tempRoot(t), 'missing')), undefined);
    });
});

await describe('createCloneGate on Linux', async () => {
    await test('an emulated clone is available, the probe is registered and removed, the answer is cached', async (t) => {
        const { root, request, source } = fixture(t);
        const sample = addSample(source);
        const cow = withCowEmulation(createProcessRunner(testEnv(root)));
        const temps = recordingTemps();
        const deps = testDeps(testEnv(root), { runner: cow, temps });
        const gate = createCloneGate();
        assert.deepEqual(await gate.check(deps, request), { kind: 'available' });
        const probe = path.join(request.worktree, `${TEMP_PREFIX}${String(deps.pid)}-1`);
        assert.deepEqual(cow.calls, [{ file: 'cp', args: ['--reflink=always', sample, probe] }]);
        assert.deepEqual(temps.events, [`add ${probe}`, `remove ${probe}`]);
        assert.equal(fs.existsSync(probe), false);
        assert.deepEqual(await gate.check(deps, request), { kind: 'available' });
        assert.equal(cow.calls.length, 1);
    });

    await test('the probe name skips an existing name and sits in the destination folder', async (t) => {
        const { root, request, source } = fixture(t);
        addSample(source);
        const nested = { ...request, rel: 'packages/app/node_modules' };
        fs.mkdirSync(path.join(request.main, nested.rel), { recursive: true });
        addSample(path.join(request.main, nested.rel));
        const destination = path.join(request.worktree, 'packages', 'app');
        fs.mkdirSync(destination, { recursive: true });
        const taken = path.join(destination, `${TEMP_PREFIX}${String(process.pid)}-1`);
        fs.writeFileSync(taken, 'taken\n');
        const cow = withCowEmulation(createProcessRunner(testEnv(root)));
        const deps = testDeps(testEnv(root), { runner: cow });
        assert.deepEqual(await createCloneGate().check(deps, nested), { kind: 'available' });
        assert.equal(cow.calls[0]?.args[2], path.join(destination, `${TEMP_PREFIX}${String(process.pid)}-2`));
        assert.deepEqual(probeLeftovers(destination), [path.basename(taken)]);
    });

    await test('a regular file at MAIN/REL is its own sample', async (t) => {
        const { root, request } = fixture(t);
        fs.writeFileSync(path.join(request.main, '.env'), 'A=1\n');
        const cow = withCowEmulation(createProcessRunner(testEnv(root)));
        const deps = testDeps(testEnv(root), { runner: cow });
        assert.deepEqual(await createCloneGate().check(deps, { ...request, rel: '.env' }), { kind: 'available' });
        assert.equal(cow.calls[0]?.args[1], path.join(request.main, '.env'));
    });

    await test('an empty source folder is available and not cached', async (t) => {
        const { root, request, source } = fixture(t);
        fs.mkdirSync(path.join(source, 'empty'));
        const cow = withCowEmulation(createProcessRunner(testEnv(root)));
        const deps = testDeps(testEnv(root), { runner: cow });
        const gate = createCloneGate();
        assert.deepEqual(await gate.check(deps, request), { kind: 'available' });
        assert.equal(cow.calls.length, 0);
        addSample(source);
        assert.deepEqual(await gate.check(deps, request), { kind: 'available' });
        assert.equal(cow.calls.length, 1);
        assert.deepEqual(probeLeftovers(request.worktree), []);
    });

    await test('the answer matches what the host reports for a real reflink copy', async (t) => {
        const { root, request, source } = fixture(t);
        const hostReflink = hostSupportsReflink(root);
        assert.equal(fs.existsSync(path.join(root, 'host-probe-copy')), false);
        addSample(source);
        const deps = linuxDeps(root, (inner) => inner);
        const result = await createCloneGate().check(deps, request);
        assert.deepEqual(result, hostReflink ? { kind: 'available' } : NO_COW);
        assert.deepEqual(probeLeftovers(request.worktree), []);
    });

    await test('no copy-on-write is unavailable, the probe is registered, unregistered and gone', async (t) => {
        const { root, request, source } = fixture(t);
        addSample(source);
        const temps = recordingTemps();
        const env = testEnv(root);
        const runner = recording(withoutCow(createProcessRunner(env)));
        const deps = testDeps(env, { runner, temps });
        const gate = createCloneGate();
        assert.deepEqual(await gate.check(deps, request), NO_COW);
        const probe = path.join(request.worktree, `${TEMP_PREFIX}${String(deps.pid)}-1`);
        assert.deepEqual(temps.events, [`add ${probe}`, `remove ${probe}`]);
        assert.deepEqual(probeLeftovers(request.worktree), []);
        assert.deepEqual(await gate.check(deps, request), NO_COW);
        assert.equal(runner.calls.length, 1);
    });

    await test('a partial probe left by a failing cp is removed', async (t) => {
        const { root, request, source } = fixture(t);
        addSample(source);
        const partialCp: CommandRunner = {
            run: (command) => {
                const probe = command.args.at(-1);
                if (probe !== undefined) {
                    fs.writeFileSync(probe, 'partial\n');
                }
                return Promise.resolve({ code: 1, stdout: '', stderr: 'failed to clone' });
            },
            terminateAll: () => Promise.resolve(),
        };
        const deps = testDeps(testEnv(root), { runner: partialCp });
        assert.deepEqual(await createCloneGate().check(deps, request), NO_COW);
        assert.deepEqual(probeLeftovers(request.worktree), []);
    });
});

await describe('createCloneGate on other platforms', async () => {
    await test('an unsupported platform is unavailable without running anything', async (t) => {
        const { root, request, source } = fixture(t);
        addSample(source);
        const runner = recording(refuseEverything);
        const deps = testDeps(testEnv(root), { runner, platform: 'freebsd' });
        assert.deepEqual(await createCloneGate().check(deps, request), {
            kind: 'unavailable',
            reason: 'copy-on-write clones are not supported on this platform',
        });
        assert.equal(runner.calls.length, 0);
    });

    await test('darwin on one APFS device is available and cached', async (t) => {
        const { root, request } = fixture(t);
        const runner = darwinRunner(ok(SPACED_DF), ok('/dev/disk4s1 on /Volumes/My Disk (apfs, local, journaled)\n'));
        const gate = createCloneGate({ deviceOf: () => 1 });
        const deps = darwinDeps(root, runner);
        assert.deepEqual(await gate.check(deps, request), { kind: 'available' });
        assert.deepEqual(runner.calls, [
            { file: '/usr/bin/env', args: ['LC_ALL=C', '/bin/df', '-P', request.worktree] },
            { file: '/usr/bin/env', args: ['LC_ALL=C', '/sbin/mount'] },
        ]);
        assert.deepEqual(await gate.check(deps, request), { kind: 'available' });
        assert.equal(runner.calls.length, 2);
    });

    await test('darwin with an hfs mount line gives the APFS reason', async (t) => {
        const { root, request } = fixture(t);
        const runner = darwinRunner(ok(SPACED_DF), ok('/dev/disk4s1 on /Volumes/My Disk (hfs, local, journaled)\n'));
        assert.deepEqual(
            await createCloneGate({ deviceOf: () => 1 }).check(darwinDeps(root, runner), request),
            NOT_APFS
        );
    });

    await test('darwin with two devices gives the different-volumes reason without running tools', async (t) => {
        const { root, request, source } = fixture(t);
        const runner = darwinRunner(ok(SPACED_DF), ok('/dev/disk4s1 on /Volumes/My Disk (apfs, local)\n'));
        const seen: string[] = [];
        const gate = createCloneGate({
            deviceOf: (file) => {
                seen.push(file);
                return file === source ? 2 : 1;
            },
        });
        assert.deepEqual(await gate.check(darwinDeps(root, runner), request), {
            kind: 'unavailable',
            reason: 'the clone and the worktree are on different volumes',
        });
        assert.deepEqual(seen, [source, request.worktree, request.worktree]);
        assert.equal(runner.calls.length, 0);
    });

    await test('darwin with a failing df cannot read the volume type', async (t) => {
        const { root, request } = fixture(t);
        const runner = darwinRunner(
            { code: 1, stdout: '', stderr: 'df: failed' },
            ok('/dev/disk4s1 on /Volumes/My Disk (apfs, local)\n')
        );
        const gate = createCloneGate({ deviceOf: () => 1 });
        assert.deepEqual(await gate.check(darwinDeps(root, runner), request), VOLUME_READ_FAILURE);
    });

    await test('darwin with unreadable df output cannot read the volume type', async (t) => {
        const { root, request } = fixture(t);
        const runner = darwinRunner(ok(DF_HEADER), ok('/dev/disk4s1 on /Volumes/My Disk (apfs, local)\n'));
        const gate = createCloneGate({ deviceOf: () => 1 });
        assert.deepEqual(await gate.check(darwinDeps(root, runner), request), VOLUME_READ_FAILURE);
    });
});
