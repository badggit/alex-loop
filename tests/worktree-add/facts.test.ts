import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { gatherFacts } from '../../src/worktree-add/facts.ts';
import type {
    CommandRequest,
    Deps,
    Env,
    RepoLayout,
    TargetFacts,
    WorktreeEntry,
    WorktreeTarget,
} from '../../src/worktree-add/types.ts';
import { listWorktrees, lockState, matchesTarget, parseWorktreeList } from '../../src/worktree-add/worktrees.ts';

import { testDeps } from './support/deps.ts';
import { gitSync, makeRepo, testEnv } from './support/git.ts';
import { withOverride, withoutLockLines } from './support/runners.ts';
import { tempRoot } from './support/tmp.ts';

const UNICODE_NAME = 'my task \u041F\u0440\u0438\u0432\u0435\u0442';

interface Fixture {
    root: string;
    env: Env;
    main: string;
    deps: Deps;
    repo: RepoLayout;
}

function fixture(t: TestContext): Fixture {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    return { root, env, main, deps: testDeps(env), repo: { current: main, main, mainFound: true, linked: false } };
}

function addWorktree(f: Fixture, name: string, ...options: string[]): string {
    const dir = path.join(f.root, name);
    gitSync(f.env, ['-C', f.main, 'worktree', 'add', '--quiet', ...options, dir]);
    return dir;
}

function targetAt(file: string, branch: string): WorktreeTarget {
    const name = path.basename(file);
    return { suffix: name, name, branch, parent: path.dirname(file), parentMissing: false, path: file };
}

function lockless(deps: Deps): Deps {
    return { ...deps, runner: withoutLockLines(deps.runner) };
}

async function factsFor(deps: Deps, repo: RepoLayout, target: WorktreeTarget): Promise<TargetFacts> {
    const result = await gatherFacts(deps, repo, target);
    assert.ok(result.ok, result.ok ? '' : result.reason);
    return result.facts;
}

async function reasonFor(deps: Deps, repo: RepoLayout, target: WorktreeTarget): Promise<string> {
    const result = await gatherFacts(deps, repo, target);
    assert.ok(!result.ok);
    return result.reason;
}

async function registeredLock(deps: Deps, repo: RepoLayout, dir: string): Promise<boolean | undefined> {
    const facts = await factsFor(deps, repo, targetAt(dir, 'unused'));
    return facts.registered?.locked;
}

async function entryAt(deps: Deps, main: string, dir: string): Promise<WorktreeEntry> {
    const entries = await listWorktrees(deps, main);
    const entry = entries?.find((item) => item.path === dir);
    assert.ok(entry !== undefined, `${dir} is not listed`);
    return entry;
}

async function assertMainUnlocked(f: Fixture, deps: Deps): Promise<void> {
    const entries = await listWorktrees(deps, f.main);
    const mainEntry = entries?.find((entry) => entry.path === f.main);
    assert.ok(mainEntry !== undefined);
    assert.equal(lockState(mainEntry, path.join(f.main, '.git'), true), 'unlocked');
    assert.equal(await registeredLock(deps, f.repo, f.main), false);
}

function gitArgsAre(request: CommandRequest, ...words: string[]): boolean {
    const at = request.args.indexOf(words[0] ?? '');
    return request.file === 'git' && at !== -1 && words.every((word, index) => request.args[at + index] === word);
}

const FAILED = { code: 128, stdout: '', stderr: 'fatal: broken\n' };

await test('parses porcelain blocks with branch, bare, detached, locked and prunable lines', () => {
    const text = [
        'worktree /r/main',
        'bare',
        '',
        'worktree /r/a',
        'HEAD 0000000000000000000000000000000000000000',
        'branch refs/heads/feature/a',
        'locked reason here',
        '',
        'worktree /r/b',
        'detached',
        'prunable gitdir file points to non-existent location',
        '',
    ].join('\n');
    assert.deepEqual(parseWorktreeList(text), [
        { path: '/r/main', branch: undefined, bare: true, detached: false, locked: false, prunable: false },
        { path: '/r/a', branch: 'feature/a', bare: false, detached: false, locked: true, prunable: false },
        { path: '/r/b', branch: undefined, bare: false, detached: true, locked: false, prunable: true },
    ]);
});

await test('lists the main clone, a branch, a detached and a unicode worktree; a free name has no facts', async (t) => {
    const f = fixture(t);
    const onA = addWorktree(f, 'wt-a', '-b', 'a');
    const detached = addWorktree(f, 'wt-detached', '--detach');
    const unicode = addWorktree(f, UNICODE_NAME, '-b', 'u');
    const entries = (await listWorktrees(f.deps, f.main)) ?? [];
    const plain = { bare: false, locked: false, prunable: false };
    assert.deepEqual(entries[0], { path: f.main, branch: 'main', detached: false, ...plain });
    // git lists linked worktrees in the readdir order of their admin dirs, which no filesystem promises.
    const linked = entries.slice(1).toSorted((left, right) => left.path.localeCompare(right.path));
    assert.deepEqual(linked, [
        { path: unicode, branch: 'u', detached: false, ...plain },
        { path: onA, branch: 'a', detached: false, ...plain },
        { path: detached, branch: undefined, detached: true, ...plain },
    ]);
    const facts = await factsFor(f.deps, f.repo, targetAt(path.join(f.root, 'free'), 'free'));
    assert.deepEqual(facts, {
        target: path.join(f.root, 'free'),
        branch: 'free',
        targetIsMain: false,
        targetState: 'absent',
        registered: undefined,
        holder: undefined,
        localBranch: false,
        remoteMatches: [],
    });
});

await test('a locked worktree is locked with and without lock lines, an unlocked one stays unlocked', async (t) => {
    const f = fixture(t);
    const locked = addWorktree(f, 'wt-locked', '-b', 'l');
    const unlocked = addWorktree(f, 'wt-unlocked', '-b', 'u');
    gitSync(f.env, ['-C', f.main, 'worktree', 'lock', locked]);
    const commonDir = path.join(f.main, '.git');
    const listed = await listWorktrees(f.deps, f.main);
    const lockedEntry = listed?.find((entry) => entry.path === locked);
    assert.ok(lockedEntry?.locked === true);
    assert.equal(lockState(lockedEntry, commonDir), 'locked');
    const bare = await listWorktrees(lockless(f.deps), f.main);
    const barelyLocked = bare?.find((entry) => entry.path === locked);
    const barelyUnlocked = bare?.find((entry) => entry.path === unlocked);
    assert.ok(barelyLocked !== undefined && barelyUnlocked !== undefined);
    assert.equal(barelyLocked.locked, false);
    assert.equal(lockState(barelyLocked, commonDir), 'locked');
    assert.equal(lockState(barelyUnlocked, commonDir), 'unlocked');
    for (const deps of [f.deps, lockless(f.deps)]) {
        assert.equal(await registeredLock(deps, f.repo, locked), true);
        assert.equal(await registeredLock(deps, f.repo, unlocked), false);
        await assertMainUnlocked(f, deps);
    }
});

for (const form of ['absolute', 'relative']) {
    await test(`a decoy admin dir with a back link decides the lock state (${form} gitdir)`, async (t) => {
        const f = fixture(t);
        const dir = addWorktree(f, 'wt', '-b', 'w');
        const decoy = path.join(f.root, 'decoy');
        fs.mkdirSync(decoy);
        fs.writeFileSync(path.join(decoy, 'gitdir'), `${path.join(dir, '.git')}\n`);
        const pointer = form === 'absolute' ? decoy : path.join('..', 'decoy');
        fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${pointer}\n`);
        const deps = lockless(f.deps);
        assert.equal(await registeredLock(deps, f.repo, dir), false);
        fs.writeFileSync(path.join(decoy, 'locked'), '');
        assert.equal(await registeredLock(deps, f.repo, dir), true);
        await assertMainUnlocked(f, deps);
    });
}

await test('a decoy whose gitdir names another folder is unknown and counts as locked', async (t) => {
    const f = fixture(t);
    const dir = addWorktree(f, 'wt', '-b', 'w');
    const decoy = path.join(f.root, 'decoy');
    fs.mkdirSync(decoy);
    fs.writeFileSync(path.join(decoy, 'gitdir'), `${path.join(f.root, 'other', '.git')}\n`);
    fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${decoy}\n`);
    const deps = lockless(f.deps);
    const entry = await entryAt(deps, f.main, dir);
    assert.equal(lockState(entry, path.join(f.main, '.git')), 'unknown');
    assert.equal(await registeredLock(deps, f.repo, dir), true);
    await assertMainUnlocked(f, deps);
});

await test('only the main tree may point its .git file at the common dir and count as unlocked', async (t) => {
    const f = fixture(t);
    const dir = addWorktree(f, 'wt', '-b', 'w');
    const commonDir = path.join(f.main, '.git');
    fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${commonDir}\n`);
    const deps = lockless(f.deps);
    const entry = await entryAt(deps, f.main, dir);
    assert.equal(lockState(entry, commonDir), 'unknown');
    assert.equal(lockState(entry, commonDir, true), 'unlocked');
    assert.equal(await registeredLock(deps, f.repo, dir), true);
    await assertMainUnlocked(f, deps);
});

await test('a .git file without a gitdir line fails closed until it is restored', async (t) => {
    const f = fixture(t);
    const dir = addWorktree(f, 'wt', '-b', 'w');
    const dotGit = path.join(dir, '.git');
    const original = fs.readFileSync(dotGit, 'utf8');
    fs.writeFileSync(dotGit, 'not a gitdir line\n');
    const deps = lockless(f.deps);
    const entry = await entryAt(deps, f.main, dir);
    assert.equal(lockState(entry, path.join(f.main, '.git')), 'unknown');
    assert.equal(await registeredLock(deps, f.repo, dir), true);
    await assertMainUnlocked(f, deps);
    fs.writeFileSync(dotGit, original);
    assert.equal(await registeredLock(deps, f.repo, dir), false);
    await assertMainUnlocked(f, deps);
});

await test('a removed worktree folder is missing, and a locked one stays locked via the common dir', async (t) => {
    const f = fixture(t);
    const gone = addWorktree(f, 'wt-gone', '-b', 'g');
    const lockedGone = addWorktree(f, 'wt-locked-gone', '-b', 'lg');
    gitSync(f.env, ['-C', f.main, 'worktree', 'lock', lockedGone]);
    fs.rmSync(gone, { recursive: true, force: true });
    fs.rmSync(lockedGone, { recursive: true, force: true });
    for (const deps of [f.deps, lockless(f.deps)]) {
        const plain = await factsFor(deps, f.repo, targetAt(gone, 'g'));
        assert.equal(plain.registered?.missing, true);
        assert.equal(plain.registered.locked, false);
        assert.equal(plain.targetState, 'absent');
        const locked = await factsFor(deps, f.repo, targetAt(lockedGone, 'lg'));
        assert.equal(locked.registered?.missing, true);
        assert.equal(locked.registered.locked, true);
        await assertMainUnlocked(f, deps);
    }
    const entry = await entryAt(lockless(f.deps), f.main, lockedGone);
    assert.equal(lockState(entry, path.join(f.main, '.git')), 'locked');
    assert.equal(lockState(entry, path.join(f.root, 'elsewhere')), 'unknown');
});

await test('every remote carrying the branch is a remote match', async (t) => {
    const f = fixture(t);
    gitSync(f.env, ['-C', f.main, 'remote', 'add', 'upstream', path.join(f.root, 'origin.git')]);
    gitSync(f.env, ['-C', f.main, 'update-ref', 'refs/remotes/origin/x', 'HEAD']);
    gitSync(f.env, ['-C', f.main, 'update-ref', 'refs/remotes/upstream/x', 'HEAD']);
    const facts = await factsFor(f.deps, f.repo, targetAt(path.join(f.root, 'x'), 'x'));
    assert.deepEqual(facts.remoteMatches, ['origin/x', 'upstream/x']);
    assert.equal(facts.localBranch, false);
});

await test('a branch checked out elsewhere has a holder, but never the target own entry', async (t) => {
    const f = fixture(t);
    const onA = addWorktree(f, 'wt-a', '-b', 'a');
    const other = await factsFor(f.deps, f.repo, targetAt(path.join(f.root, 'other'), 'a'));
    assert.equal(other.holder, onA);
    assert.equal(other.registered, undefined);
    assert.equal(other.localBranch, true);
    const own = await factsFor(f.deps, f.repo, targetAt(onA, 'a'));
    assert.equal(own.holder, undefined);
    assert.deepEqual(own.registered, {
        path: onA,
        branch: 'a',
        bare: false,
        detached: false,
        locked: false,
        missing: false,
    });
    assert.equal(own.targetState, 'present');
});

await test('a target spelled through a symlinked parent matches the registered entry', async (t) => {
    const f = fixture(t);
    const onA = addWorktree(f, 'wt-a', '-b', 'a');
    const link = path.join(f.root, 'link');
    fs.symlinkSync(f.root, link);
    const facts = await factsFor(f.deps, f.repo, targetAt(path.join(link, 'wt-a'), 'a'));
    assert.equal(facts.registered?.path, onA);
    assert.equal(facts.holder, undefined);
    assert.ok(matchesTarget(onA, path.join(link, 'wt-a')));
    assert.ok(matchesTarget(path.join(f.root, 'gone'), path.join(link, 'gone')));
    assert.ok(!matchesTarget(onA, path.join(link, 'wt-b')));
});

await test('target states: symlink, dangling symlink, empty folder, unreadable and the main clone', async (t) => {
    const f = fixture(t);
    const link = path.join(f.root, 'link');
    fs.symlinkSync(f.main, link);
    const dangling = path.join(f.root, 'dangling');
    fs.symlinkSync(path.join(f.root, 'nowhere'), dangling);
    const empty = path.join(f.root, 'empty');
    fs.mkdirSync(empty);
    const file = path.join(f.root, 'file');
    fs.writeFileSync(file, 'x\n');
    const stateOf = async (target: string): Promise<TargetFacts['targetState']> => {
        const facts = await factsFor(f.deps, f.repo, targetAt(target, 'b'));
        return facts.targetState;
    };
    assert.equal(await stateOf(link), 'symlink');
    assert.equal(await stateOf(dangling), 'symlink');
    assert.equal(await stateOf(empty), 'present');
    assert.equal(await stateOf(path.join(file, 'below')), 'unreadable');
    const own = await factsFor(f.deps, f.repo, targetAt(f.main, 'main'));
    assert.equal(own.targetIsMain, true);
    assert.equal(own.registered?.path, f.main);
    assert.equal(own.registered.locked, false);
    assert.equal(own.holder, undefined);
    const free = await factsFor(f.deps, f.repo, targetAt(empty, 'b'));
    assert.equal(free.targetIsMain, false);
});

await test('listWorktrees outside a repository returns undefined', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    assert.equal(await listWorktrees(testDeps(env), plain), undefined);
});

await test('git failures return the documented reasons', async (t) => {
    const f = fixture(t);
    const target = targetAt(path.join(f.root, 'x'), 'x');
    const failing = (...words: string[]): Deps => ({
        ...f.deps,
        runner: withOverride(f.deps.runner, (request) => gitArgsAre(request, ...words), FAILED),
    });
    assert.equal(
        await reasonFor(failing('worktree', 'list'), f.repo, target),
        'cannot list the worktrees of the repository'
    );
    assert.equal(await reasonFor(failing('remote'), f.repo, target), 'cannot list the remotes of the repository');
    assert.equal(
        await reasonFor(failing('show-ref'), f.repo, target),
        'cannot check remote branch refs/remotes/origin/x: fatal: broken'
    );
    const localOnly = {
        ...f.deps,
        runner: withOverride(
            f.deps.runner,
            (request) => gitArgsAre(request, 'show-ref') && request.args.includes('refs/heads/x'),
            FAILED
        ),
    };
    assert.equal(await reasonFor(localOnly, f.repo, target), 'cannot check branch refs/heads/x: fatal: broken');
    const onA = addWorktree(f, 'wt-a', '-b', 'a');
    assert.equal(
        await reasonFor(failing('rev-parse', '--git-common-dir'), f.repo, targetAt(onA, 'a')),
        'cannot find the git folder of the repository'
    );
});
