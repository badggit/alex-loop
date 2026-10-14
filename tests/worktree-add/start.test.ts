import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { defaultBranch, logExistingBranch, logSameTicket, startPoint, ticketOf } from '../../src/worktree-add/start.ts';
import type { Env, StartPoint } from '../../src/worktree-add/types.ts';

import { testDeps } from './support/deps.ts';
import { commitFile, gitSync, makeRepo, testEnv } from './support/git.ts';
import { tempRoot } from './support/tmp.ts';

const BEHIND_WARNING = 'local main is 1 commits behind origin/main (local refs, no fetch)';
const HEAD_WARNING = "no default branch found; the new branch starts from the main clone's HEAD";

interface Fixture {
    root: string;
    env: Env;
    main: string;
}

function fixture(t: TestContext): Fixture {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    return { root, env, main };
}

// A clone without a remote, with one commit on BRANCH and no other branch.
function bareClone(t: TestContext, branch: string): Fixture {
    const root = tempRoot(t);
    const env = testEnv(root);
    const main = path.join(root, 'app');
    gitSync(env, ['init', '--quiet', `--initial-branch=${branch}`, main]);
    commitFile(env, main, 'README.md', 'app\n');
    return { root, env, main: fs.realpathSync.native(main) };
}

function messageOf(line: string): string {
    return line.slice(line.indexOf(' ') + 1);
}

function headOf(f: Fixture, ref: string): string {
    return gitSync(f.env, ['-C', f.main, 'rev-parse', ref]).trim();
}

async function startOf(f: Fixture): Promise<{ start: StartPoint; lines: string[] }> {
    const deps = testDeps(f.env);
    const result = await startPoint(deps, f.main);
    assert.ok(result.ok, result.ok ? '' : result.reason);
    return { start: result.start, lines: deps.lines };
}

await test('the start point is the main tip while the main clone is on a feature branch ahead of it', async (t) => {
    const f = fixture(t);
    const mainTip = headOf(f, 'main');
    gitSync(f.env, ['-C', f.main, 'switch', '--quiet', '-c', 'feature']);
    commitFile(f.env, f.main, 'a.txt', 'a\n');
    commitFile(f.env, f.main, 'b.txt', 'b\n');
    const { start, lines } = await startOf(f);
    assert.deepEqual(start, { sha: mainTip, label: 'main' });
    assert.notEqual(start.sha, headOf(f, 'HEAD'));
    assert.deepEqual(lines, []);
});

await test('origin/HEAD pointing to trunk with a local trunk wins over main', async (t) => {
    const f = fixture(t);
    gitSync(f.env, ['-C', f.main, 'switch', '--quiet', '-c', 'trunk']);
    commitFile(f.env, f.main, 'trunk.txt', 'trunk\n');
    gitSync(f.env, ['-C', f.main, 'push', '--quiet', 'origin', 'trunk']);
    gitSync(f.env, ['-C', f.main, 'remote', 'set-head', 'origin', 'trunk']);
    gitSync(f.env, ['-C', f.main, 'switch', '--quiet', 'main']);
    const deps = testDeps(f.env);
    assert.equal(await defaultBranch(deps, f.main), 'trunk');
    const { start } = await startOf(f);
    assert.deepEqual(start, { sha: headOf(f, 'trunk'), label: 'trunk' });
});

await test('without origin/HEAD, init.defaultBranch names the default branch when it exists locally', async (t) => {
    const f = bareClone(t, 'feature');
    gitSync(f.env, ['-C', f.main, 'branch', 'main']);
    gitSync(f.env, ['-C', f.main, 'branch', 'dev']);
    commitFile(f.env, f.main, 'feature.txt', 'feature\n');
    gitSync(f.env, ['-C', f.main, 'config', 'init.defaultBranch', 'dev']);
    assert.equal(await defaultBranch(testDeps(f.env), f.main), 'dev');
    const { start } = await startOf(f);
    assert.deepEqual(start, { sha: headOf(f, 'dev'), label: 'dev' });
});

await test('init.defaultBranch without a local branch of that name is skipped', async (t) => {
    const f = bareClone(t, 'main');
    gitSync(f.env, ['-C', f.main, 'config', 'init.defaultBranch', 'dev']);
    assert.equal(await defaultBranch(testDeps(f.env), f.main), 'main');
});

await test('a repository with only master uses master', async (t) => {
    const f = bareClone(t, 'master');
    assert.equal(await defaultBranch(testDeps(f.env), f.main), 'master');
    const { start } = await startOf(f);
    assert.deepEqual(start, { sha: headOf(f, 'master'), label: 'master' });
});

await test('without any default-branch candidate the start point is HEAD with a warning', async (t) => {
    const f = bareClone(t, 'feature');
    assert.equal(await defaultBranch(testDeps(f.env), f.main), undefined);
    const { start, lines } = await startOf(f);
    assert.deepEqual(start, { sha: headOf(f, 'HEAD'), label: 'HEAD (feature)' });
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? '', / warn /u);
    assert.ok(lines[0]?.endsWith(HEAD_WARNING));
});

await test('a detached HEAD without a default branch is labeled HEAD (detached)', async (t) => {
    const f = bareClone(t, 'feature');
    gitSync(f.env, ['-C', f.main, 'switch', '--quiet', '--detach']);
    const { start } = await startOf(f);
    assert.deepEqual(start, { sha: headOf(f, 'HEAD'), label: 'HEAD (detached)' });
});

await test('a local main behind origin/main warns and still starts from the local tip', async (t) => {
    const f = fixture(t);
    const localTip = headOf(f, 'main');
    commitFile(f.env, f.main, 'next.txt', 'next\n');
    gitSync(f.env, ['-C', f.main, 'push', '--quiet', 'origin', 'main']);
    gitSync(f.env, ['-C', f.main, 'reset', '--quiet', '--hard', localTip]);
    const { start, lines } = await startOf(f);
    assert.deepEqual(start, { sha: localTip, label: 'main' });
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? '', / warn /u);
    assert.ok(lines[0]?.includes('1 commits behind'));
    assert.ok(lines[0]?.endsWith(`${BEHIND_WARNING}; the new branch starts from the older commit`));
});

await test('without a configured upstream, origin/D is the comparison ref', async (t) => {
    const f = fixture(t);
    const localTip = headOf(f, 'main');
    commitFile(f.env, f.main, 'next.txt', 'next\n');
    gitSync(f.env, ['-C', f.main, 'push', '--quiet', 'origin', 'main']);
    gitSync(f.env, ['-C', f.main, 'reset', '--quiet', '--hard', localTip]);
    gitSync(f.env, ['-C', f.main, 'branch', '--unset-upstream', 'main']);
    const { lines } = await startOf(f);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]?.includes(BEHIND_WARNING));
});

await test('a configured upstream that no longer exists falls back to origin/D', async (t) => {
    const f = fixture(t);
    const localTip = headOf(f, 'main');
    commitFile(f.env, f.main, 'next.txt', 'next\n');
    gitSync(f.env, ['-C', f.main, 'push', '--quiet', 'origin', 'main']);
    gitSync(f.env, ['-C', f.main, 'reset', '--quiet', '--hard', localTip]);
    gitSync(f.env, ['-C', f.main, 'config', 'branch.main.merge', 'refs/heads/gone']);
    const { lines } = await startOf(f);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]?.includes(BEHIND_WARNING));
});

await test('a fresh repository with no commits has no start point', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const main = path.join(root, 'app');
    gitSync(env, ['init', '--quiet', '--initial-branch=main', main]);
    const result = await startPoint(testDeps(env), main);
    assert.deepEqual(result, { ok: false, reason: 'the main clone has no commits yet' });
});

await test('logExistingBranch reports the last commit date and the ahead and behind counts', async (t) => {
    const f = fixture(t);
    gitSync(f.env, ['-C', f.main, 'switch', '--quiet', '-c', 'task']);
    commitFile(f.env, f.main, 'a.txt', 'a\n');
    commitFile(f.env, f.main, 'b.txt', 'b\n');
    gitSync(f.env, ['-C', f.main, 'switch', '--quiet', 'main']);
    commitFile(f.env, f.main, 'c.txt', 'c\n');
    const deps = testDeps(f.env);
    await logExistingBranch(deps, f.main, 'task');
    assert.equal(deps.lines.length, 1);
    assert.match(
        deps.lines[0] ?? '',
        / info checking out EXISTING local branch task: last commit \d{4}-\d{2}-\d{2}, 2 ahead \/ 1 behind main$/u
    );
});

await test('logExistingBranch omits the counts without a default branch', async (t) => {
    const f = bareClone(t, 'feature');
    gitSync(f.env, ['-C', f.main, 'branch', 'task']);
    const deps = testDeps(f.env);
    await logExistingBranch(deps, f.main, 'task');
    assert.equal(deps.lines.length, 1);
    assert.match(deps.lines[0] ?? '', / info checking out EXISTING local branch task: last commit \d{4}-\d{2}-\d{2}$/u);
});

await test('ticketOf takes the leading key only when it ends at a dash or the end', () => {
    assert.equal(ticketOf('abc-123-oauth-login'), 'abc-123');
    assert.equal(ticketOf('gh-42'), 'gh-42');
    assert.equal(ticketOf('oauth-login'), undefined);
    assert.equal(ticketOf('abc-123x'), undefined);
    assert.equal(ticketOf('Rep-123'), undefined);
    // Accepted false key: harmless, it only feeds the informational listing.
    assert.equal(ticketOf('fix-2-bugs'), 'fix-2');
});

await test('logSameTicket lists other worktrees of the same ticket only', async (t) => {
    const f = fixture(t);
    const add = (name: string, branch: string): string => {
        const dir = path.join(f.root, name);
        gitSync(f.env, ['-C', f.main, 'worktree', 'add', '--quiet', '-b', branch, dir]);
        return dir;
    };
    const other = add('app-abc-123-other', 'abc-123-other');
    add('app-abc-1234-x', 'abc-1234-x');
    const ending = add('app-abc-123', 'abc-123');
    const target = add('app-abc-123-login', 'abc-123-login');
    const deps = testDeps(f.env);
    await logSameTicket(deps, f.main, 'abc-123-login', target);
    assert.equal(deps.lines.length, 1);
    const prefix = 'info other worktrees for ticket abc-123: ';
    const message = messageOf(deps.lines[0] ?? '');
    assert.ok(message.startsWith(prefix), message);
    // The listing keeps git's worktree order, which is not pinned here.
    assert.deepEqual(message.slice(prefix.length).split(', ').toSorted(), [
        `${ending} (abc-123)`,
        `${other} (abc-123-other)`,
    ]);
});

await test('logSameTicket logs nothing without a key or without matches', async (t) => {
    const f = fixture(t);
    const deps = testDeps(f.env);
    await logSameTicket(deps, f.main, 'oauth-login', path.join(f.root, 'app-oauth-login'));
    await logSameTicket(deps, f.main, 'rep-7-x', path.join(f.root, 'app-rep-7-x'));
    await logSameTicket(deps, path.join(f.root, 'missing'), 'rep-7-x', path.join(f.root, 'app-rep-7-x'));
    assert.deepEqual(deps.lines, []);
});
