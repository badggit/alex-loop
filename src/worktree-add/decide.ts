import { showText } from './text.ts';
import type { Decision, RegisteredWorktree, TargetFacts } from './types.ts';

function refuse(reason: string): Decision {
    return { kind: 'refuse', reason };
}

// The REMOTE of a REMOTE/BRANCH match, cut at the known branch because both parts may contain slashes.
export function remoteOf(match: string, branch: string): string | undefined {
    const suffix = `/${branch}`;
    return match.endsWith(suffix) && match.length > suffix.length ? match.slice(0, -suffix.length) : undefined;
}

function decideRegistered(facts: TargetFacts, registered: RegisteredWorktree): Decision {
    const target = showText(facts.target);
    const branch = showText(facts.branch);
    if (registered.bare) {
        return refuse(`${target} is registered as a bare repository, not a worktree`);
    }
    // Prune alone keeps a locked entry, so a missing locked worktree needs the unlock step first.
    if (registered.missing && registered.locked) {
        return refuse(
            `${target} is a locked worktree whose folder is missing; run git worktree unlock ${target}, then git worktree prune`
        );
    }
    if (registered.missing) {
        return refuse(`${target} is a registered worktree whose folder is missing; run git worktree prune first`);
    }
    if (registered.locked) {
        return refuse(`${target} is a locked worktree`);
    }
    if (registered.detached || registered.branch === undefined) {
        return refuse(`${target} is a worktree on a detached HEAD, not on branch ${branch}`);
    }
    if (registered.branch !== facts.branch) {
        return refuse(`${target} is a worktree on branch ${showText(registered.branch)}, not on ${branch}`);
    }
    return { kind: 'reuse' };
}

function decideBranch(facts: TargetFacts): Decision {
    const branch = showText(facts.branch);
    if (facts.localBranch) {
        return { kind: 'checkout' };
    }
    if (facts.remoteMatches.length > 1) {
        const candidates = facts.remoteMatches.map((match) => showText(match)).join(', ');
        return refuse(`branch ${branch} exists on several remotes (${candidates}); create it locally first`);
    }
    const [onlyMatch] = facts.remoteMatches;
    if (onlyMatch === undefined) {
        return { kind: 'create' };
    }
    const remote = remoteOf(onlyMatch, facts.branch);
    return remote === undefined
        ? refuse(`cannot tell the remote of ${showText(onlyMatch)} for branch ${branch}`)
        : { kind: 'track', remote };
}

// The first matching rule wins; an unreadable target fails closed before any reuse is considered.
export function decideWorktree(facts: TargetFacts): Decision {
    const target = showText(facts.target);
    if (facts.targetIsMain) {
        return refuse(`${target} is the main working tree`);
    }
    if (facts.targetState === 'symlink') {
        return refuse(`${target} is a symlink; refusing to follow it`);
    }
    if (facts.targetState === 'unreadable') {
        return refuse(`cannot read ${target}`);
    }
    if (facts.registered !== undefined) {
        return decideRegistered(facts, facts.registered);
    }
    if (facts.targetState === 'present') {
        return refuse(`something already exists at ${target}`);
    }
    if (facts.holder !== undefined) {
        return refuse(`branch ${showText(facts.branch)} is checked out in another worktree: ${showText(facts.holder)}`);
    }
    return decideBranch(facts);
}
