import path from 'node:path';

import type { AssignedProject } from './assign.ts';
import { installCommand, runInstall, type AttemptResult } from './attempt.ts';
import { removalCommand, removeNewEntries, removeSafely, shellQuote, untrackedEntries } from './cleanup.ts';
import { classifyFailure, failureLines, keyErrorLines, lastLifecycleStep, type FailureReport } from './failures.ts';
import {
    checkManagerVersion,
    chooseManager,
    executableOf,
    VERSION_TIMEOUT_MS,
    type ManagerChoice,
} from './managers.ts';
import { maskSecrets } from './mask.ts';
import { isOwnLink, JS_DEPS, lstatOrUndefined, UV_VENV } from './paths.ts';
import { addPartialMarks, clearPartialMarks, logFileName, readPartialMarks, writeInstallLog } from './privateArea.ts';
import { showText } from './text.ts';
import type { Deps, Env, ManagerName } from './types.ts';

export interface ProjectContext {
    deps: Deps;
    env: Env;
    main: string;
    worktree: string;
    privateDir: string | undefined;
    nowMs: () => number;
    networkTimeoutMs: number;
    progressMs: number;
}

export type ProjectOutcome =
    { kind: 'installed' } | { kind: 'failed' } | { kind: 'not-installed' } | { kind: 'tool-missing'; manager: string };

interface Run {
    ctx: ProjectContext;
    project: AssignedProject;
    manager: ManagerName;
    // npm, or npm in services/api
    label: string;
    targets: readonly string[];
}

const SHELL_SAFE = /^[\w./-]+$/u;
const NO_PRIVATE_DIR = 'the worktree has no private git folder';

function defaultFolder(project: AssignedProject): string {
    const name = project.ecosystem === 'js' ? JS_DEPS : UV_VENV;
    return project.dir === '' ? name : `${project.dir}/${name}`;
}

export function targetFolders(project: AssignedProject): string[] {
    return [...new Set([...project.depRels, defaultFolder(project)])];
}

function shellWord(text: string): string {
    return SHELL_SAFE.test(text) ? text : shellQuote(text);
}

export function projectCommand(project: AssignedProject, command: string): string {
    return project.dir === '' ? command : `cd ${shellWord(project.dir)} && ${command}`;
}

function projectPath(run: Run): string {
    return path.join(run.ctx.worktree, run.project.dir);
}

function worktreeRel(project: AssignedProject, rel: string): string {
    return project.dir === '' ? rel : `${project.dir}/${rel}`;
}

function isInProject(project: AssignedProject, rel: string): boolean {
    return project.dir === '' || rel === project.dir || rel.startsWith(`${project.dir}/`);
}

function absolutePaths(run: Run, rels: readonly string[]): string[] {
    return rels.map((rel) => path.join(run.ctx.worktree, rel));
}

function missingTargets(run: Run): string[] {
    return run.targets.filter((rel) => lstatOrUndefined(path.join(run.ctx.worktree, rel)) === undefined);
}

function addMarks(run: Run, rels: readonly string[]): void {
    const dir = run.ctx.privateDir;
    if (dir !== undefined && rels.length > 0 && !addPartialMarks(dir, rels)) {
        run.ctx.deps.log.warn(`cannot record the partial install of ${run.label} in ${showText(dir)}`);
    }
}

function clearMarks(run: Run, rels: readonly string[]): void {
    const dir = run.ctx.privateDir;
    if (dir !== undefined && rels.length > 0 && !clearPartialMarks(dir, rels)) {
        run.ctx.deps.log.warn(`cannot update the partial install marker in ${showText(dir)}`);
    }
}

function logGroup(run: Run, report: Omit<FailureReport, 'manager' | 'where' | 'command' | 'missing'>): void {
    const lines = failureLines({
        ...report,
        manager: executableOf(run.manager),
        where: run.project.dir,
        command: projectCommand(run.project, installCommand(run.manager)),
        missing: missingTargets(run),
    });
    for (const line of lines) {
        run.ctx.deps.log.warn(line);
    }
}

function logNoTimeLeft(run: Run): void {
    logGroup(run, {
        failure: 'timeout',
        keyLines: ['no time was left to check the manager version'],
        logPath: undefined,
        logProblem: undefined,
        lifecycleStep: undefined,
        silent: false,
    });
}

function logWrongVersion(run: Run, expected: string, found: string): void {
    logGroup(run, {
        failure: 'wrong-version',
        keyLines: [`expected ${expected}, found ${maskSecrets(found, run.ctx.env)}`],
        logPath: undefined,
        logProblem: undefined,
        lifecycleStep: undefined,
        silent: false,
    });
}

// Marked paths of this project are what an earlier run could not clean up; they go before anything is checked.
function removeMarkedLeftovers(run: Run): boolean {
    const dir = run.ctx.privateDir;
    if (dir === undefined) {
        return true;
    }
    const marked = readPartialMarks(dir).filter((rel) => isInProject(run.project, rel));
    const removed: string[] = [];
    const failed: string[] = [];
    let firstReason: string | undefined;
    for (const rel of marked) {
        const result = removeSafely(run.ctx.worktree, rel);
        if (result.ok) {
            removed.push(rel);
        } else {
            failed.push(rel);
            firstReason ??= result.reason;
        }
    }
    clearMarks(run, removed);
    if (firstReason === undefined) {
        return true;
    }
    const command = removalCommand(absolutePaths(run, failed));
    run.ctx.deps.log.warn(
        `not installed with ${run.label}: cannot remove the partial install of an earlier run: ` +
            `${showText(firstReason)}; remove it with: ${showText(command)}`
    );
    return false;
}

// Anything but the tool's own link in a target position is the user's and blocks the install untouched.
function blockedTargets(run: Run): string[] {
    return run.targets.filter(
        (rel) => lstatOrUndefined(path.join(run.ctx.worktree, rel)) !== undefined && !isOwnLink(run.ctx, rel)
    );
}

function warnBlocked(run: Run, blocked: readonly string[]): void {
    const shown = blocked.map((rel) => showText(rel)).join(', ');
    const tail =
        blocked.length === 1
            ? 'already stands in the worktree and is left as it is'
            : 'already stand in the worktree and are left as they are';
    const pronoun = blocked.length === 1 ? 'it' : 'them';
    run.ctx.deps.log.warn(`not installed with ${run.label}: ${shown} ${tail} (remove ${pronoun} and rerun to install)`);
}

function unlinkOwnLinks(run: Run): boolean {
    for (const rel of run.targets) {
        if (!isOwnLink(run.ctx, rel)) {
            continue;
        }
        const result = removeSafely(run.ctx.worktree, rel);
        if (!result.ok) {
            run.ctx.deps.log.warn(`not installed with ${run.label}: ${showText(result.reason)}`);
            return false;
        }
    }
    return true;
}

function saveLog(run: Run, output: string): { logPath: string | undefined; logProblem: string | undefined } {
    const dir = run.ctx.privateDir;
    if (dir === undefined) {
        return { logPath: undefined, logProblem: NO_PRIVATE_DIR };
    }
    const written = writeInstallLog(dir, logFileName(executableOf(run.manager), run.project.dir), output);
    return written.ok
        ? { logPath: written.path, logProblem: undefined }
        : { logPath: undefined, logProblem: written.reason };
}

function warnUnlisted(run: Run, reason: string): void {
    const dir = projectPath(run);
    const shownReason = showText(maskSecrets(reason, run.ctx.env));
    run.ctx.deps.log.warn(
        `cannot list what the install created in ${showText(dir)} (${shownReason}); ` +
            `check it with: ${showText(`git -C ${shellQuote(dir)} status --ignored`)}`
    );
}

// Only the manager's own new entries go (see removeNewEntries); a new file of the user's stays. The target folders
// were absent before the install (checked and unlinked above), so whatever stands there now is the install's own; they are removed by name too because one inside a folder that was already untracked before
// is hidden in the listing behind that folder. Leftovers replace the target folders in the marker.
async function cleanUp(run: Run, before: ReadonlySet<string>): Promise<void> {
    const removed = await removeNewEntries(run.ctx.deps, projectPath(run), before);
    const listingFailed = !removed.ok && removed.leftovers.length === 0;
    const leftovers = removed.ok ? [] : removed.leftovers.map((rel) => worktreeRel(run.project, rel));
    let reason = removed.ok || listingFailed ? undefined : removed.reason;
    for (const rel of run.targets) {
        if (leftovers.includes(rel)) {
            continue;
        }
        const result = removeSafely(run.ctx.worktree, rel);
        if (!result.ok) {
            leftovers.push(rel);
            reason ??= result.reason;
        }
    }
    if (!removed.ok && listingFailed) {
        warnUnlisted(run, removed.reason);
    }
    if (reason === undefined) {
        clearMarks(run, run.targets);
        return;
    }
    addMarks(run, leftovers);
    clearMarks(
        run,
        run.targets.filter((rel) => !leftovers.includes(rel))
    );
    const command = removalCommand(absolutePaths(run, leftovers));
    run.ctx.deps.log.warn(
        `cannot remove the partial install: ${showText(reason)}; remove it with: ${showText(command)}`
    );
}

async function reportFailure(run: Run, result: AttemptResult, before: ReadonlySet<string>): Promise<void> {
    const { env, deps } = run.ctx;
    const output = maskSecrets(result.output, env);
    const lastOutput = maskSecrets(result.lastOutput, env);
    if (result.lockRestoreProblem !== undefined) {
        deps.log.warn(
            `cannot restore the lock file after ${run.label}: ${showText(maskSecrets(result.lockRestoreProblem, env))}`
        );
    }
    const failure = classifyFailure({
        output: lastOutput,
        code: result.code,
        timedOut: result.timedOut,
        lockChanged: result.lockChanged,
    });
    await cleanUp(run, before);
    logGroup(run, {
        failure,
        keyLines: keyErrorLines(lastOutput),
        ...saveLog(run, output),
        lifecycleStep: lastLifecycleStep(lastOutput),
        silent: result.lastOutput.trim().length === 0,
    });
}

// Steps 3 to 9 of the install order: leftovers, folder state, own links, recorded entries, the install itself.
async function installChecked(run: Run, deadlineMs: number): Promise<ProjectOutcome> {
    const { deps } = run.ctx;
    if (!removeMarkedLeftovers(run)) {
        return { kind: 'not-installed' };
    }
    const blocked = blockedTargets(run);
    if (blocked.length > 0) {
        warnBlocked(run, blocked);
        return { kind: 'not-installed' };
    }
    if (!unlinkOwnLinks(run)) {
        return { kind: 'not-installed' };
    }
    const before = await untrackedEntries(deps, projectPath(run));
    if (before === undefined) {
        deps.log.warn(
            `not installed with ${run.label}: cannot list the untracked entries of ${showText(projectPath(run))}`
        );
        return { kind: 'not-installed' };
    }
    addMarks(run, run.targets);
    const result = await runInstall(deps, {
        manager: run.manager,
        projectDir: projectPath(run),
        label: run.label,
        lockFiles: run.project.lockNames.map((name) => path.join(projectPath(run), name)),
        deadlineMs,
        nowMs: run.ctx.nowMs,
        networkTimeoutMs: run.ctx.networkTimeoutMs,
        progressMs: run.ctx.progressMs,
    });
    if (result.ok) {
        deps.log.info(`installed dependencies with ${run.label} in ${(result.elapsedMs / 1000).toFixed(1)} s`);
        clearMarks(run, run.targets);
        return { kind: 'installed' };
    }
    await reportFailure(run, result, before);
    return { kind: 'failed' };
}

// Installs one project from its own lock files; every problem is logged here except a missing tool, which the
// stage reports together with its fallback. The stage passes the manager it already chose for its report lines.
export async function installProject(
    ctx: ProjectContext,
    project: AssignedProject,
    deadlineMs: number,
    chosen?: ManagerChoice
): Promise<ProjectOutcome> {
    const projectDir = path.join(ctx.worktree, project.dir);
    const choice = chosen ?? chooseManager(projectDir, project.ecosystem, project.lockNames);
    if (choice.kind === 'conflict') {
        const where = project.dir === '' ? 'the worktree root' : showText(project.dir);
        ctx.deps.log.warn(`cannot install dependencies in ${where}: ${showText(choice.reason)}`);
        return { kind: 'not-installed' };
    }
    const { manager } = choice;
    const name = executableOf(manager);
    const run: Run = {
        ctx,
        project,
        manager,
        label: project.dir === '' ? name : `${name} in ${showText(project.dir)}`,
        targets: targetFolders(project),
    };
    const leftMs = deadlineMs - ctx.nowMs();
    if (leftMs <= 0) {
        logNoTimeLeft(run);
        return { kind: 'not-installed' };
    }
    const version = await checkManagerVersion(
        ctx.deps,
        manager,
        choice.expected,
        projectDir,
        Math.min(VERSION_TIMEOUT_MS, leftMs)
    );
    if (version.kind === 'missing') {
        return { kind: 'tool-missing', manager: name };
    }
    if (version.kind === 'mismatch') {
        logWrongVersion(run, version.expected, version.found);
        return { kind: 'not-installed' };
    }
    return installChecked(run, deadlineMs);
}
