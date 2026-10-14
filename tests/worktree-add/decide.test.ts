import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decideWorktree, remoteOf } from '../../src/worktree-add/decide.ts';
import type { Decision, RegisteredWorktree, TargetFacts } from '../../src/worktree-add/types.ts';

const TARGET = '/work/repo-task';
const BRANCH = 'task';

function facts(overrides: Partial<TargetFacts> = {}): TargetFacts {
    return {
        target: TARGET,
        branch: BRANCH,
        targetIsMain: false,
        targetState: 'absent',
        registered: undefined,
        holder: undefined,
        localBranch: false,
        remoteMatches: [],
        ...overrides,
    };
}

function registered(overrides: Partial<RegisteredWorktree> = {}): RegisteredWorktree {
    return {
        path: TARGET,
        branch: BRANCH,
        bare: false,
        detached: false,
        locked: false,
        missing: false,
        ...overrides,
    };
}

function refusal(reason: string): Decision {
    return { kind: 'refuse', reason };
}

await test('a registered worktree on the branch is reused', () => {
    assert.deepEqual(decideWorktree(facts({ registered: registered(), targetState: 'present' })), { kind: 'reuse' });
});

await test('an existing local branch is checked out', () => {
    assert.deepEqual(decideWorktree(facts({ localBranch: true })), { kind: 'checkout' });
});

await test('a single remote match is tracked from its remote', () => {
    assert.deepEqual(decideWorktree(facts({ remoteMatches: ['origin/task'] })), { kind: 'track', remote: 'origin' });
});

await test('a remote with slashes in its name is tracked from the full remote part', () => {
    assert.deepEqual(decideWorktree(facts({ remoteMatches: ['my/remote/task'] })), {
        kind: 'track',
        remote: 'my/remote',
    });
});

await test('a new branch is created when nothing matches', () => {
    assert.deepEqual(decideWorktree(facts()), { kind: 'create' });
});

await test('the main working tree is refused', () => {
    assert.deepEqual(
        decideWorktree(facts({ targetIsMain: true, targetState: 'present' })),
        refusal(`${TARGET} is the main working tree`)
    );
});

await test('a symlink target is refused', () => {
    assert.deepEqual(
        decideWorktree(facts({ targetState: 'symlink' })),
        refusal(`${TARGET} is a symlink; refusing to follow it`)
    );
});

await test('an unreadable target is refused', () => {
    assert.deepEqual(decideWorktree(facts({ targetState: 'unreadable' })), refusal(`cannot read ${TARGET}`));
});

await test('a registered bare repository is refused', () => {
    assert.deepEqual(
        decideWorktree(facts({ registered: registered({ bare: true, branch: undefined }), targetState: 'present' })),
        refusal(`${TARGET} is registered as a bare repository, not a worktree`)
    );
});

await test('a missing and locked worktree names unlock first and prune second', () => {
    const decision = decideWorktree(facts({ registered: registered({ missing: true, locked: true }) }));
    assert.deepEqual(
        decision,
        refusal(
            `${TARGET} is a locked worktree whose folder is missing; run git worktree unlock ${TARGET}, then git worktree prune`
        )
    );
    const reason = decision.kind === 'refuse' ? decision.reason : '';
    assert.ok(reason.indexOf('git worktree unlock') < reason.indexOf('git worktree prune'));
});

await test('a missing worktree asks for a prune first', () => {
    assert.deepEqual(
        decideWorktree(facts({ registered: registered({ missing: true }) })),
        refusal(`${TARGET} is a registered worktree whose folder is missing; run git worktree prune first`)
    );
});

await test('a locked worktree is refused', () => {
    assert.deepEqual(
        decideWorktree(facts({ registered: registered({ locked: true }), targetState: 'present' })),
        refusal(`${TARGET} is a locked worktree`)
    );
});

await test('a worktree on a detached HEAD is refused', () => {
    assert.deepEqual(
        decideWorktree(
            facts({ registered: registered({ detached: true, branch: undefined }), targetState: 'present' })
        ),
        refusal(`${TARGET} is a worktree on a detached HEAD, not on branch ${BRANCH}`)
    );
});

await test('a worktree on another branch is refused', () => {
    assert.deepEqual(
        decideWorktree(facts({ registered: registered({ branch: 'other' }), targetState: 'present' })),
        refusal(`${TARGET} is a worktree on branch other, not on ${BRANCH}`)
    );
});

await test('something present at the target is refused', () => {
    assert.deepEqual(
        decideWorktree(facts({ targetState: 'present' })),
        refusal(`something already exists at ${TARGET}`)
    );
});

await test('a branch held by another worktree is refused', () => {
    assert.deepEqual(
        decideWorktree(facts({ holder: '/work/elsewhere' })),
        refusal(`branch ${BRANCH} is checked out in another worktree: /work/elsewhere`)
    );
});

await test('several remote matches are refused with every candidate', () => {
    assert.deepEqual(
        decideWorktree(facts({ remoteMatches: ['origin/task', 'upstream/task'] })),
        refusal(`branch ${BRANCH} exists on several remotes (origin/task, upstream/task); create it locally first`)
    );
});

await test('a remote match not ending in the branch is refused', () => {
    assert.deepEqual(
        decideWorktree(facts({ remoteMatches: ['origin/other'] })),
        refusal(`cannot tell the remote of origin/other for branch ${BRANCH}`)
    );
});

await test('a remote match with an empty remote part is refused', () => {
    assert.deepEqual(
        decideWorktree(facts({ remoteMatches: [`/${BRANCH}`] })),
        refusal(`cannot tell the remote of /${BRANCH} for branch ${BRANCH}`)
    );
});

await test('a symlink wins over a registered worktree', () => {
    assert.deepEqual(
        decideWorktree(facts({ targetState: 'symlink', registered: registered() })),
        refusal(`${TARGET} is a symlink; refusing to follow it`)
    );
});

await test('a registered worktree wins over something present', () => {
    assert.deepEqual(
        decideWorktree(facts({ targetState: 'present', registered: registered({ locked: true }) })),
        refusal(`${TARGET} is a locked worktree`)
    );
});

await test('a holder wins over a local branch', () => {
    assert.deepEqual(
        decideWorktree(facts({ holder: '/work/elsewhere', localBranch: true })),
        refusal(`branch ${BRANCH} is checked out in another worktree: /work/elsewhere`)
    );
});

await test('remoteOf splits only at the branch suffix', () => {
    assert.equal(remoteOf('my/remote/x', 'x'), 'my/remote');
    assert.equal(remoteOf('/x', 'x'), undefined);
    assert.equal(remoteOf('origin/other', 'x'), undefined);
});

await test('control characters in names show as ? in reasons', () => {
    assert.deepEqual(
        decideWorktree(facts({ target: '/work/repo\ttask', targetState: 'present' })),
        refusal('something already exists at /work/repo?task')
    );
    assert.deepEqual(
        decideWorktree(facts({ branch: 'a\tb', holder: '/work/x\ty' })),
        refusal('branch a?b is checked out in another worktree: /work/x?y')
    );
});
