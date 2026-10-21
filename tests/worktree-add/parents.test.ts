import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { blockedReason, ensureParents } from '../../src/worktree-add/parents.ts';

import { tempRoot } from './support/tmp.ts';

const MODULE_URL = pathToFileURL(path.join(import.meta.dirname, '../../src/worktree-add/parents.ts')).href;

function isRealFolder(file: string): boolean {
    const stat = fs.lstatSync(file);
    return stat.isDirectory() && !stat.isSymbolicLink();
}

function listTree(root: string): string[] {
    return fs.readdirSync(root, { recursive: true, encoding: 'utf8' }).toSorted();
}

// Runs ensureParents over every rel in a separate Node process and resolves with the JSON results it printed.
function ensureInChild(worktree: string, rels: string[]): Promise<string> {
    const script = [
        `import { ensureParents } from ${JSON.stringify(MODULE_URL)};`,
        `const rels = ${JSON.stringify(rels)};`,
        `const results = rels.map((rel) => ensureParents(${JSON.stringify(worktree)}, rel));`,
        'process.stdout.write(JSON.stringify(results));',
    ].join('\n');
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
            stdio: ['ignore', 'pipe', 'inherit'],
        });
        let out = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            out += chunk;
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolve(out);
            } else {
                reject(new Error(`child exited with ${String(code)}`));
            }
        });
    });
}

await test('creates every missing parent as a real folder and is idempotent', (t) => {
    const worktree = tempRoot(t);
    assert.deepEqual(ensureParents(worktree, 'apps/api/secrets/.env'), { ok: true });
    for (const rel of ['apps', 'apps/api', 'apps/api/secrets']) {
        assert.equal(isRealFolder(path.join(worktree, rel)), true, rel);
    }
    assert.equal(fs.existsSync(path.join(worktree, 'apps/api/secrets/.env')), false);
    const before = listTree(worktree);
    assert.deepEqual(ensureParents(worktree, 'apps/api/secrets/.env'), { ok: true });
    assert.deepEqual(listTree(worktree), before);
});

await test('a top-level rel is ok and touches nothing', (t) => {
    const worktree = tempRoot(t);
    assert.deepEqual(ensureParents(worktree, '.env'), { ok: true });
    assert.deepEqual(listTree(worktree), []);
});

await test('a symlinked parent stops with cause link and nothing is created through it', (t) => {
    const root = tempRoot(t);
    const worktree = path.join(root, 'wt');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(worktree, 'src/oldpkg'));
    assert.deepEqual(ensureParents(worktree, 'src/oldpkg/x'), {
        ok: false,
        blocker: 'src/oldpkg',
        cause: 'link',
        code: '',
    });
    assert.deepEqual(listTree(outside), []);
    assert.deepEqual(ensureParents(worktree, 'src/oldpkg/deep/er/x'), {
        ok: false,
        blocker: 'src/oldpkg',
        cause: 'link',
        code: '',
    });
    assert.deepEqual(listTree(outside), []);
});

await test('a link pointing inside the worktree is still a blocker', (t) => {
    const worktree = tempRoot(t);
    fs.mkdirSync(path.join(worktree, 'real'));
    fs.symlinkSync('real', path.join(worktree, 'alias'));
    assert.deepEqual(ensureParents(worktree, 'alias/sub/x'), {
        ok: false,
        blocker: 'alias',
        cause: 'link',
        code: '',
    });
    assert.deepEqual(listTree(path.join(worktree, 'real')), []);
});

await test('overlapping calls back to back both end with real folders', (t) => {
    const worktree = tempRoot(t);
    const results = [ensureParents(worktree, 'a/b/x'), ensureParents(worktree, 'a/c/y')];
    assert.deepEqual(results, [{ ok: true }, { ok: true }]);
    for (const rel of ['a', 'a/b', 'a/c']) {
        assert.equal(isRealFolder(path.join(worktree, rel)), true, rel);
    }
});

await test('concurrent processes on overlapping paths all end ok with real folders', async (t) => {
    const worktree = tempRoot(t);
    const rels: string[] = [];
    for (let index = 0; index < 50; index += 1) {
        rels.push(`a/n${String(index)}/b/c/x`, `a/n${String(index)}/d/y`);
    }
    const outputs = await Promise.all([
        ensureInChild(worktree, rels),
        ensureInChild(worktree, rels.toReversed()),
        ensureInChild(worktree, rels),
    ]);
    for (const output of outputs) {
        const parsed: unknown = JSON.parse(output);
        assert.ok(Array.isArray(parsed));
        assert.equal(parsed.length, rels.length);
        for (const result of parsed) {
            assert.deepEqual(result, { ok: true });
        }
    }
    for (let index = 0; index < 50; index += 1) {
        for (const rel of [`a/n${String(index)}/b/c`, `a/n${String(index)}/d`]) {
            assert.equal(isRealFolder(path.join(worktree, rel)), true, rel);
        }
    }
});

await test('a symlink placed before the call gives cause link and nothing is created through it', (t) => {
    const root = tempRoot(t);
    const worktree = path.join(root, 'wt');
    const target = path.join(root, 'target');
    fs.mkdirSync(path.join(worktree, 'a'), { recursive: true });
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(worktree, 'a/d'));
    assert.deepEqual(ensureParents(worktree, 'a/d/z'), { ok: false, blocker: 'a/d', cause: 'link', code: '' });
    assert.deepEqual(listTree(target), []);
});

await test('a broken symlink as a parent is a link blocker', (t) => {
    const worktree = tempRoot(t);
    fs.symlinkSync(path.join(worktree, 'missing'), path.join(worktree, 'gone'));
    assert.deepEqual(ensureParents(worktree, 'gone/x'), { ok: false, blocker: 'gone', cause: 'link', code: '' });
    assert.equal(fs.existsSync(path.join(worktree, 'missing')), false);
});

await test('a regular file as a parent stops with cause not-a-folder', (t) => {
    const worktree = tempRoot(t);
    fs.writeFileSync(path.join(worktree, 'notes'), 'text');
    assert.deepEqual(ensureParents(worktree, 'notes/a.txt'), {
        ok: false,
        blocker: 'notes',
        cause: 'not-a-folder',
        code: '',
    });
    assert.equal(fs.readFileSync(path.join(worktree, 'notes'), 'utf8'), 'text');
});

await test('a file deeper down stops at that component and keeps the folders above', (t) => {
    const worktree = tempRoot(t);
    fs.mkdirSync(path.join(worktree, 'a'));
    fs.writeFileSync(path.join(worktree, 'a/b'), '');
    assert.deepEqual(ensureParents(worktree, 'a/b/c/x'), {
        ok: false,
        blocker: 'a/b',
        cause: 'not-a-folder',
        code: '',
    });
    assert.deepEqual(listTree(worktree), ['a', path.join('a', 'b')]);
});

const ROOT_SKIP = process.getuid?.() === 0 ? 'root ignores directory modes' : false;

await test('a parent under a read-only folder stops with cause mkdir-failed', { skip: ROOT_SKIP }, (t) => {
    const worktree = tempRoot(t);
    const locked = path.join(worktree, 'locked');
    fs.mkdirSync(locked, { mode: 0o555 });
    fs.chmodSync(locked, 0o555);
    let result;
    try {
        result = ensureParents(worktree, 'locked/sub/deeper/x');
    } finally {
        fs.chmodSync(locked, 0o755);
    }
    assert.deepEqual(result, { ok: false, blocker: 'locked/sub', cause: 'mkdir-failed', code: 'EACCES' });
    assert.deepEqual(listTree(locked), []);
});

await test('blockedReason names the blocker, and the error code when a folder cannot be created', () => {
    assert.equal(
        blockedReason({ ok: false, blocker: 'a/b', cause: 'mkdir-failed', code: 'EACCES' }),
        'cannot create its folder a/b in the worktree (EACCES)'
    );
    const causes: readonly ('link' | 'not-a-folder')[] = ['link', 'not-a-folder'];
    for (const cause of causes) {
        assert.equal(
            blockedReason({ ok: false, blocker: 'a\nb', cause, code: '' }),
            'its folder a?b in the worktree is a link or not a folder'
        );
    }
});
