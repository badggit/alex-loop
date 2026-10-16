import path from 'node:path';

import { assignDependencies, type AssignedProject } from './assign.ts';
import { installCommand } from './attempt.ts';
import { revertConfigChanges, snapshotSharedConfig, type ConfigSnapshot } from './configGuard.ts';
import { createDeadline, INSTALL_PHASE_MS, MIN_START_MS } from './deadline.ts';
import { discoverProjects, isWorkspaceMember } from './discover.ts';
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
import { chooseManager, executableOf, type ManagerChoice } from './managers.ts';
import { JS_DEPS, lstatOrUndefined } from './paths.ts';
import { privateDir } from './privateArea.ts';
import { messageOf, showText } from './text.ts';
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
type GroupText = (_shown: string) => string;
const NO_INSTALL_GROUPS: readonly (readonly [FallbackKind, GroupText])[] = [
    ['cloned', (shown) => `cloned ${shown}`],
    ['linked', (shown) => `linked ${shown}`],
    ['present', (shown) => `left as it is ${shown}`],
    ['failed', (shown) => `failed ${shown}`],
];
const TOOL_MISSING_GROUPS: readonly (readonly [FallbackKind, GroupText])[] = [
    ['linked', (shown) => `linked ${shown} meanwhile`],
    ['cloned', (shown) => `cloned ${shown} meanwhile`],
    ['present', (shown) => `${shown} already stand in the worktree and are left as they are`],
    ['failed', (shown) => `${shown} stay missing`],
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

// The manager is chosen once per project, so every report line shows the command the install runs.
interface PlannedProject {
    project: AssignedProject;
    choice: ManagerChoice;
}

function shownList(rels: readonly string[]): string {
    return rels.map((rel) => showText(rel)).join(', ');
}

// One text per fallback kind that has results, in the order of the groups.
function groupTexts(
    results: readonly FallbackResult[],
    groups: readonly (readonly [FallbackKind, GroupText])[]
): string[] {
    return groups
        .map(([kind, text]) => ({ text, rels: results.filter((result) => result.kind === kind) }))
        .filter((group) => group.rels.length > 0)
        .map((group) => group.text(shownList(group.rels.map((result) => result.rel))));
}

function paths(request: InstallStageRequest): { main: string; worktree: string } {
    return { main: request.main, worktree: request.worktree };
}

function commandOf({ project, choice }: PlannedProject): ShownCommand {
    if (choice.kind === 'conflict') {
        return { manager: CONFLICT_MANAGER, command: CONFLICT_COMMAND };
    }
    return {
        manager: executableOf(choice.manager),
        command: projectCommand(project, installCommand(choice.manager)),
    };
}

async function skipAll(request: InstallStageRequest): Promise<void> {
    const results = await applyFallback(request.deps, paths(request), request.transfer, request.depRels);
    const groups = groupTexts(results, NO_INSTALL_GROUPS);
    const summary = groups.length === 0 ? 'no dependency folders in the main clone' : groups.join('; ');
    request.deps.log.info(`installs skipped (--no-install): ${summary}`);
}

function projectPlace(project: AssignedProject): string {
    return project.dir === '' ? 'the worktree root' : showText(project.dir);
}

function reportManual(request: InstallStageRequest, planned: readonly PlannedProject[]): void {
    for (const plan of planned) {
        const { project } = plan;
        const { command } = commandOf(plan);
        const run = `(run in the worktree: ${showText(command)})`;
        if (!project.auto) {
            request.deps.log.info(`not installed automatically: ${showText(project.dir)} ${run}`);
            continue;
        }
        const where = projectPlace(project);
        for (const folder of project.reportOnly) {
            request.deps.log.info(
                `not installed automatically: ${showText(folder)} belongs to the uv project in ${where} ${run}`
            );
        }
    }
}

function reportSandbox(request: InstallStageRequest, planned: readonly PlannedProject[]): void {
    const commands = planned.map((plan) => showText(commandOf(plan).command));
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
    return groupTexts(results, TOOL_MISSING_GROUPS).join('; ');
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

function reportNotStarted(request: InstallStageRequest, plan: PlannedProject): void {
    const { project } = plan;
    const { manager, command } = commandOf(plan);
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

// The shared config is reverted after the project, also when its install throws, so no change made by a manager
// outlives the stage; a throw is a warning naming the project, and a failed revert does not hide it.
async function installOne(
    request: InstallStageRequest,
    run: { ctx: ProjectContext; snapshot: ConfigSnapshot | undefined },
    { project, choice }: PlannedProject,
    untilMs: number
): Promise<void> {
    const { deps, env } = request;
    let outcome: ProjectOutcome | undefined;
    try {
        outcome = await installProject(run.ctx, project, untilMs, choice);
    } catch (error) {
        deps.log.warn(`cannot install dependencies in ${projectPlace(project)}: ${messageOf(error)}`);
    }
    if (run.snapshot !== undefined) {
        try {
            await revertConfigChanges(deps, env, run.snapshot);
        } catch (error) {
            deps.log.warn(
                `cannot revert the shared repository config after installing in ${projectPlace(project)}: ` +
                    messageOf(error)
            );
        }
    }
    if (outcome?.kind === 'tool-missing') {
        await handleToolMissing(request, project, outcome.manager);
    }
}

async function installAll(request: InstallStageRequest, planned: readonly PlannedProject[]): Promise<void> {
    if (planned.length === 0) {
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
    for (const [index, plan] of planned.entries()) {
        if (deadline.remainingMs() < MIN_START_MS) {
            reportNotStarted(request, plan);
            continue;
        }
        await installOne(request, { ctx, snapshot }, plan, nowMs() + deadline.shareMs(planned.length - index));
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
    const assignment = assignDependencies(found, depRels, (project, folder) =>
        isWorkspaceMember(worktree, project, folder)
    );
    const planned = assignment.projects.map((project) => ({
        project,
        choice: chooseManager(path.join(worktree, project.dir), project.ecosystem, project.lockNames),
    }));
    reportManual(request, planned);
    const autoProjects = planned.filter((plan) => plan.project.auto);
    // Cloning or linking an orphan needs no network, so it runs in the sandbox too.
    await handleOrphans(request, assignment.orphans);
    if (request.env[SANDBOX_NETWORK_VARIABLE] === '1') {
        reportSandbox(request, autoProjects);
        return;
    }
    await installAll(request, autoProjects);
}
