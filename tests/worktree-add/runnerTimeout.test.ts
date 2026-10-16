import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createProcessRunner } from '../../src/worktree-add/proc.ts';

const PRINT_REQ = ['-c', 'printf %s "${WTA_REQ-unset}"'];

await test('a request timeout stops a sleep with code 143 and timedOut', async (t) => {
    const runner = createProcessRunner(process.env);
    t.after(() => runner.terminateAll());
    const started = performance.now();
    const result = await runner.run({ file: 'sleep', args: ['30'], timeoutMs: 300 });
    assert.ok(performance.now() - started < 7000);
    assert.equal(result.code, 143);
    assert.equal(result.timedOut, true);
});

await test('a request that finishes before its timeout is not marked timedOut', async () => {
    const runner = createProcessRunner(process.env);
    const result = await runner.run({ file: '/bin/sh', args: ['-c', 'exit 0'], timeoutMs: 5000 });
    assert.equal(result.code, 0);
    assert.notEqual(result.timedOut, true);
});

await test('a timeout above the timer limit does not fire at once', async () => {
    const runner = createProcessRunner(process.env);
    const result = await runner.run({ file: '/bin/sh', args: ['-c', 'sleep 0.3; exit 0'], timeoutMs: 2 ** 31 });
    assert.equal(result.code, 0);
    assert.notEqual(result.timedOut, true);
});

await test('request env reaches the child, overrides the runner env and stays with that request', async () => {
    const runner = createProcessRunner({ PATH: process.env.PATH, WTA_REQ: 'runner' });
    const own = await runner.run({ file: '/bin/sh', args: PRINT_REQ, env: { WTA_REQ: 'request' } });
    assert.equal(own.code, 0);
    assert.equal(own.stdout, 'request');
    const next = await runner.run({ file: '/bin/sh', args: PRINT_REQ });
    assert.equal(next.stdout, 'runner');
});

await test('request env is absent from a following request when the runner lacks it', async () => {
    const runner = createProcessRunner({ PATH: process.env.PATH });
    const own = await runner.run({ file: '/bin/sh', args: PRINT_REQ, env: { WTA_REQ: 'request' } });
    assert.equal(own.stdout, 'request');
    const next = await runner.run({ file: '/bin/sh', args: PRINT_REQ });
    assert.equal(next.stdout, 'unset');
});

await test('an undefined request env value leaves the runner value in place', async () => {
    const runner = createProcessRunner({ PATH: process.env.PATH, WTA_REQ: 'runner' });
    const result = await runner.run({ file: '/bin/sh', args: PRINT_REQ, env: { WTA_REQ: undefined } });
    assert.equal(result.stdout, 'runner');
});

await test('a missing executable with a timeout resolves with 127 and ENOENT, not timedOut', async () => {
    const runner = createProcessRunner(process.env);
    const result = await runner.run({ file: '/nonexistent/wta-missing-tool', args: [], timeoutMs: 300 });
    assert.equal(result.code, 127);
    assert.equal(result.spawnError, 'ENOENT');
    assert.notEqual(result.timedOut, true);
});
