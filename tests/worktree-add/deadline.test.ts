import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDeadline, INSTALL_PHASE_MS, MIN_START_MS } from '../../src/worktree-add/deadline.ts';

function clockAt(times: { now: number }): () => number {
    return () => times.now;
}

await test('deadline constants match the install phase budget', () => {
    assert.equal(INSTALL_PHASE_MS, 450_000);
    assert.equal(MIN_START_MS, 5000);
});

await test('deadline counts down from the phase end and splits the rest between projects', () => {
    const times = { now: 400 };
    const deadline = createDeadline(0, 1000, clockAt(times));
    assert.equal(deadline.phaseEndMs, 1000);
    assert.equal(deadline.remainingMs(), 600);
    assert.equal(deadline.shareMs(3), 200);
    assert.equal(deadline.shareMs(0), deadline.shareMs(1));
    assert.equal(deadline.shareMs(1), 600);
});

await test('deadline never goes below zero once the phase is over', () => {
    const times = { now: 1200 };
    const deadline = createDeadline(0, 1000, clockAt(times));
    assert.equal(deadline.remainingMs(), 0);
    assert.equal(deadline.shareMs(3), 0);
    assert.equal(deadline.shareMs(0), deadline.shareMs(1));
});
