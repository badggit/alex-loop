import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { entrySizeKb, placeCopy, sweepDeadTemps, TEMP_PREFIX, tempName } from '../../src/worktree-add/place.ts';
import { pidAlive } from '../../src/worktree-add/proc.ts';
import { createTempRegistry } from '../../src/worktree-add/temps.ts';
import type { CommandRequest, CommandRunner, Deps, TempRegistry } from '../../src/worktree-add/types.ts';

import { testDeps } from './support/deps.ts';
import { testEnv } from './support/git.ts';
import { withCowEmulation, withOverride } from './support/runners.ts';
import { tempRoot } from './support/tmp.ts';

interface TempEvent {
    op: 'add' | 'remove';
    file: string;
}

function recordingTemps(): TempRegistry & { events: TempEvent[] } {
    const inner = createTempRegistry();
    const events: TempEvent[] = [];
    return {
        events,
        add: (file) => {
            events.push({ op: 'add', file });
            inner.add(file);
        },
        remove: (file) => {
            events.push({ op: 'remove', file });
            inner.remove(file);
        },
        removeAll: () => {
            inner.removeAll();
        },
    };
}

// Every added temp is removed again, each add before its remove, and at least one temp was registered.
function assertBalanced(events: readonly TempEvent[]): void {
    const open = new Set<string>();
    for (const event of events) {
        if (event.op === 'add') {
            open.add(event.file);
        } else {
            assert.ok(open.has(event.file), `remove before add: ${event.file}`);
            open.delete(event.file);
        }
    }
    assert.ok(events.length > 0);
    assert.deepEqual([...open], []);
}

function tempsIn(dir: string): string[] {
    return fs.readdirSync(dir).filter((name) => name.startsWith(TEMP_PREFIX));
}

function setup(
    root: string,
    wrap?: (_runner: CommandRunner) => CommandRunner,
    overrides?: Partial<Deps>
): { deps: Deps; events: TempEvent[]; main: string; worktree: string } {
    const main = path.join(root, 'main');
    const worktree = path.join(root, 'worktree');
    fs.mkdirSync(main);
    fs.mkdirSync(worktree);
    const temps = recordingTemps();
    const deps = testDeps(testEnv(root), { temps, ...overrides });
    const runner = wrap === undefined ? deps.runner : wrap(deps.runner);
    return { deps: { ...deps, runner }, events: temps.events, main, worktree };
}

function writeEnvFile(file: string): Buffer {
    const bytes = Buffer.from('SECRET=1\nOTHER=two\n', 'utf8');
    fs.writeFileSync(file, bytes);
    fs.chmodSync(file, 0o600);
    return bytes;
}

function errorWithCode(code: string): Error {
    return Object.assign(new Error(`rename failed: ${code}`), { code });
}

await test('a mode 600 .env is placed as a regular file with the same mode and bytes', async (t) => {
    const { deps, events, main, worktree } = setup(tempRoot(t));
    const source = path.join(main, '.env');
    const dest = path.join(worktree, '.env');
    const bytes = writeEnvFile(source);
    const result = await placeCopy(deps, { source, dest, ownLinkText: source, cloneFlags: [] });
    assert.deepEqual(result, { ok: true });
    const stat = fs.lstatSync(dest);
    assert.ok(stat.isFile());
    assert.equal(stat.mode & 0o777, 0o600);
    assert.deepEqual(fs.readFileSync(dest), bytes);
    assert.deepEqual(tempsIn(worktree), []);
    assertBalanced(events);
});

await test('a temp.local folder keeps its nested file and inner symlink text', async (t) => {
    const { deps, events, main, worktree } = setup(tempRoot(t));
    const source = path.join(main, 'temp.local');
    const dest = path.join(worktree, 'temp.local');
    fs.mkdirSync(path.join(source, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(source, 'sub', 'note.txt'), 'nested\n');
    fs.symlinkSync('sub/note.txt', path.join(source, 'link'));
    const result = await placeCopy(deps, { source, dest, ownLinkText: source, cloneFlags: [] });
    assert.deepEqual(result, { ok: true });
    assert.equal(fs.readFileSync(path.join(dest, 'sub', 'note.txt'), 'utf8'), 'nested\n');
    assert.ok(fs.lstatSync(path.join(dest, 'link')).isSymbolicLink());
    assert.equal(fs.readlinkSync(path.join(dest, 'link')), 'sub/note.txt');
    assertBalanced(events);
});

await test('an own link at DEST is replaced by the copy', async (t) => {
    const { deps, events, main, worktree } = setup(tempRoot(t));
    const source = path.join(main, '.env');
    const dest = path.join(worktree, '.env');
    const bytes = writeEnvFile(source);
    fs.symlinkSync(source, dest);
    const result = await placeCopy(deps, { source, dest, ownLinkText: source, cloneFlags: [] });
    assert.deepEqual(result, { ok: true });
    assert.ok(fs.lstatSync(dest).isFile());
    assert.deepEqual(fs.readFileSync(dest), bytes);
    assert.deepEqual(tempsIn(worktree), []);
    assertBalanced(events);
});

await test('clone flags reach cp and the emulated clone is complete', async (t) => {
    let emulation: (CommandRunner & { calls: CommandRequest[] }) | undefined;
    const { deps, events, main, worktree } = setup(tempRoot(t), (runner) => {
        emulation = withCowEmulation(runner);
        return emulation;
    });
    const source = path.join(main, 'node_modules');
    const dest = path.join(worktree, 'node_modules');
    fs.mkdirSync(path.join(source, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(source, 'pkg', 'index.js'), 'export {};\n');
    const result = await placeCopy(deps, { source, dest, ownLinkText: source, cloneFlags: ['--reflink=always'] });
    assert.deepEqual(result, { ok: true });
    const calls = emulation?.calls ?? [];
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.file, 'cp');
    assert.ok(calls[0]?.args.includes('--reflink=always'));
    assert.deepEqual(calls[0]?.args.slice(0, 3), ['-R', '-P', '-p']);
    assert.equal(calls[0]?.args.at(-2), source);
    assert.equal(fs.readFileSync(path.join(dest, 'pkg', 'index.js'), 'utf8'), 'export {};\n');
    assertBalanced(events);
});

await test('macOS runs the pinned /bin/cp', async (t) => {
    const calls: CommandRequest[] = [];
    const fake: CommandRunner = {
        run: (request) => {
            calls.push(request);
            return Promise.resolve({ code: 1, stdout: '', stderr: '' });
        },
        terminateAll: () => Promise.resolve(),
    };
    const { deps, events, main, worktree } = setup(tempRoot(t), () => fake, { platform: 'darwin' });
    const source = path.join(main, '.env');
    writeEnvFile(source);
    const result = await placeCopy(deps, {
        source,
        dest: path.join(worktree, '.env'),
        ownLinkText: source,
        cloneFlags: ['-c'],
    });
    assert.deepEqual(result, { ok: false, reason: 'cp exited with 1' });
    assert.equal(calls[0]?.file, '/bin/cp');
    assert.deepEqual(calls[0]?.args.slice(0, 4), ['-R', '-P', '-p', '-c']);
    assertBalanced(events);
});

await test('entrySizeKb rounds a file up and sums a folder without following links', (t) => {
    const root = tempRoot(t);
    const file = path.join(root, 'file.bin');
    fs.writeFileSync(file, Buffer.alloc(1500));
    assert.equal(entrySizeKb(file), 2);
    const dir = path.join(root, 'dir');
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.bin'), Buffer.alloc(3000));
    fs.writeFileSync(path.join(dir, 'sub', 'b.bin'), Buffer.alloc(700));
    fs.symlinkSync(file, path.join(dir, 'link'));
    const parts = [dir, path.join(dir, 'sub'), path.join(dir, 'a.bin'), path.join(dir, 'sub', 'b.bin')];
    let total = fs.lstatSync(path.join(dir, 'link')).size;
    for (const part of parts) {
        total += fs.lstatSync(part).size;
    }
    assert.equal(entrySizeKb(dir), Math.ceil(total / 1024));
});

await test('an edited file at DEST is kept and the copy fails without a temp', async (t) => {
    const { deps, events, main, worktree } = setup(tempRoot(t));
    const source = path.join(main, '.env');
    const dest = path.join(worktree, '.env');
    writeEnvFile(source);
    fs.writeFileSync(dest, 'EDITED=1\n');
    const result = await placeCopy(deps, { source, dest, ownLinkText: source, cloneFlags: [] });
    assert.deepEqual(result, { ok: false, reason: `something appeared at ${dest}` });
    assert.equal(fs.readFileSync(dest, 'utf8'), 'EDITED=1\n');
    assert.deepEqual(tempsIn(worktree), []);
    assertBalanced(events);
});

await test('a link with another text at DEST is refused and kept', async (t) => {
    const { deps, events, main, worktree } = setup(tempRoot(t));
    const source = path.join(main, '.env');
    const dest = path.join(worktree, '.env');
    writeEnvFile(source);
    fs.symlinkSync('elsewhere/.env', dest);
    const result = await placeCopy(deps, { source, dest, ownLinkText: source, cloneFlags: [] });
    assert.equal(result.ok, false);
    assert.equal(fs.readlinkSync(dest), 'elsewhere/.env');
    assert.deepEqual(tempsIn(worktree), []);
    assertBalanced(events);
});

await test('tempName skips an existing name', (t) => {
    const root = tempRoot(t);
    assert.equal(tempName(root, 42), path.join(root, `${TEMP_PREFIX}42-1`));
    fs.writeFileSync(path.join(root, `${TEMP_PREFIX}42-1`), '');
    assert.equal(tempName(root, 42), path.join(root, `${TEMP_PREFIX}42-2`));
});

await test('sweepDeadTemps removes temps of dead processes only', (t) => {
    const root = tempRoot(t);
    const child = spawnSync(process.execPath, ['-e', '']);
    assert.equal(child.status, 0);
    assert.ok(child.pid !== undefined && !pidAlive(child.pid));
    const dead = path.join(root, `${TEMP_PREFIX}${String(child.pid)}-1`);
    const own = path.join(root, `${TEMP_PREFIX}${String(process.pid)}-1`);
    const unrelated = path.join(root, `${TEMP_PREFIX}x`);
    fs.mkdirSync(path.join(dead, 'inner'), { recursive: true });
    fs.writeFileSync(own, '');
    fs.writeFileSync(unrelated, '');
    // The own PID is reported dead here, so only the ownPid argument can keep its temp.
    sweepDeadTemps(root, (pid) => pid !== process.pid && pidAlive(pid), process.pid);
    assert.equal(fs.existsSync(dead), false);
    assert.ok(fs.existsSync(own));
    assert.ok(fs.existsSync(unrelated));
    assert.doesNotThrow(() => {
        sweepDeadTemps(path.join(root, 'missing'), pidAlive, process.pid);
    });
    assert.doesNotThrow(() => {
        sweepDeadTemps(
            root,
            () => {
                throw new Error('boom');
            },
            process.pid
        );
    });
});

await test('a failed cp that left a partial file fails with no temp and no DEST', async (t) => {
    // The match writes the partial output into the target, as a cp killed mid-copy would.
    const isCp = (request: CommandRequest): boolean => {
        if (path.basename(request.file) !== 'cp') {
            return false;
        }
        const target = request.args.at(-1) ?? '';
        fs.writeFileSync(target, 'SECR');
        return true;
    };
    const { deps, events, main, worktree } = setup(tempRoot(t), (runner) =>
        withOverride(runner, isCp, { code: 1, stdout: '', stderr: 'cp: write error: No space left\nsecond line\n' })
    );
    const source = path.join(main, '.env');
    const dest = path.join(worktree, '.env');
    writeEnvFile(source);
    const result = await placeCopy(deps, { source, dest, ownLinkText: source, cloneFlags: [] });
    assert.deepEqual(result, { ok: false, reason: 'cp exited with 1: cp: write error: No space left' });
    assert.deepEqual(tempsIn(worktree), []);
    assert.equal(fs.existsSync(dest), false);
    assertBalanced(events);
});

await test('a cp failure reason shows control characters as ?', async (t) => {
    const isCp = (request: CommandRequest): boolean => path.basename(request.file) === 'cp';
    const { deps, events, main, worktree } = setup(tempRoot(t), (runner) =>
        withOverride(runner, isCp, { code: 1, stdout: '', stderr: 'cp: bad\tname\u001B[0m\n' })
    );
    const source = path.join(main, '.env');
    writeEnvFile(source);
    const result = await placeCopy(deps, {
        source,
        dest: path.join(worktree, '.env'),
        ownLinkText: source,
        cloneFlags: [],
    });
    assert.deepEqual(result, { ok: false, reason: 'cp exited with 1: cp: bad?name?[0m' });
    assertBalanced(events);
});

await test('a failed rename restores the own link and leaves no temp', async (t) => {
    const { deps, events, main, worktree } = setup(tempRoot(t));
    const source = path.join(main, '.env');
    const dest = path.join(worktree, '.env');
    writeEnvFile(source);
    fs.symlinkSync(source, dest);
    const result = await placeCopy(deps, { source, dest, ownLinkText: source, cloneFlags: [] }, () => {
        throw errorWithCode('EXDEV');
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.reason.includes('EXDEV'));
    assert.equal(fs.readlinkSync(dest), source);
    assert.deepEqual(tempsIn(worktree), []);
    assertBalanced(events);
});
