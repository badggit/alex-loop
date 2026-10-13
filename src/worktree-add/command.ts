import os from 'node:os';
import path from 'node:path';

import { parseArgs } from './args.ts';
import { createCloneGate } from './cowGate.ts';
import { applyStep } from './create.ts';
import { decideWorktree } from './decide.ts';
import { gatherFacts } from './facts.ts';
import { checkBranchName, locateRepository } from './repo.ts';
import { logExistingBranch, logSameTicket, startPoint } from './start.ts';
import { syncIgnored } from './sync.ts';
import { deriveTarget } from './target.ts';
import { showText } from './text.ts';
import { createTransfer } from './transfer.ts';
import type { ApplyStep, CloneGate, Decision, Deps, Env, Outcome, RepoLayout, WorktreeTarget } from './types.ts';
import { checkGitVersion } from './versions.ts';

export interface CommandIo {
    deps: Deps;
    env: Env;
    cwd: string;
    gate?: CloneGate;
}

type StepResult = { ok: true; step: ApplyStep } | { ok: false; outcome: Outcome };

type TargetResult = { ok: true; target: WorktreeTarget } | { ok: false; outcome: Outcome };

function refused(reason: string): Outcome {
    return { kind: 'refused', reason };
}

function usage(message: string): Outcome {
    return { kind: 'usage', message };
}

// A worktree started from another worktree would only multiply them, so a linked worktree is kept as the answer.
function stayInLinked(deps: Deps, repo: RepoLayout): Outcome {
    const from = repo.mainFound ? `; run it from the main working tree ${showText(repo.main)} to create one` : '';
    deps.log.info(`already in the worktree ${showText(repo.current)}: no new worktree is created${from}`);
    return { kind: 'ok', path: repo.current };
}

async function stepFor(deps: Deps, repo: RepoLayout, target: WorktreeTarget, decision: Decision): Promise<StepResult> {
    if (decision.kind === 'refuse') {
        return { ok: false, outcome: refused(decision.reason) };
    }
    if (decision.kind === 'reuse') {
        return { ok: true, step: decision };
    }
    await logSameTicket(deps, repo.main, target.suffix, target.path);
    switch (decision.kind) {
        case 'checkout': {
            await logExistingBranch(deps, repo.main, target.branch);
            return { ok: true, step: decision };
        }
        case 'track': {
            return { ok: true, step: decision };
        }
        case 'create': {
            const start = await startPoint(deps, repo.main);
            return start.ok
                ? { ok: true, step: { kind: 'create', start: start.start } }
                : { ok: false, outcome: refused(start.reason) };
        }
    }
}

// The worktree already exists here, so a sync that throws is only a warning.
async function syncQuietly(io: CommandIo, repo: RepoLayout, target: WorktreeTarget): Promise<void> {
    const { deps } = io;
    try {
        const transfer = createTransfer(deps, {
            main: repo.main,
            worktree: target.path,
            gate: io.gate ?? createCloneGate(),
        });
        await syncIgnored(deps, repo.main, target.path, transfer);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.log.warn(`cannot sync ignored paths into the worktree: ${showText(message)}`);
    }
}

// Derives the target and checks its branch name; a wrong name is the caller's mistake (usage), a broken git is not.
async function prepareTarget(
    io: CommandIo,
    repo: RepoLayout,
    suffix: string,
    parent: string | undefined
): Promise<TargetResult> {
    const { deps } = io;
    const derived = deriveTarget(suffix, parent, io.cwd, repo.main);
    if (!derived.ok) {
        return { ok: false, outcome: derived.code === 2 ? usage(derived.message) : refused(derived.message) };
    }
    const { target } = derived;
    deps.log.info(`name based on main clone folder ${showText(path.basename(repo.main))}`);
    const name = await checkBranchName(deps, repo.current, target.branch);
    if (name === 'invalid') {
        return { ok: false, outcome: usage(`invalid branch name: ${showText(target.branch)}`) };
    }
    if (name !== 'valid') {
        return { ok: false, outcome: refused(name.error) };
    }
    return { ok: true, target };
}

export async function runWorktreeAdd(io: CommandIo, argv: readonly string[]): Promise<Outcome> {
    const { deps } = io;
    const parsed = parseArgs(argv, io.env.HOME ?? os.homedir());
    if (parsed.kind !== 'ok') {
        return parsed;
    }
    const versionProblem = await checkGitVersion(deps, io.cwd);
    if (versionProblem !== undefined) {
        return refused(versionProblem);
    }
    const located = await locateRepository(deps, io.cwd);
    if (!located.ok) {
        return refused(located.reason);
    }
    const { repo } = located;
    if (repo.linked) {
        return stayInLinked(deps, repo);
    }
    const prepared = await prepareTarget(io, repo, parsed.suffix, parsed.parent);
    if (!prepared.ok) {
        return prepared.outcome;
    }
    const { target } = prepared;
    const facts = await gatherFacts(deps, repo, target);
    if (!facts.ok) {
        return refused(facts.reason);
    }
    const step = await stepFor(deps, repo, target, decideWorktree(facts.facts));
    if (!step.ok) {
        return step.outcome;
    }
    const applied = await applyStep(deps, repo, target, step.step);
    if (!applied.ok) {
        return refused(applied.reason);
    }
    await syncQuietly(io, repo, target);
    return { kind: 'ok', path: target.path };
}
