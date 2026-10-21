import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatSize, notLinkedLine, REPORT_LIMIT } from '../../src/worktree-add/notLinked.ts';
import type { Unlinked } from '../../src/worktree-add/walk.ts';

const KB = 1024;
const MB = KB * KB;
const GB = MB * KB;
const HINT = 'to share one with the main clone, run worktree-add --link PATH inside the worktree';

function entry(rel: string, bytes: number, partial = false): Unlinked {
    return { rel, bytes, partial };
}

await test('names entries largest first with pinned sizes', () => {
    const line = notLinkedLine([
        entry('backend/db.sqlite3', 40 * MB),
        entry('ml/models', Math.round(1.2 * GB)),
        entry('data', 300 * MB),
    ]);
    assert.equal(line, `not linked: ml/models (1.2 GB), data (300 MB), backend/db.sqlite3 (40 MB); ${HINT}`);
});

await test('names at most REPORT_LIMIT entries and counts the rest', () => {
    const entries = Array.from({ length: 13 }, (_, index) => entry(`e${String(index).padStart(2, '0')}`, KB));
    const line = notLinkedLine(entries);
    assert.equal(REPORT_LIMIT, 10);
    const named = Array.from({ length: 10 }, (_, index) => `e${String(index).padStart(2, '0')} (1 KB)`).join(', ');
    assert.equal(line, `not linked: ${named} and 3 more; ${HINT}`);
});

await test('marks a partial size with a plus after the unit', () => {
    assert.equal(notLinkedLine([entry('big', 5 * MB, true)]), `not linked: big (5 MB+); ${HINT}`);
    assert.equal(formatSize(5 * MB, true), '5 MB+');
});

await test('an empty list gives no line', () => {
    assert.equal(notLinkedLine([]), undefined);
});

await test('formats sizes by unit boundary', () => {
    assert.equal(formatSize(0), '0 B');
    assert.equal(formatSize(1023), '1023 B');
    assert.equal(formatSize(1024), '1 KB');
    assert.equal(formatSize(1536), '2 KB');
    assert.equal(formatSize(MB), '1 MB');
    assert.equal(formatSize(GB), '1.0 GB');
    assert.equal(formatSize(Math.round(1.25 * GB) + 1), '1.3 GB');
});

await test('a size that rounds up to the next unit is shown in that unit', () => {
    assert.equal(formatSize(MB - 1), '1 MB');
    assert.equal(formatSize(MB - KB / 2 - 1), '1023 KB');
    assert.equal(formatSize(MB - KB / 2), '1 MB');
    assert.equal(formatSize(GB - 1), '1.0 GB');
    assert.equal(formatSize(GB - MB / 2 - 1), '1023 MB');
    assert.equal(formatSize(GB - MB / 2), '1.0 GB');
});

await test('shows control characters in paths as question marks', () => {
    assert.equal(notLinkedLine([entry('a\nb', 1)]), `not linked: a?b (1 B); ${HINT}`);
});
