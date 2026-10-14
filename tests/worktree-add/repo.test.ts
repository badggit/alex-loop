import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { checkBranchName, locateRepository } from '../../src/worktree-add/repo.ts';
import type { CommandRequest, Env } from '../../src/worktree-add/types.ts';
import { checkGitVersion } from '../../src/worktree-add/versions.ts';

import { testDeps } from './support/deps.ts';
import { commitFile, gitSync, makeRepo, testEnv } from './support/git.ts';
import { withOverride } from './support/runners.ts';
import { tempRoot } from './support/tmp.ts';

function asksFor(flag: string): (_request: CommandRequest) => boolean {
    return (request) => request.args.includes(flag);
}

function overridden(env: Env, flag: string, code: number, stdout = '', stderr = ''): ReturnType<typeof testDeps> {
    const base = testDeps(env);
    return testDeps(env, { runner: withOverride(base.runner, asksFor(flag), { code, stdout, stderr }) });
}

await test('locateRepository gives the same main layout from the root and from a nested subfolder', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    const nested = path.join(main, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    const expected = { ok: true, repo: { current: main, main, mainFound: true, linked: false } };
    assert.deepEqual(await locateRepository(testDeps(env), main), expected);
    assert.deepEqual(await locateRepository(testDeps(env), nested), expected);
});

await test('locateRepository returns physical paths for a cwd reached through a symlink', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    fs.mkdirSync(path.join(main, 'sub'));
    const link = path.join(root, 'link');
    fs.symlinkSync(main, link);
    assert.deepEqual(await locateRepository(testDeps(env), path.join(link, 'sub')), {
        ok: true,
        repo: { current: main, main, mainFound: true, linked: false },
    });
});

await test('locateRepository finds the main clone from a linked worktree', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    const linked = path.join(root, 'app-x');
    gitSync(env, ['-C', main, 'worktree', 'add', '--quiet', '-b', 'x', linked]);
    assert.deepEqual(await locateRepository(testDeps(env), linked), {
        ok: true,
        repo: { current: linked, main, mainFound: true, linked: true },
    });
});

await test('locateRepository counts a separate-git-dir clone as a main clone', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const tree = path.join(root, 'sep');
    gitSync(env, ['init', '--quiet', '--separate-git-dir', path.join(root, 'sep.git'), tree]);
    commitFile(env, tree, 'README.md', 'sep\n');
    assert.deepEqual(await locateRepository(testDeps(env), tree), {
        ok: true,
        repo: { current: tree, main: tree, mainFound: true, linked: false },
    });
});

await test('locateRepository leaves the main clone unconfirmed for a worktree of a bare hub', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { origin } = makeRepo(root, env);
    const hub = path.join(root, 'hub.git');
    gitSync(env, ['clone', '--quiet', '--bare', origin, hub]);
    const linked = path.join(root, 'hub-wt');
    gitSync(env, ['-C', hub, 'worktree', 'add', '--quiet', '-b', 'x', linked]);
    assert.deepEqual(await locateRepository(testDeps(env), linked), {
        ok: true,
        repo: { current: linked, main: linked, mainFound: false, linked: true },
    });
});

await test('locateRepository refuses a folder outside any repository', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    assert.deepEqual(await locateRepository(testDeps(env), outside), {
        ok: false,
        reason: `not a git repository: ${outside}`,
    });
});

await test('locateRepository refuses the .git folder of a clone and a bare repository', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main, origin } = makeRepo(root, env);
    for (const dir of [path.join(main, '.git'), origin]) {
        assert.deepEqual(await locateRepository(testDeps(env), dir), {
            ok: false,
            reason: `not inside a git working tree: ${dir}`,
        });
    }
});

await test('locateRepository refuses a submodule naming the superproject', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { origin } = makeRepo(root, env);
    const { main: superproject } = makeRepo(root, env, 'super');
    gitSync(env, [
        '-C',
        superproject,
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '--quiet',
        origin,
        'sub',
    ]);
    const result = await locateRepository(testDeps(env), path.join(superproject, 'sub'));
    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.match(result.reason, /submodule/u);
        assert.ok(result.reason.includes(superproject), result.reason);
    }
});

await test('locateRepository fails closed when the superproject probe fails', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    const deps = overridden(env, '--show-superproject-working-tree', 3, '', 'fatal: probe failed\nmore');
    assert.deepEqual(await locateRepository(deps, main), {
        ok: false,
        reason: `cannot check whether ${main} is inside a superproject: fatal: probe failed`,
    });
});

await test('locateRepository refuses when the git directories cannot be read', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    const deps = overridden(env, '--absolute-git-dir', 128, '', 'fatal: nope');
    assert.deepEqual(await locateRepository(deps, main), {
        ok: false,
        reason: `cannot read the git directories of ${main}`,
    });
});

await test('checkBranchName follows the real git check-ref-format', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    const deps = testDeps(env);
    for (const branch of ['rep-1', 'a.b', 'a_b']) {
        assert.equal(await checkBranchName(deps, main, branch), 'valid', branch);
    }
    for (const branch of ['a..b', 'x.lock', 'x.', 'a b', 'a~b', 'a^b', 'a:b', 'a@{b']) {
        assert.equal(await checkBranchName(deps, main, branch), 'invalid', branch);
    }
});

await test('checkBranchName maps exit 1 to invalid and any other failure to an error', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    assert.equal(await checkBranchName(overridden(env, 'check-ref-format', 1), main, 'ok'), 'invalid');
    const failed = await checkBranchName(
        overridden(env, 'check-ref-format', 128, '', 'fatal: broken\nsecond'),
        main,
        'ok'
    );
    assert.equal(typeof failed, 'object');
    if (typeof failed === 'object') {
        assert.ok(failed.error.includes('fatal: broken'), failed.error);
        assert.equal(failed.error.includes('second'), false);
    }
});

await test('checkGitVersion refuses an old git and reports a missing one', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const old = overridden(env, '--version', 0, 'git version 2.28.0\n');
    assert.equal(await checkGitVersion(old, root), 'git 2.29 or newer is required, found 2.28.0');
    assert.equal(await checkGitVersion(testDeps(env), root), undefined);
    const base = testDeps(env);
    const missing = testDeps(env, {
        runner: withOverride(base.runner, asksFor('--version'), {
            code: 127,
            stdout: '',
            stderr: '',
            spawnError: 'ENOENT',
        }),
    });
    assert.equal(await checkGitVersion(missing, root), 'git is required but was not found');
});

await test('checkGitVersion reports the first stderr line when git --version fails', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const failing = overridden(env, '--version', 2, '', 'fatal: bad\tsetup\nsecond line\n');
    assert.equal(await checkGitVersion(failing, root), 'cannot run git --version: fatal: bad?setup');
    const silent = overridden(env, '--version', 3);
    assert.equal(await checkGitVersion(silent, root), 'cannot run git --version: git exited with code 3');
});
