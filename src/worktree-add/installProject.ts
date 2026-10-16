import path from 'node:path';

import type { AssignedProject } from './assign.ts';
import { installCommand, runInstall, type AttemptResult } from './attempt.ts';
import { removalCommand, removeNewEntries, removeSafely, shellQuote, untrackedEntries } from './cleanup.ts';
import { classifyFailure, failureLines, keyErrorLines, lastLifecycleStep, type FailureReport } from './failures.ts';
import { makeLink } from './fallback.ts';
import { markOwner, removeMarkedLeftovers, type ProjectSite } from './leftovers.ts';
import { checkManagerVersion, executableOf, VERSION_TIMEOUT_MS, type ManagerChoice } from './managers.ts';
import { maskSecrets } from './mask.ts';
import { isOwnLink, JS_DEPS, lstatOrUndefined, UV_VENV } from './paths.ts';
import { addPartialMarks, clearPartialMarks, logFileName, writeInstallLog } from './privateArea.ts';
import { showText } from './text.ts';
import type { Deps, Env, ManagerName } from './types.ts';

export interface ProjectContext {
    deps: Deps;
    env: Env;
    main: string;
    worktree: string;
    privateDir: string | undefined;
    // Every discovered project; a marked leftover belongs to the one markOwner picks.
    projects: readonly ProjectSite[];
    nowMs: () => number;
    networkTimeoutMs: number;
    progressMs: number;
}

export type ProjectOutcome =
    { kind: 'installed' } | { kind: 'failed' } | { kind: 'not-installed' } | { kind: 'tool-missing'; manager: string };

// Only these outcomes come after a manager command ran (installed or failed); the others stop before it.
export function ranManager(outcome: ProjectOutcome): boolean {
    return outcome.kind === 'installed' || outcome.kind === 'failed';
}

interface Run {
    ctx: ProjectContext;
    project: AssignedProject;
    manager: ManagerName;
    // npm, or npm in services/api
    label: string;
    targets: readonly string[];
}

export const CONFLICT_MANAGER = 'the package manager';

const SHELL_SAFE = /^[\w./-]+$/u;
const NO_PRIVATE_DIR = 'the worktree has no private git folder';

function worktreeRel(project: AssignedProject, rel: string): string {
    return project.dir === '' ? rel : `${project.dir}/${rel}`;
}

// The inverse of worktreeRel for a path inside the project.
function projectRel(project: AssignedProject, rel: string): string {
    return project.dir === '' ? rel : rel.slice(project.dir.length + 1);
}

function defaultFolder(project: AssignedProject): string {
    return worktreeRel(project, project.ecosystem === 'js' ? JS_DEPS : UV_VENV);
}

export function projectPlace(project: { dir: string }): string {
    return project.dir === '' ? 'the worktree root' : showText(project.dir);
}

// npm, or npm in services/api
export function projectLabel(project: AssignedProject, manager: string): string {
    return project.dir === '' ? manager : `${manager} in ${showText(project.dir)}`;
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

// Marked paths owned by this project are what an earlier run could not clean up. They go before anything else is
// checked or linked, so a half-installed folder is never kept as if it were complete; false (with a warning naming
// LABEL) when one cannot be removed.
export function clearProjectLeftovers(ctx: ProjectContext, project: AssignedProject, label: string): boolean {
    const removal = removeMarkedLeftovers(ctx, (rel) => {
        const owner = markOwner(ctx.projects, rel);
        return owner?.dir === project.dir && owner.ecosystem === project.ecosystem;
    });
    if (removal.ok) {
        return true;
    }
    ctx.deps.log.warn(`not installed with ${label}: ${removal.problem}`);
    return false;
}

// Anything but the tool's own link in a target position is the user's and blocks the install untouched.
function blockedTargets(run: Run): string[] {
    return run.targets.filter(
        (rel) => lstatOrUndefined(path.join(run.ctx.worktree, rel)) !== undefined && !isOwnLink(run.ctx, rel)
    );
}

function shownList(rels: readonly string[]): string {
    return rels.map((rel) => showText(rel)).join(', ');
}

function warnBlocked(run: Run, blocked: readonly string[]): void {
    const shown = shownList(blocked);
    const tail =
        blocked.length === 1
            ? 'already stands in the worktree and is left as it is'
            : 'already stand in the worktree and are left as they are';
    const pronoun = blocked.length === 1 ? 'it' : 'them';
    run.ctx.deps.log.warn(`not installed with ${run.label}: ${shown} ${tail} (remove ${pronoun} and rerun to install)`);
}

// Puts back the links this run removed where nothing stands now, so a run that does not install leaves the folder
// as it found it; no link is made where none stood before. Returns the restored ones.
function relink(run: Run, unlinked: readonly string[]): string[] {
    return unlinked.filter((rel) => makeLink(run.ctx, rel) === 'created');
}

function warnRestored(run: Run, restored: readonly string[]): void {
    if (restored.length === 0) {
        return;
    }
    const command = ['rm', '--', ...absolutePaths(run, restored).map((file) => shellQuote(file))].join(' ');
    run.ctx.deps.log.warn(
        `not installed with ${run.label}: the earlier link was restored for ${shownList(restored)}; ` +
            `remove it with ${showText(command)} before installing`
    );
}

// The tool's own links at the targets go before the install; the ones removed are returned so a run that ends
// without installing can put them back. Undefined (with a warning) when one cannot be removed.
function unlinkOwnLinks(run: Run): string[] | undefined {
    const unlinked: string[] = [];
    for (const rel of run.targets) {
        if (!isOwnLink(run.ctx, rel)) {
            continue;
        }
        const result = removeSafely(run.ctx.worktree, rel);
        if (!result.ok) {
            run.ctx.deps.log.warn(`not installed with ${run.label}: ${showText(result.reason)}`);
            warnRestored(run, relink(run, unlinked));
            return;
        }
        unlinked.push(rel);
    }
    return unlinked;
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

// The links this run removed are put back after the cleanup, so the group's missing folders leave them out.
async function reportFailure(
    run: Run,
    result: AttemptResult,
    state: { before: ReadonlySet<string>; unlinked: readonly string[] }
): Promise<void> {
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
    await cleanUp(run, state.before);
    const restored = relink(run, state.unlinked);
    logGroup(run, {
        failure,
        keyLines: keyErrorLines(lastOutput),
        ...saveLog(run, output),
        lifecycleStep: lastLifecycleStep(lastOutput),
        silent: result.lastOutput.trim().length === 0,
    });
    warnRestored(run, restored);
}

// Steps 4 to 9 of the install order: folder state, own links, recorded entries, the install itself.
async function installChecked(run: Run, deadlineMs: number): Promise<ProjectOutcome> {
    const { deps } = run.ctx;
    const blocked = blockedTargets(run);
    if (blocked.length > 0) {
        warnBlocked(run, blocked);
        return { kind: 'not-installed' };
    }
    // The listing goes first: when it fails nothing has been unlinked yet.
    const listed = await untrackedEntries(deps, projectPath(run));
    if (listed === undefined) {
        deps.log.warn(
            `not installed with ${run.label}: cannot list the untracked entries of ${showText(projectPath(run))}`
        );
        return { kind: 'not-installed' };
    }
    const unlinked = unlinkOwnLinks(run);
    if (unlinked === undefined) {
        return { kind: 'not-installed' };
    }
    // The removed links are gone now, so cleanUp must not take them for entries that stood before the install.
    const before = new Set(listed);
    for (const rel of unlinked) {
        before.delete(projectRel(run.project, rel));
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
    await reportFailure(run, result, { before, unlinked });
    return { kind: 'failed' };
}

// Installs one project from its own lock files with the manager the stage chose for its report lines; every
// problem is logged here except a missing tool, which the stage reports together with its fallback. Leftovers of an
// earlier run go first on every path, also when the install does not run.
export async function installProject(
    ctx: ProjectContext,
    project: AssignedProject,
    deadlineMs: number,
    choice: ManagerChoice
): Promise<ProjectOutcome> {
    const name = choice.kind === 'conflict' ? CONFLICT_MANAGER : executableOf(choice.manager);
    if (!clearProjectLeftovers(ctx, project, projectLabel(project, name))) {
        return { kind: 'not-installed' };
    }
    if (choice.kind === 'conflict') {
        ctx.deps.log.warn(`cannot install dependencies in ${projectPlace(project)}: ${showText(choice.reason)}`);
        return { kind: 'not-installed' };
    }
    const projectDir = path.join(ctx.worktree, project.dir);
    const { manager } = choice;
    const run: Run = { ctx, project, manager, label: projectLabel(project, name), targets: targetFolders(project) };
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
    if (version.kind === 'differs') {
        ctx.deps.log.info(
            `installing with ${run.label} although package.json packageManager names ${version.expected}, ` +
                `found ${version.found} (npm does not enforce packageManager)`
        );
    }
    return installChecked(run, deadlineMs);
}
