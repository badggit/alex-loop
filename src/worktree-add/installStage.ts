import path from 'node:path';

import { assignDependencies, type AssignedProject } from './assign.ts';
import { installCommand } from './attempt.ts';
import { revertConfigChanges, snapshotSharedConfig, type ConfigSnapshot } from './configGuard.ts';
import { createDeadline, INSTALL_PHASE_MS, MIN_START_MS } from './deadline.ts';
import { discoverProjects, isWorkspaceMember, type WorkspaceSpecs } from './discover.ts';
import { addExcludePatterns, anchoredPattern } from './exclude.ts';
import { failureLines } from './failures.ts';
import { applyFallback, type FallbackKind, type FallbackResult } from './fallback.ts';
import {
    clearProjectLeftovers,
    CONFLICT_MANAGER,
    installProject,
    projectCommand,
    projectLabel,
    projectPlace,
    ranManager,
    targetFolders,
    type ProjectContext,
    type ProjectOutcome,
} from './installProject.ts';
import { removeMarkedLeftovers } from './leftovers.ts';
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
const NOT_STARTED = 'the install phase ended before it started';
type GroupText = (_shown: string) => string;
const NO_INSTALL_GROUPS: readonly (readonly [FallbackKind, GroupText])[] = [
    ['cloned', (shown) => `cloned ${shown}`],
    ['linked', (shown) => `linked ${shown}`],
    ['present', (shown) => `left as it is ${shown}`],
    ['no-parent', (shown) => `skipped ${shown} (the parent folder does not exist in the worktree)`],
    ['failed', (shown) => `failed ${shown}`],
];
const TOOL_MISSING_GROUPS: readonly (readonly [FallbackKind, GroupText])[] = [
    ['linked', (shown) => `linked ${shown} meanwhile`],
    ['cloned', (shown) => `cloned ${shown} meanwhile`],
    ['present', (shown) => `${shown} already stand in the worktree and are left as they are`],
    ['no-parent', (shown) => `skipped ${shown}: the parent folder does not exist in the worktree`],
    ['failed', (shown) => `${shown} stay missing`],
];
const ORPHAN_KIND_TEXT: Readonly<Record<Exclude<FallbackKind, 'no-parent'>, string>> = {
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

// The scope of one stage run: the worktree's private git folder holds the partial-install marker.
interface StageRun {
    request: InstallStageRequest;
    ctx: ProjectContext;
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

function overlaps(a: string, b: string): boolean {
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

// No install runs, so every marked leftover is from an earlier run and goes before the fallback; a folder whose
// leftover cannot be removed is left out of the fallback, since it would be kept half-installed.
async function skipAll(request: InstallStageRequest, dir: string | undefined): Promise<void> {
    const { deps, worktree } = request;
    const removal = removeMarkedLeftovers({ deps, worktree, privateDir: dir }, () => true);
    const failed = removal.ok ? [] : removal.failed;
    if (!removal.ok) {
        deps.log.warn(removal.problem);
    }
    const rels = request.depRels.filter((rel) => !failed.some((mark) => overlaps(rel, mark)));
    const results = await applyFallback(deps, paths(request), request.transfer, rels);
    const groups = groupTexts(results, NO_INSTALL_GROUPS);
    const summary = groups.length === 0 ? 'no dependency folders in the main clone' : groups.join('; ');
    deps.log.info(`installs skipped (--no-install): ${summary}`);
}

function labelOf(plan: PlannedProject): string {
    return projectLabel(plan.project, commandOf(plan).manager);
}

function reportManual(request: InstallStageRequest, planned: readonly PlannedProject[]): void {
    for (const plan of planned) {
        if (!plan.project.auto) {
            const run = `(run in the worktree: ${showText(commandOf(plan).command)})`;
            request.deps.log.info(`not installed automatically: ${showText(plan.project.dir)} ${run}`);
        }
    }
}

// Without network the projects get the --no-install fallback; a linked folder must go before the install runs.
async function sandboxFallback(stage: StageRun, planned: readonly PlannedProject[]): Promise<void> {
    const { request, ctx } = stage;
    const results: FallbackResult[] = [];
    for (const plan of planned) {
        if (clearProjectLeftovers(ctx, plan.project, labelOf(plan))) {
            results.push(...(await applyFallback(ctx.deps, paths(request), request.transfer, plan.project.depRels)));
        }
    }
    const done = groupTexts(results, NO_INSTALL_GROUPS).map((text) => `; ${text}`);
    const commands = planned.map((plan) => showText(commandOf(plan).command)).join('; ');
    const later = results.some((result) => result.kind === 'linked')
        ? 'to install later, remove the linked folders first (rm PATH, no trailing slash), then run in the worktree'
        : 'run later in the worktree';
    const tail = commands.length === 0 ? '' : `; ${later}: ${commands}`;
    ctx.deps.log.info(`installs skipped: the network is disabled in this sandbox${done.join('')}${tail}`);
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

function kindText(result: FallbackResult): string {
    if (result.kind === 'no-parent') {
        return `skipped: ${showText(path.posix.dirname(result.rel))} does not exist in the worktree`;
    }
    return ORPHAN_KIND_TEXT[result.kind];
}

async function handleOrphans(request: InstallStageRequest, orphans: readonly string[]): Promise<void> {
    const results = await applyFallback(request.deps, paths(request), request.transfer, orphans);
    for (const result of results) {
        request.deps.log.warn(`not installed: ${orphanReason(result.rel)}; ${kindText(result)}`);
    }
}

// uv installs only the project's own .venv, so its other Python environments get the orphan fallback.
async function handleLinkOnly(request: InstallStageRequest, planned: readonly PlannedProject[]): Promise<void> {
    for (const { project } of planned) {
        const results = await applyFallback(request.deps, paths(request), request.transfer, project.linkOnly);
        for (const result of results) {
            request.deps.log.warn(
                `not installed: ${showText(result.rel)} belongs to the uv project in ${projectPlace(project)}, ` +
                    `which installs only its own .venv; ${kindText(result)}`
            );
        }
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

// The leftovers go first here too, so a half-installed folder is reported as missing, not kept.
function reportNotStarted(stage: StageRun, plan: PlannedProject): void {
    const { request, ctx } = stage;
    const { project } = plan;
    clearProjectLeftovers(ctx, project, labelOf(plan));
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

// The shared config is reverted after a project whose manager ran, also when its install throws, so no change made
// by a manager outlives the stage; a throw is a warning naming the project, and a failed revert does not hide it.
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
    if (run.snapshot !== undefined && (outcome === undefined || ranManager(outcome))) {
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

async function installAll(stage: StageRun, planned: readonly PlannedProject[]): Promise<void> {
    if (planned.length === 0) {
        return;
    }
    const { request, ctx } = stage;
    const { timing, nowMs } = request;
    const snapshot = await takeSnapshot(request);
    const deadline = createDeadline(request.startedMs, timing.phaseMs, nowMs);
    for (const [index, plan] of planned.entries()) {
        if (deadline.remainingMs() < MIN_START_MS) {
            reportNotStarted(stage, plan);
            continue;
        }
        await installOne(request, { ctx, snapshot }, plan, nowMs() + deadline.shareMs(planned.length - index));
    }
}

// Target folders an install makes that have no counterpart in the main clone (a root node_modules or .venv the
// main clone lacks) get their pattern here; the main clone's folders already got theirs.
async function excludeNewTargets(request: InstallStageRequest, planned: readonly PlannedProject[]): Promise<void> {
    const known = new Set(request.depRels);
    const fresh = planned.flatMap((plan) => targetFolders(plan.project)).filter((rel) => !known.has(rel));
    await addExcludePatterns(
        request.deps,
        request.worktree,
        fresh.map((rel) => anchoredPattern(rel))
    );
}

function stageContext(request: InstallStageRequest, dir: string | undefined, projectDirs: string[]): ProjectContext {
    return {
        deps: request.deps,
        env: request.env,
        main: request.main,
        worktree: request.worktree,
        privateDir: dir,
        projectDirs,
        nowMs: request.nowMs,
        networkTimeoutMs: request.timing.networkTimeoutMs,
        progressMs: request.timing.progressMs,
    };
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
    const dir = await privateDir(deps, worktree);
    if (request.noInstall) {
        await skipAll(request, dir);
        return;
    }
    const specs: WorkspaceSpecs = new Map();
    const found = await discoverProjects(deps, worktree, specs);
    if (found === undefined) {
        deps.log.warn('cannot list the lock files of the worktree; no dependencies installed');
        return;
    }
    const assignment = assignDependencies(found, depRels, (project, folder) =>
        isWorkspaceMember(worktree, project, folder, specs)
    );
    const planned = assignment.projects.map((project) => ({
        project,
        choice: chooseManager(path.join(worktree, project.dir), project.ecosystem, project.lockNames),
    }));
    const stage: StageRun = {
        request,
        ctx: stageContext(
            request,
            dir,
            found.map((project) => project.dir)
        ),
    };
    reportManual(request, planned);
    const autoProjects = planned.filter((plan) => plan.project.auto);
    // Cloning or linking needs no network, so the orphans and the extra environments get it in the sandbox too.
    await handleOrphans(request, assignment.orphans);
    await handleLinkOnly(request, autoProjects);
    if (request.env[SANDBOX_NETWORK_VARIABLE] === '1') {
        await sandboxFallback(stage, autoProjects);
        return;
    }
    await excludeNewTargets(request, autoProjects);
    await installAll(stage, autoProjects);
}
