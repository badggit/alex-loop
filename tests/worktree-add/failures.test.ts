import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    classifyFailure,
    classText,
    type FailureClass,
    failureLines,
    type FailureReport,
    keyErrorLines,
    lastLifecycleStep,
    nextStep,
} from '../../src/worktree-add/failures.ts';

const NPM_E401 = [
    'npm error code E401',
    'npm error Unable to authenticate, your authentication token seems to be invalid.',
    'npm error A complete log of this run can be found in: /tmp/fake.log',
].join('\n');

const UV_LOCK = [
    'Resolved 12 packages in 3ms',
    'error: The lockfile at `uv.lock` needs to be updated, but `--locked` was provided.',
    'hint: run `uv lock` to update the lock file',
].join('\n');

const NPM_POSTINSTALL = [
    'added 1 package',
    '> other@2.0.0 preinstall',
    '> node pre.js',
    '> demo@1.0.0 postinstall',
    '> node scripts/setup.js',
    'still working',
].join('\n');

const LOG_PATH = '/home/u/app/.git/worktrees/app-rep-123-login/alex-loop-install-npm.log';

function classify(output: string, code = 1, timedOut = false, lockChanged = false): FailureClass {
    return classifyFailure({ output, code, timedOut, lockChanged });
}

function e401Report(): FailureReport {
    return {
        manager: 'npm',
        where: '',
        failure: 'authentication',
        keyLines: keyErrorLines(NPM_E401),
        missing: ['node_modules'],
        command: 'npm ci',
        logPath: LOG_PATH,
        logProblem: undefined,
        lifecycleStep: undefined,
        silent: false,
    };
}

await test('classifyFailure recognizes authentication failures', () => {
    assert.equal(classify(NPM_E401), 'authentication');
    assert.equal(classify('npm error code ENEEDAUTH\nnpm error need auth'), 'authentication');
    assert.equal(classify('npm error code E403\nnpm error 403 Forbidden - you must be logged in'), 'authentication');
    assert.equal(
        classify('error: Failed to fetch\n  Caused by: HTTP status client error (401 Unauthorized)'),
        'authentication'
    );
    assert.equal(
        classify('ERR_PNPM_FETCH_401 GET https://registry.example.test/x: Unauthorized - 401'),
        'authentication'
    );
});

await test('classifyFailure gives access-denied for a 403 without an auth message', () => {
    assert.equal(classify('ERR_PNPM_FETCH_403 GET https://registry.example.test/x: Forbidden - 403'), 'access-denied');
    assert.equal(
        classify('npm error code E403\nnpm error 403 Forbidden - GET https://registry.example.test/x'),
        'access-denied'
    );
});

await test('classifyFailure recognizes network failures', () => {
    const npm = 'npm error code FETCH_ERROR\nnpm error network timeout at: http://127.0.0.1:1/x.tgz';
    assert.equal(classify(npm), 'network');
    assert.equal(classify('getaddrinfo ENOTFOUND registry.example.test'), 'network');
    assert.equal(classify('Error: socket hang up'), 'network');
});

await test('classifyFailure recognizes wrong manager versions', () => {
    assert.equal(
        classify('ERR_PNPM_LOCKFILE_BREAKING_CHANGE Lockfile /x/pnpm-lock.yaml not compatible'),
        'wrong-version'
    );
    assert.equal(classify('This project is configured to use yarn because packageManager is set'), 'wrong-version');
});

await test('classifyFailure lets authentication win over a corepack info line', () => {
    const output = [
        'Corepack is about to download https://registry.npmjs.org/pnpm/-/pnpm-9.0.0.tgz',
        'npm error code E401',
        'npm error Unable to authenticate',
    ].join('\n');
    assert.equal(classify(output), 'authentication');
});

await test('classifyFailure keeps a plain packageManager mismatch as wrong-version', () => {
    const output =
        'error This project\'s package.json defines "packageManager": "yarn@4.1.0". However the current global version of Yarn is 1.22.19.';
    assert.equal(classify(output), 'wrong-version');
});

await test('classifyFailure ignores a 403 inside a tarball version in the URL', () => {
    const output =
        'npm error code ECONNRESET\nnpm error network GET https://registry.example.test/pkg/-/pkg-1.403.0.tgz';
    assert.equal(classify(output), 'network');
    assert.equal(classify('npm error 403 Forbidden - GET https://registry.example.test/pkg'), 'access-denied');
    assert.equal(classify('GET 403 https://registry.example.test/pkg'), 'access-denied');
    assert.equal(classify('error: HTTP 401 from https://registry.example.test/pkg-1.0.0.tgz'), 'authentication');
});

await test('classifyFailure recognizes sandbox failures', () => {
    assert.equal(
        classify('npm error code EACCES\nnpm error syscall mkdir\nnpm error path /home/u/.npm/_cacache'),
        'sandbox'
    );
    assert.equal(classify('EROFS: read-only file system, open /home/u/.cache/uv/x'), 'sandbox');
});

await test('classifyFailure recognizes lock files out of sync', () => {
    assert.equal(
        classify('npm error code EUSAGE\nnpm error `npm ci` can only install packages when in sync'),
        'lock-out-of-sync'
    );
    assert.equal(classify('ERR_PNPM_OUTDATED_LOCKFILE Cannot install with frozen-lockfile'), 'lock-out-of-sync');
    assert.equal(
        classify('error Your lockfile needs to be updated, but yarn was run with `--frozen-lockfile`.'),
        'lock-out-of-sync'
    );
    assert.equal(
        classify('YN0028: The lockfile would have been modified by this install, which is explicitly forbidden.'),
        'lock-out-of-sync'
    );
    assert.equal(classify(UV_LOCK), 'lock-out-of-sync');
});

await test('classifyFailure handles timeouts with and without retries', () => {
    assert.equal(classify('fetching x\nWill retry in 10 seconds', 143, true), 'network');
    assert.equal(classify('resolving packages', 143, true), 'timeout');
    assert.equal(classify('', 143, true), 'timeout');
    assert.equal(classify('  \n', 143, true), 'timeout');
});

await test('classifyFailure gives lock-changed only for a clean exit', () => {
    assert.equal(classify('added 10 packages', 0, false, true), 'lock-changed');
    assert.equal(classify(NPM_E401, 1, false, true), 'authentication');
    assert.equal(classify('', 143, true, true), 'timeout');
});

await test('classifyFailure gives other for unrecognized output and keeps its last 5 lines', () => {
    const output = ['one', 'two', '', 'three', 'four', '  ', 'five', 'six', ''].join('\n');
    assert.equal(classify(output), 'other');
    assert.deepEqual(keyErrorLines(output), ['two', 'three', 'four', 'five', 'six']);
});

await test('keyErrorLines joins the npm code line with its message', () => {
    assert.deepEqual(keyErrorLines(NPM_E401), [
        'npm error code E401: Unable to authenticate, your authentication token seems to be invalid.',
    ]);
});

await test('keyErrorLines keeps the uv error and hint lines', () => {
    assert.deepEqual(keyErrorLines(UV_LOCK), [
        'error: The lockfile at `uv.lock` needs to be updated, but `--locked` was provided.',
        'hint: run `uv lock` to update the lock file',
    ]);
});

await test('lastLifecycleStep finds the last npm and pnpm script', () => {
    assert.equal(lastLifecycleStep(NPM_POSTINSTALL), 'postinstall of demo@1.0.0');
    assert.equal(lastLifecycleStep('added 1 package\ndone'), undefined);
    const pnpm =
        'Progress: resolved 1\nnode_modules/.pnpm/esbuild@0.19.0/node_modules/esbuild postinstall$ node install.js';
    assert.equal(lastLifecycleStep(pnpm), 'postinstall of esbuild');
});

await test('classText gives the fixed phrase for every class', () => {
    assert.equal(classText('authentication'), 'authentication failed');
    assert.equal(classText('access-denied'), 'access denied');
    assert.equal(classText('network'), 'network unreachable');
    assert.equal(classText('lock-out-of-sync'), 'lock file out of sync');
    assert.equal(classText('lock-changed'), 'the install changed the lock file');
    assert.equal(classText('wrong-version'), 'wrong manager version');
    assert.equal(classText('sandbox'), 'blocked by a sandbox');
    assert.equal(classText('tool-missing'), 'tool missing');
    assert.equal(classText('timeout'), 'timed out');
    assert.equal(classText('other'), 'failed');
});

await test('nextStep adds the silent network hint only to a silent timeout', () => {
    const hint = 'often a network that silently drops packets (VPN or proxy)';
    assert.ok(nextStep('timeout', true).includes(hint));
    assert.ok(!nextStep('timeout', false).includes(hint));
    assert.ok(!nextStep('network', true).includes(hint));
    assert.equal(nextStep('authentication', false), 'log in to the registry or refresh the token');
    assert.ok(nextStep('tool-missing', false).length > 0);
});

await test('failureLines prints the design example for npm E401', () => {
    assert.deepEqual(failureLines(e401Report()), [
        'cannot install dependencies with npm: authentication failed (npm error code E401: Unable to authenticate, your authentication token seems to be invalid.)',
        'node_modules is left missing: code that needs it fails until it is installed',
        'to install: log in to the registry or refresh the token, then run in the worktree: npm ci',
        `full npm output: ${LOG_PATH}`,
    ]);
});

await test('failureLines names the project folder and replaces the log line with the log problem', () => {
    const lines = failureLines({ ...e401Report(), where: 'web', logPath: undefined, logProblem: 'disk full' });
    assert.equal(lines[0]?.startsWith('cannot install dependencies with npm in web: '), true);
    assert.equal(lines.at(-1), 'cannot save the npm output: disk full');
    assert.equal(lines.length, 4);
});

await test('failureLines adds the last step for a timeout and the silent hint', () => {
    const lines = failureLines({
        ...e401Report(),
        failure: 'timeout',
        keyLines: [],
        lifecycleStep: 'postinstall of demo@1.0.0',
        silent: true,
    });
    assert.equal(lines[0], 'cannot install dependencies with npm: timed out');
    assert.ok(lines.includes('last step seen: postinstall of demo@1.0.0'));
    assert.ok(lines.some((line) => line.includes('often a network that silently drops packets (VPN or proxy)')));
});

await test('failureLines prints no log line when no install ran', () => {
    const lines = failureLines({
        ...e401Report(),
        failure: 'wrong-version',
        logPath: undefined,
        logProblem: undefined,
    });
    assert.equal(lines.length, 3);
    assert.ok(!lines.some((line) => line.startsWith('full ') || line.startsWith('cannot save')));
});

await test('failureLines replaces control characters in values', () => {
    const lines = failureLines({ ...e401Report(), where: 'a\nb' });
    assert.equal(lines[0]?.startsWith('cannot install dependencies with npm in a?b: '), true);
});
