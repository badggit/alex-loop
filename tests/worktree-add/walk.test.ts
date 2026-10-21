import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { classifyEntry, entryFacts } from '../../src/worktree-add/rules.ts';
import type { EntryClass } from '../../src/worktree-add/rules.ts';
import { boundedSize, DEFAULT_WALK_LIMITS, walkCollapsed } from '../../src/worktree-add/walk.ts';
import type { WalkResult } from '../../src/worktree-add/walk.ts';

import { tempRoot } from './support/tmp.ts';

function write(main: string, rel: string, bytes = 1): void {
    const full = path.join(main, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'x'.repeat(bytes));
}

function classifier(main: string): (_rel: string) => EntryClass {
    return (rel) => classifyEntry(rel, entryFacts(main, rel));
}

const NOTHING_HANDLED = (): boolean => false;

function walk(
    main: string,
    rel: string,
    handled: (_rel: string) => boolean = NOTHING_HANDLED,
    limits = DEFAULT_WALK_LIMITS
): WalkResult {
    return walkCollapsed(main, rel, classifier(main), handled, limits);
}

function expanded(result: WalkResult): Extract<WalkResult, { kind: 'expanded' }> {
    if (result.kind !== 'expanded') {
        assert.fail(`expected an expanded walk, got ${result.kind}`);
    }
    return result;
}

await test('finds a copy-class file in a nested collapsed folder', (t) => {
    const main = tempRoot(t);
    write(main, 'apps/api/secrets/.env');
    const result = expanded(walk(main, 'apps/api/secrets'));
    assert.deepEqual(result.finds, [{ rel: 'apps/api/secrets/.env', kind: 'copy' }]);
    assert.deepEqual(result.unlinked, []);
    assert.deepEqual(result.unreadable, []);
});

await test('finds the nested agent settings file as a link', (t) => {
    const main = tempRoot(t);
    write(main, 'tools/agent/.claude/settings.local.json');
    const result = expanded(walk(main, 'tools/agent'));
    assert.deepEqual(result.finds, [{ rel: 'tools/agent/.claude/settings.local.json', kind: 'link' }]);
    assert.deepEqual(result.unlinked, []);
});

await test('reports a folder without finds as one entry with its size', (t) => {
    const main = tempRoot(t);
    write(main, 'ml/models/w.bin', 2048);
    const result = expanded(walk(main, 'ml/models'));
    assert.deepEqual(result.finds, []);
    assert.equal(result.unlinked.length, 1);
    const [only] = result.unlinked;
    assert.equal(only?.rel, 'ml/models');
    assert.equal(only.partial, false);
    assert.ok(only.bytes >= 2048, String(only.bytes));
});

await test('a folder with a find reports its unmatched children one by one', (t) => {
    const main = tempRoot(t);
    write(main, 'svc/.env');
    write(main, 'svc/cache/blob.bin', 10);
    write(main, 'svc/db.sqlite3', 5);
    const result = expanded(walk(main, 'svc'));
    assert.deepEqual(result.finds, [{ rel: 'svc/.env', kind: 'copy' }]);
    assert.deepEqual(result.unlinked.map((entry) => entry.rel).toSorted(), ['svc/cache', 'svc/db.sqlite3']);
});

await test('a folder holding only skip-class content reports nothing', (t) => {
    const main = tempRoot(t);
    write(main, 'src/oldpkg/__pycache__/x.pyc');
    const result = expanded(walk(main, 'src/oldpkg'));
    assert.deepEqual(result.finds, []);
    assert.deepEqual(result.unlinked, []);
});

await test('a symlink inside the walked folder is a leaf and is not followed', (t) => {
    const main = tempRoot(t);
    write(main, 'elsewhere/.env');
    write(main, 'pkg/.env');
    fs.symlinkSync(path.join(main, 'elsewhere'), path.join(main, 'pkg/linked'));
    const result = expanded(walk(main, 'pkg'));
    assert.deepEqual(result.finds, [{ rel: 'pkg/.env', kind: 'copy' }]);
    assert.deepEqual(
        result.unlinked.map((entry) => entry.rel),
        ['pkg/linked']
    );
});

await test('skip-class content does not add to the size of a reported folder', (t) => {
    const main = tempRoot(t);
    write(main, 'proj/coverage.xml', 100_000);
    write(main, 'proj/notes.txt', 7);
    const result = expanded(walk(main, 'proj'));
    assert.deepEqual(result.finds, []);
    assert.deepEqual(result.unlinked, [{ rel: 'proj', bytes: 7, partial: false }]);
});

await test('a symlink classified as walk is a leaf and is not followed', (t) => {
    const main = tempRoot(t);
    write(main, 'elsewhere/.env');
    write(main, 'pkg/own.txt');
    fs.symlinkSync(path.join(main, 'elsewhere'), path.join(main, 'pkg/linked'));
    const classify = classifier(main);
    const seen: string[] = [];
    const result = expanded(
        walkCollapsed(
            main,
            'pkg',
            (rel) => {
                seen.push(rel);
                return rel === 'pkg/linked' ? 'walk' : classify(rel);
            },
            NOTHING_HANDLED
        )
    );
    assert.deepEqual(seen, ['pkg/linked', 'pkg/own.txt']);
    assert.deepEqual(result.finds, []);
    assert.equal(result.unreadable.length, 0);
    assert.deepEqual(
        result.unlinked.map((entry) => entry.rel),
        ['pkg']
    );
});

await test('a nested node_modules is a dependency find and is not descended', (t) => {
    const main = tempRoot(t);
    write(main, 'web/node_modules/lib/.env');
    write(main, 'web/node_modules/lib/index.js');
    const result = expanded(walk(main, 'web'));
    assert.deepEqual(result.finds, [{ rel: 'web/node_modules', kind: 'dep' }]);
    assert.deepEqual(result.unlinked, []);
});

await test('a handled child is neither visited nor reported and its siblings are reported one by one', (t) => {
    const main = tempRoot(t);
    write(main, 'data/keep.db', 3);
    write(main, 'data/other.bin', 4);
    const seen: string[] = [];
    const classify = classifier(main);
    const result = expanded(
        walkCollapsed(
            main,
            'data',
            (rel) => {
                seen.push(rel);
                return classify(rel);
            },
            (rel) => rel === 'data/keep.db'
        )
    );
    assert.deepEqual(result.finds, []);
    assert.deepEqual(result.unlinked, [{ rel: 'data/other.bin', bytes: 4, partial: false }]);
    assert.equal(seen.includes('data/keep.db'), false);
    assert.equal(JSON.stringify(result).includes('keep.db'), false);
});

await test('a handled folder is not descended', (t) => {
    const main = tempRoot(t);
    write(main, 'data/forced/.env');
    write(main, 'data/other.bin');
    const result = expanded(walk(main, 'data', (rel) => rel === 'data/forced'));
    assert.deepEqual(result.finds, []);
    assert.deepEqual(
        result.unlinked.map((entry) => entry.rel),
        ['data/other.bin']
    );
});

await test('more than maxEntries visited entries cap the walk', (t) => {
    const main = tempRoot(t);
    const limits = { maxEntries: 5, maxDepth: 6 };
    for (let index = 0; index <= limits.maxEntries; index += 1) {
        write(main, `many/f${String(index)}.bin`, 10);
    }
    const result = walk(main, 'many', NOTHING_HANDLED, limits);
    assert.equal(result.kind, 'capped');
    assert.ok(result.kind === 'capped' && result.bytes > 0);
});

await test('exactly maxEntries visited entries do not cap the walk', (t) => {
    const main = tempRoot(t);
    const limits = { maxEntries: 5, maxDepth: 6 };
    for (let index = 0; index < limits.maxEntries; index += 1) {
        write(main, `many/f${String(index)}.bin`, 10);
    }
    assert.equal(walk(main, 'many', NOTHING_HANDLED, limits).kind, 'expanded');
});

await test('a folder deeper than maxDepth caps the walk', (t) => {
    const main = tempRoot(t);
    write(main, 'deep/a/b/c/file.bin');
    assert.equal(walk(main, 'deep', NOTHING_HANDLED, { maxEntries: 100, maxDepth: 2 }).kind, 'capped');
    assert.equal(walk(main, 'deep', NOTHING_HANDLED, { maxEntries: 100, maxDepth: 3 }).kind, 'expanded');
});

const ROOT_SKIP = process.getuid?.() === 0 ? 'root ignores directory modes' : false;

await test('an unreadable subfolder is listed and its siblings are still found', { skip: ROOT_SKIP }, (t) => {
    const main = tempRoot(t);
    write(main, 'mixed/locked/inner.bin');
    write(main, 'mixed/.env');
    const locked = path.join(main, 'mixed/locked');
    fs.chmodSync(locked, 0o000);
    let walked: WalkResult;
    try {
        walked = walk(main, 'mixed');
    } finally {
        fs.chmodSync(locked, 0o755);
    }
    const result = expanded(walked);
    assert.deepEqual(result.unreadable, ['mixed/locked']);
    assert.deepEqual(result.finds, [{ rel: 'mixed/.env', kind: 'copy' }]);
});

await test('boundedSize sums lstat sizes and marks a stopped count as partial', (t) => {
    const main = tempRoot(t);
    write(main, 'blob/a.bin', 100);
    write(main, 'blob/sub/b.bin', 200);
    const full = boundedSize(path.join(main, 'blob'), 100);
    assert.equal(full.partial, false);
    assert.ok(full.bytes >= 300, String(full.bytes));
    const cut = boundedSize(path.join(main, 'blob'), 2);
    assert.equal(cut.partial, true);
    assert.ok(cut.bytes > 0);
    assert.deepEqual(boundedSize(path.join(main, 'blob/a.bin'), 1), { bytes: 100, partial: false });
});
