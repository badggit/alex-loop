import path from 'node:path';

import { assignDependencies, type AssignedProject } from './assign.ts';
import { installCommand } from './attempt.ts';
import { revertConfigChanges, snapshotSharedConfig, type ConfigSnapshot } from './configGuard.ts';
import { createDeadline, INSTALL_PHASE_MS, MIN_START_MS } from './deadline.ts';
import { discoverProjects } from './discover.ts';
import { addExcludePatterns, anchoredPattern } from './exclude.ts';
import { failureLines } from './failures.ts';
import { applyFallback, type FallbackKind, type FallbackResult } from './fallback.ts';
import {
    installProject,
    projectCommand,
    targetFolders,
    type ProjectContext,
    type ProjectOutcome,
} from './installProject.ts';
import { chooseManager, displayName } from './managers.ts';
import { lstatOrUndefined } from './paths.ts';
import { privateDir } from './privateArea.ts';
import { showText } from './text.ts';
import type { Deps, EntryTransfer, Env } from './types.ts';

export interface InstallTiming {
    phaseMs: number;
    progressMs: number;
    networkTimeoutMs: number;
}

export interface InstallStageRequest {
    deps: Deps;
    env: Env;
    main: string;
    worktree: string;
    // Dependency folders found in the main clone, relative with forward slashes.
    depRels: readonly string[];
    noInstall: boolean;
    transfer: EntryTransfer;
    startedMs: number;
    nowMs: () => number;
    timing: InstallTiming;
}

export const DEFAULT_TIMING: InstallTiming = {
    phaseMs: INSTALL_PHASE_MS,
    progressMs: 30_000,
    networkTimeoutMs: 30_000,
};

export const SANDBOX_NETWORK_VARIABLE = 'CODEX_SANDBOX_NETWORK_DISABLED';

const CONFLICT_COMMAND = "install with the project's package manager";
const CONFLICT_MANAGER = 'the package manager';
const NOT_STARTED = 'the install phase ended before it started';
const JS_DEPS = 'node_modules';
const NO_INSTALL_GROUPS: readonly (readonly [FallbackKind, string])[] = [
    ['cloned', 'cloned'],
    ['linked', 'linked'],
    ['present', 'left as it is'],
    ['failed', 'failed'],
];
const ORPHAN_KIND_TEXT: Readonly<Record<FallbackKind, string>> = {
    cloned: 'cloned it',
    linked: 'linked it; do not run installs in this worktree until the link is removed',
    present: 'it already stands in the worktree and is left as it is',
    failed: 'it stays missing',
};

interface ShownCommand {
    manager: string;
    command: string;
}

function shownList(rels: readonly string[]): string {
    return rels.map((rel) => showText(rel)).join(', ');
}

function relsOfKind(results: readonly FallbackResult[], kind: FallbackKind): string[] {
    return results.filter((result) => result.kind === kind).map((result) => result.rel);
}

function paths(request: InstallStageRequest): { main: string; worktree: string } {
    return { main: request.main, worktree: request.worktree };
}

function commandOf(request: InstallStageRequest, project: AssignedProject): ShownCommand {
    const choice = chooseManager(path.join(request.worktree, project.dir), project.ecosystem, project.lockNames);
    if (choice.kind === 'conflict') {
        return { manager: CONFLICT_MANAGER, command: CONFLICT_COMMAND };
    }
    return {
        manager: displayName(choice.manager),
        command: projectCommand(project, installCommand(choice.manager)),
    };
}

async function skipAll(request: InstallStageRequest): Promise<void> {
    const results = await applyFallback(request.deps, paths(request), request.transfer, request.depRels);
    const groups = NO_INSTALL_GROUPS.map(([kind, text]) => ({ text, rels: relsOfKind(results, kind) }))
        .filter((group) => group.rels.length > 0)
        .map((group) => `${group.text} ${shownList(group.rels)}`);
    const summary = groups.length === 0 ? 'no dependency folders in the main clone' : groups.join('; ');
    request.deps.log.info(`installs skipped (--no-install): ${summary}`);
}

function reportManual(request: InstallStageRequest, projects: readonly AssignedProject[]): void {
    for (const project of projects) {
        const { command } = commandOf(request, project);
        const run = `(run in the worktree: ${showText(command)})`;
        if (!project.auto) {
            request.deps.log.info(`not installed automatically: ${showText(project.dir)} ${run}`);
            continue;
        }
        const where = project.dir === '' ? 'the worktree root' : showText(project.dir);
        for (const folder of project.reportOnly) {
            request.deps.log.info(
                `not installed automatically: ${showText(folder)} belongs to the uv project in ${where} ${run}`
            );
        }
    }
}

function reportSandbox(request: InstallStageRequest, projects: readonly AssignedProject[]): void {
    const commands = projects.map((project) => showText(commandOf(request, project).command));
    const tail = commands.length === 0 ? '' : `; run later in the worktree: ${commands.join('; ')}`;
    request.deps.log.info(
        `installs skipped: the network is disabled in this sandbox; dependency folders stay missing${tail}`
    );
}

function orphanReason(rel: string): string {
    if (path.posix.basename(rel) === JS_DEPS) {
        return `${showText(rel)} belongs to no project with a supported lock file`;
    }
    return (
        `${showText(rel)} is a Python environment with no uv.lock next to it, ` +
        'and poetry, pip and pipenv are not installed automatically'
    );
}

async function handleOrphans(request: InstallStageRequest, orphans: readonly string[]): Promise<void> {
    const results = await applyFallback(request.deps, paths(request), request.transfer, orphans);
    for (const result of results) {
        request.deps.log.warn(`not installed: ${orphanReason(result.rel)}; ${ORPHAN_KIND_TEXT[result.kind]}`);
    }
}

function toolMissingTail(project: AssignedProject, results: readonly FallbackResult[]): string {
    if (results.length === 0) {
        return `nothing to link: ${shownList(targetFolders(project))} stays missing`;
    }
    const parts: string[] = [];
    const linked = relsOfKind(results, 'linked');
    const cloned = relsOfKind(results, 'cloned');
    const present = relsOfKind(results, 'present');
    const failed = relsOfKind(results, 'failed');
    if (linked.length > 0) {
        parts.push(`linked ${shownList(linked)} meanwhile`);
    }
    if (cloned.length > 0) {
        parts.push(`cloned ${shownList(cloned)} meanwhile`);
    }
    if (present.length > 0) {
        parts.push(`${shownList(present)} already stand in the worktree and are left as they are`);
    }
    if (failed.length > 0) {
        parts.push(`${shownList(failed)} stay missing`);
    }
    return parts.join('; ');
}

async function handleToolMissing(
    request: InstallStageRequest,
    project: AssignedProject,
    manager: string
): Promise<void> {
    const results = await applyFallback(request.deps, paths(request), request.transfer, project.depRels);
    const shown = showText(manager);
    const where = project.dir === '' ? '' : ` in ${showText(project.dir)}`;
    request.deps.log.warn(`cannot install dependencies with ${shown}${where}: ${shown} is not on PATH`);
    request.deps.log.warn(
        `to install: install ${shown} (or enable corepack), then rerun from the main clone; ` +
            toolMissingTail(project, results)
    );
}

function reportNotStarted(request: InstallStageRequest, project: AssignedProject): void {
    const { manager, command } = commandOf(request, project);
    const missing = targetFolders(project).filter(
        (rel) => lstatOrUndefined(path.join(request.worktree, rel)) === undefined
    );
    const lines = failureLines({
        manager,
        where: project.dir,
        failure: 'timeout',
        keyLines: [NOT_STARTED],
        missing,
        command,
        logPath: undefined,
        logProblem: undefined,
        lifecycleStep: undefined,
        silent: false,
    });
    for (const line of lines) {
        request.deps.log.warn(line);
    }
}

async function takeSnapshot(request: InstallStageRequest): Promise<ConfigSnapshot | undefined> {
    const snapshot = await snapshotSharedConfig(request.deps, request.worktree);
    if (snapshot === undefined) {
        request.deps.log.warn(
            'cannot read the shared repository config; changes made by installs to it are not reverted'
        );
    }
    return snapshot;
}

// The shared config is reverted after every project, also when its install throws, so no change made by a
// manager outlives the stage.
async function installAll(request: InstallStageRequest, projects: readonly AssignedProject[]): Promise<void> {
    if (projects.length === 0) {
        return;
    }
    const { deps, env, timing, nowMs } = request;
    const ctx: ProjectContext = {
        deps,
        env,
        main: request.main,
        worktree: request.worktree,
        privateDir: await privateDir(deps, request.worktree),
        nowMs,
        networkTimeoutMs: timing.networkTimeoutMs,
        progressMs: timing.progressMs,
    };
    const snapshot = await takeSnapshot(request);
    const deadline = createDeadline(request.startedMs, timing.phaseMs, nowMs);
    for (const [index, project] of projects.entries()) {
        if (deadline.remainingMs() < MIN_START_MS) {
            reportNotStarted(request, project);
            continue;
        }
        let outcome: ProjectOutcome;
        try {
            outcome = await installProject(ctx, project, nowMs() + deadline.shareMs(projects.length - index));
        } finally {
            if (snapshot !== undefined) {
                await revertConfigChanges(deps, env, snapshot);
            }
        }
        if (outcome.kind === 'tool-missing') {
            await handleToolMissing(request, project, outcome.manager);
        }
    }
}

// Installs every project of the worktree from its own lock files; dependency folders that cannot be installed are
// cloned or linked from the main clone. The exclude patterns go first so nothing made later shows in git status.
export async function runInstallStage(request: InstallStageRequest): Promise<void> {
    const { deps, worktree, depRels } = request;
    await addExcludePatterns(
        deps,
        worktree,
        depRels.map((rel) => anchoredPattern(rel))
    );
    if (request.noInstall) {
        await skipAll(request);
        return;
    }
    const found = await discoverProjects(deps, worktree);
    if (found === undefined) {
        deps.log.warn('cannot list the lock files of the worktree; no dependencies installed');
        return;
    }
    const assignment = assignDependencies(found, depRels);
    reportManual(request, assignment.projects);
    const autoProjects = assignment.projects.filter((project) => project.auto);
    if (request.env[SANDBOX_NETWORK_VARIABLE] === '1') {
        reportSandbox(request, autoProjects);
        return;
    }
    await handleOrphans(request, assignment.orphans);
    await installAll(request, autoProjects);
}
