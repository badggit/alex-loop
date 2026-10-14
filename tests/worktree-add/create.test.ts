import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { applyStep } from '../../src/worktree-add/create.ts';
import { gatherFacts } from '../../src/worktree-add/facts.ts';
import type {
    ApplyStep,
    CommandRequest,
    Deps,
    Env,
    RepoLayout,
    TargetFacts,
    WorktreeTarget,
} from '../../src/worktree-add/types.ts';
import { listWorktrees } from '../../src/worktree-add/worktrees.ts';

import { testDeps } from './support/deps.ts';
import { commitFile, gitSync, makeRepo, testEnv } from './support/git.ts';
import { withOverride } from './support/runners.ts';
import { tempRoot } from './support/tmp.ts';

interface Fixture {
    root: string;
    env: Env;
    main: string;
    deps: Deps & { lines: string[] };
    repo: RepoLayout;
}

function fixture(t: TestContext): Fixture {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    return { root, env, main, deps: testDeps(env), repo: { current: main, main, mainFound: true, linked: false } };
}

function targetAt(parent: string, name: string, branch: string): WorktreeTarget {
    return {
        suffix: name,
        name,
        branch,
        parent,
        parentMissing: !fs.existsSync(parent),
        path: path.join(parent, name),
    };
}

function headOf(f: Fixture): string {
    return gitSync(f.env, ['-C', f.main, 'rev-parse', 'HEAD']).trim();
}

function createStep(f: Fixture): ApplyStep {
    return { kind: 'create', start: { sha: headOf(f), label: 'main' } };
}

function branchExists(f: Fixture, branch: string): boolean {
    const listed = gitSync(f.env, ['-C', f.main, 'branch', '--list', branch]);
    return listed.trim().length > 0;
}

function configValue(f: Fixture, key: string): string {
    try {
        return gitSync(f.env, ['-C', f.main, 'config', '--get', key]).trim();
    } catch {
        return '';
    }
}

// Pushes a commit on branch x to origin and drops the local x, leaving only origin/x.
function pushRemoteBranch(f: Fixture, branch: string): string {
    gitSync(f.env, ['-C', f.main, 'switch', '--quiet', '-c', branch]);
    const sha = commitFile(f.env, f.main, `${branch}.txt`, `${branch}\n`);
    gitSync(f.env, ['-C', f.main, 'push', '--quiet', 'origin', branch]);
    gitSync(f.env, ['-C', f.main, 'switch', '--quiet', 'main']);
    gitSync(f.env, ['-C', f.main, 'branch', '--quiet', '-D', branch]);
    return sha;
}

async function factsFor(f: Fixture, target: WorktreeTarget): Promise<TargetFacts> {
    const result = await gatherFacts(f.deps, f.repo, target);
    assert.ok(result.ok, result.ok ? '' : result.reason);
    return result.facts;
}

async function registeredBranch(f: Fixture, target: WorktreeTarget): Promise<string | undefined> {
    const facts = await factsFor(f, target);
    return facts.registered?.branch;
}

async function isRegistered(f: Fixture, dir: string): Promise<boolean> {
    const entries = (await listWorktrees(f.deps, f.main)) ?? [];
    return entries.some((entry) => entry.path === dir);
}

async function reasonOf(f: Fixture, target: WorktreeTarget, step: ApplyStep, deps: Deps = f.deps): Promise<string> {
    const result = await applyStep(deps, f.repo, target, step);
    assert.ok(!result.ok, 'applyStep succeeded unexpectedly');
    return result.reason;
}

async function applyOk(f: Fixture, target: WorktreeTarget, step: ApplyStep): Promise<void> {
    const result = await applyStep(f.deps, f.repo, target, step);
    assert.ok(result.ok, result.ok ? '' : result.reason);
}

function logged(f: Fixture, text: string): boolean {
    return f.deps.lines.some((line) => line.includes(text));
}

function gitArgsAre(request: CommandRequest, ...words: string[]): boolean {
    const at = request.args.indexOf(words[0] ?? '');
    return request.file === 'git' && at !== -1 && words.every((word, index) => request.args[at + index] === word);
}

function withFailing(f: Fixture, match: (_request: CommandRequest) => boolean): Deps {
    const failed = { code: 128, stdout: '', stderr: 'fatal: injected failure\n' };
    return { ...f.deps, runner: withOverride(f.deps.runner, match, failed) };
}

await test('create registers the worktree on a new branch at the start sha without an upstream', async (t) => {
    const f = fixture(t);
    const target = targetAt(f.root, 'app-new', 'new');
    const step = createStep(f);
    await applyOk(f, target, step);
    assert.equal(await registeredBranch(f, target), 'new');
    assert.equal(gitSync(f.env, ['-C', f.main, 'rev-parse', 'refs/heads/new']).trim(), headOf(f));
    assert.equal(configValue(f, 'branch.new.remote'), '');
    assert.ok(logged(f, `info created worktree ${target.path} on new branch new from main @ ${headOf(f).slice(0, 7)}`));
});

await test('track creates the branch from the pushed remote branch with its upstream set', async (t) => {
    const f = fixture(t);
    const remoteSha = pushRemoteBranch(f, 'x');
    const target = targetAt(f.root, 'app-x', 'x');
    const facts = await factsFor(f, target);
    assert.deepEqual(facts.remoteMatches, ['origin/x']);
    await applyOk(f, target, { kind: 'track', remote: 'origin' });
    assert.equal(await registeredBranch(f, target), 'x');
    assert.equal(gitSync(f.env, ['-C', f.main, 'rev-parse', 'refs/heads/x']).trim(), remoteSha);
    assert.equal(gitSync(f.env, ['-C', f.main, 'rev-parse', '--abbrev-ref', 'x@{upstream}']).trim(), 'origin/x');
    assert.ok(logged(f, `created worktree ${target.path} on new branch x tracking origin/x`));
});

await test('track sets the remote upstream even when a local branch is named like it', async (t) => {
    const f = fixture(t);
    pushRemoteBranch(f, 'x');
    gitSync(f.env, ['-C', f.main, 'branch', 'origin/x']);
    const target = targetAt(f.root, 'app-x', 'x');
    await applyOk(f, target, { kind: 'track', remote: 'origin' });
    assert.equal(configValue(f, 'branch.x.remote'), 'origin');
    assert.equal(configValue(f, 'branch.x.merge'), 'refs/heads/x');
});

await test('checkout registers the worktree on an existing local branch', async (t) => {
    const f = fixture(t);
    gitSync(f.env, ['-C', f.main, 'branch', 'old']);
    const target = targetAt(f.root, 'app-old', 'old');
    const facts = await factsFor(f, target);
    assert.equal(facts.localBranch, true);
    await applyOk(f, target, { kind: 'checkout' });
    assert.equal(await registeredBranch(f, target), 'old');
    assert.ok(logged(f, `created worktree ${target.path} on existing branch old`));
});

await test('reuse logs reusing and changes nothing', async (t) => {
    const f = fixture(t);
    const dir = path.join(f.root, 'app-kept');
    gitSync(f.env, ['-C', f.main, 'worktree', 'add', '--quiet', '-b', 'kept', dir]);
    const before = gitSync(f.env, ['-C', f.main, 'worktree', 'list', '--porcelain']);
    const refsBefore = gitSync(f.env, ['-C', f.main, 'for-each-ref']);
    const target = targetAt(f.root, 'app-kept', 'kept');
    await applyOk(f, target, { kind: 'reuse' });
    assert.ok(logged(f, `info reusing worktree ${dir} on kept`));
    assert.equal(gitSync(f.env, ['-C', f.main, 'worktree', 'list', '--porcelain']), before);
    assert.equal(gitSync(f.env, ['-C', f.main, 'for-each-ref']), refsBefore);
});

await test('a missing nested parent is created and logged', async (t) => {
    const f = fixture(t);
    const parent = path.join(f.root, 'nested', 'deeper');
    const target = targetAt(parent, 'app-n', 'n');
    assert.equal(target.parentMissing, true);
    await applyOk(f, target, createStep(f));
    assert.ok(fs.statSync(parent).isDirectory());
    assert.ok(logged(f, `info created parent folder ${parent}`));
    assert.equal(await registeredBranch(f, target), 'n');
});

await test('a target holding a file fails the add, deletes the created branch and keeps the file', async (t) => {
    const f = fixture(t);
    const target = targetAt(f.root, 'app-busy', 'busy');
    fs.writeFileSync(target.path, 'mine\n');
    const reason = await reasonOf(f, target, createStep(f));
    assert.match(reason, /^fatal: .*already exists/u);
    assert.ok(!reason.includes('\n'));
    assert.equal(branchExists(f, 'busy'), false);
    assert.equal(fs.readFileSync(target.path, 'utf8'), 'mine\n');
    assert.equal(await isRegistered(f, target.path), false);
});

await test('checkout keeps the pre-existing branch when the add fails', async (t) => {
    const f = fixture(t);
    gitSync(f.env, ['-C', f.main, 'branch', 'old']);
    const target = targetAt(f.root, 'app-old', 'old');
    fs.writeFileSync(target.path, 'mine\n');
    const reason = await reasonOf(f, target, { kind: 'checkout' });
    assert.match(reason, /already exists/u);
    assert.equal(branchExists(f, 'old'), true);
});

await test('a failing post-checkout hook keeps the registered worktree and the branch', async (t) => {
    const f = fixture(t);
    const hook = path.join(f.main, '.git', 'hooks', 'post-checkout');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, '#!/bin/sh\necho hook broke >&2\nexit 1\n', { mode: 0o755 });
    const target = targetAt(f.root, 'app-hooked', 'hooked');
    const reason = await reasonOf(f, target, createStep(f));
    assert.equal(reason, `the worktree exists at ${target.path} on hooked but git reported an error: hook broke`);
    assert.equal(await isRegistered(f, target.path), true);
    assert.equal(branchExists(f, 'hooked'), true);
});

await test('a failed set-upstream rolls back the tracked branch before any folder exists', async (t) => {
    const f = fixture(t);
    pushRemoteBranch(f, 'x');
    const parent = path.join(f.root, 'missing');
    const target = targetAt(parent, 'app-x', 'x');
    const deps = withFailing(f, (request) => request.args.some((arg) => arg.startsWith('--set-upstream-to=')));
    const reason = await reasonOf(f, target, { kind: 'track', remote: 'origin' }, deps);
    assert.match(reason, /fatal: injected failure$/u);
    assert.equal(branchExists(f, 'x'), false);
    assert.equal(configValue(f, 'branch.x.remote'), '');
    assert.equal(configValue(f, 'branch.x.merge'), '');
    assert.equal(await isRegistered(f, target.path), false);
    assert.equal(fs.existsSync(target.path), false);
    assert.equal(fs.existsSync(parent), false);
});

const ROOT_SKIP = process.getuid?.() === 0 ? 'root ignores directory modes' : false;

await test('a parent that cannot be created fails and deletes the created branch', { skip: ROOT_SKIP }, async (t) => {
    const f = fixture(t);
    const locked = path.join(f.root, 'readonly');
    fs.mkdirSync(locked, { mode: 0o555 });
    const parent = path.join(locked, 'sub');
    const target = targetAt(parent, 'app-ro', 'ro');
    let reason: string;
    try {
        reason = await reasonOf(f, target, createStep(f));
    } finally {
        fs.chmodSync(locked, 0o755);
    }
    assert.ok(reason.includes(parent), reason);
    assert.equal(branchExists(f, 'ro'), false);
    assert.equal(await isRegistered(f, target.path), false);
});

await test('a failed add removes the parent folders this run created', async (t) => {
    const f = fixture(t);
    const top = path.join(f.root, 'made');
    const parent = path.join(top, 'deeper');
    const target = targetAt(parent, 'app-gone', 'gone');
    const deps = withFailing(f, (request) => gitArgsAre(request, 'worktree', 'add'));
    const reason = await reasonOf(f, target, createStep(f), deps);
    assert.equal(reason, 'fatal: injected failure');
    assert.ok(f.deps.lines.some((line) => line.includes(`created parent folder ${parent}`)));
    assert.equal(fs.existsSync(top), false);
    assert.ok(fs.statSync(f.root).isDirectory());
    assert.equal(branchExists(f, 'gone'), false);
});

await test('a failed add with a failed worktree re-read keeps the created branch and says so', async (t) => {
    const f = fixture(t);
    const target = targetAt(f.root, 'app-blind', 'blind');
    fs.writeFileSync(target.path, 'mine\n');
    const deps = withFailing(f, (request) => gitArgsAre(request, 'worktree', 'list'));
    const reason = await reasonOf(f, target, createStep(f), deps);
    assert.match(reason, /already exists.*; branch blind was kept/u);
    assert.equal(branchExists(f, 'blind'), true);
});
