import path from 'node:path';

import { addExcludePatterns, anchoredPattern, TEMP_PATTERN } from './exclude.ts';
import { makeLink } from './fallback.ts';
import { logLinked, placeForcedLinks } from './forcedLinks.ts';
import { checkLegacyExcludes } from './legacy.ts';
import { notLinkedLine } from './notLinked.ts';
import { blockedReason, ensureParents } from './parents.ts';
import { isAtOrAbove, isOwnLink, lstatOrUndefined, missingOrOwnLink } from './paths.ts';
import { classifyEntry, entryFacts, type EntryClass } from './rules.ts';
import { hasControlCharacter, showText } from './text.ts';
import type { Deps, EntryTransfer, Env } from './types.ts';
import { boundedSize, DEFAULT_WALK_LIMITS, type Unlinked, walkCollapsed } from './walk.ts';

export interface SyncOptions {
    links: readonly string[];
    env: Env;
}

type ActionKind = 'copy' | 'dep' | 'link';

interface Action {
    rel: string;
    kind: ActionKind;
    // Found by a walk below a collapsed folder, so its parent folders may be missing in the worktree.
    found: boolean;
}

// A walked folder over the walk limits; placed is set once an entry git lists below it gets an action.
interface CappedFolder {
    rel: string;
    placed: boolean;
}

interface SyncPlan {
    actions: Action[];
    report: Unlinked[];
    // Entries whose subtree is fully handled: anything listed below them is not processed again.
    hiding: Set<string>;
    planned: Set<string>;
    capped: CappedFolder[];
    // The --link paths that stand as own links: everything at or below them is already handled.
    forced: readonly string[];
}

interface PlanPaths {
    main: string;
    worktree: string;
}

interface SyncRun {
    deps: Deps;
    main: string;
    worktree: string;
    transfer: EntryTransfer;
    linked: string[];
    depRels: string[];
}

const REPLACEMENT_CHARACTER = '\uFFFD';
const NO_OPTIONS: SyncOptions = { links: [], env: {} };
const CAP_TEXT = `more than ${String(DEFAULT_WALK_LIMITS.maxEntries)} entries or deeper than ${String(DEFAULT_WALK_LIMITS.maxDepth)} levels`;

// The topmost ignored entries of MAIN, relative and without a trailing slash; undefined when git fails.
async function listIgnored(deps: Deps, main: string): Promise<string[] | undefined> {
    const listed = await deps.runner.run({
        file: 'git',
        args: ['-C', main, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'],
    });
    if (listed.code !== 0) {
        return;
    }
    return listed.stdout
        .split('\0')
        .map((entry) => (entry.endsWith('/') ? entry.slice(0, -1) : entry))
        .filter((entry) => entry.length > 0);
}

// The runner decodes output as UTF-8, so a name with invalid bytes arrives with U+FFFD and cannot be addressed.
function usableEntries(deps: Deps, rels: readonly string[]): string[] {
    const kept: string[] = [];
    for (const rel of rels) {
        if (hasControlCharacter(rel)) {
            deps.log.warn(`skipped an ignored path with a control character in its name: ${showText(rel)}`);
        } else if (rel.includes(REPLACEMENT_CHARACTER)) {
            deps.log.warn(`skipped an ignored path whose name is not valid UTF-8: ${showText(rel)}`);
        } else {
            kept.push(rel);
        }
    }
    return kept;
}

// True when REL lies below an entry whose subtree is already handled (linked, skipped, walked or a dependency).
function isHidden(plan: SyncPlan, rel: string): boolean {
    for (let index = rel.indexOf('/'); index !== -1; index = rel.indexOf('/', index + 1)) {
        if (plan.hiding.has(rel.slice(0, index))) {
            return true;
        }
    }
    return false;
}

// An own link above REL, made by an earlier version for a whole folder, already shares everything below it.
function isBelowOwnLink(paths: PlanPaths, rel: string): boolean {
    for (let index = rel.indexOf('/'); index !== -1; index = rel.indexOf('/', index + 1)) {
        if (isOwnLink(paths, rel.slice(0, index))) {
            return true;
        }
    }
    return false;
}

function isForced(plan: SyncPlan, rel: string): boolean {
    return plan.forced.some((forced) => isAtOrAbove(forced, rel));
}

function addAction(plan: SyncPlan, action: Action): void {
    if (!plan.planned.has(action.rel)) {
        plan.planned.add(action.rel);
        plan.actions.push(action);
    }
}

// A capped folder hides nothing, so entries git lists below it still get their actions; its warning comes after
// planning, once it is known whether any of them was placed.
function planWalk(deps: Deps, main: string, plan: SyncPlan, rel: string): void {
    const classify = (childRel: string): EntryClass => classifyEntry(childRel, entryFacts(main, childRel));
    const result = walkCollapsed(main, rel, classify, (childRel) => isForced(plan, childRel));
    if (result.kind === 'capped') {
        plan.capped.push({ rel, placed: false });
        plan.report.push({ rel, bytes: result.bytes, partial: true });
        return;
    }
    plan.hiding.add(rel);
    for (const unreadable of result.unreadable) {
        deps.log.warn(`skipped ${showText(unreadable)}: cannot read it in the main clone`);
    }
    for (const find of result.finds) {
        addAction(plan, { rel: find.rel, kind: find.kind, found: true });
    }
    plan.report.push(...result.unlinked);
}

function planEntry(deps: Deps, paths: PlanPaths, plan: SyncPlan, rel: string): void {
    const { main } = paths;
    const kind = classifyEntry(rel, entryFacts(main, rel));
    switch (kind) {
        case 'copy':
        case 'dep':
        case 'link': {
            addAction(plan, { rel, kind, found: false });
            plan.hiding.add(rel);
            return;
        }
        case 'skip': {
            plan.hiding.add(rel);
            return;
        }
        case 'not-linked': {
            plan.report.push({ rel, ...boundedSize(path.join(main, rel), DEFAULT_WALK_LIMITS.maxEntries) });
            return;
        }
        case 'walk': {
            if (isOwnLink(paths, rel)) {
                plan.hiding.add(rel);
                return;
            }
            planWalk(deps, main, plan, rel);
            return;
        }
    }
}

// An entry below a capped folder gets its actions but no report entries: the capped folder is reported once.
function planBelowCapped(deps: Deps, paths: PlanPaths, plan: SyncPlan, rel: string, capped: CappedFolder): void {
    const before = plan.actions.length;
    planEntry(deps, paths, { ...plan, report: [] }, rel);
    if (plan.actions.length > before) {
        capped.placed = true;
    }
}

function warnCapped(deps: Deps, plan: SyncPlan): void {
    for (const folder of plan.capped) {
        const outcome = folder.placed
            ? 'only entries git lists separately were placed'
            : 'nothing inside it was copied or linked';
        deps.log.warn(`not expanded ${showText(folder.rel)}: ${CAP_TEXT}; ${outcome}`);
    }
}

// Sorted order puts every ancestor before the entries git lists below it, so hiding is decided before they come up.
function planEntries(deps: Deps, paths: PlanPaths, rels: readonly string[], forced: readonly string[]): SyncPlan {
    const plan: SyncPlan = { actions: [], report: [], hiding: new Set(), planned: new Set(), capped: [], forced };
    for (const rel of rels.toSorted()) {
        if (isForced(plan, rel) || isHidden(plan, rel) || isBelowOwnLink(paths, rel)) {
            continue;
        }
        const capped = plan.capped.find((folder) => rel.startsWith(`${folder.rel}/`));
        if (capped === undefined) {
            planEntry(deps, paths, plan, rel);
        } else {
            planBelowCapped(deps, paths, plan, rel, capped);
        }
    }
    warnCapped(deps, plan);
    return plan;
}

// Parent folders are created as real folders inside the worktree; an entry whose parent cannot be is warned about.
function parentsReady(run: SyncRun, rel: string): boolean {
    const parents = ensureParents(run.worktree, rel);
    if (!parents.ok) {
        run.deps.log.warn(`skipped ${showText(rel)}: ${blockedReason(parents)}`);
    }
    return parents.ok;
}

// An own link may stand where a copy belongs: the transfer replaces it with the real file.
function destinationOpen(run: SyncRun, rel: string, kind: ActionKind): boolean {
    return kind === 'copy' ? missingOrOwnLink(run, rel) : lstatOrUndefined(path.join(run.worktree, rel)) === undefined;
}

// Dependency folders are left to the install stage, which installs them or clones or links them from the main clone;
// one found by a walk gets its parent folders first, so the stage finds where it belongs.
async function syncEntry(run: SyncRun, action: Action): Promise<void> {
    const { rel, kind } = action;
    if (kind === 'dep') {
        // A listed one with a missing parent goes on as is: the install stage reports it as no-parent.
        if (!action.found || parentsReady(run, rel)) {
            run.depRels.push(rel);
        }
        return;
    }
    if (!parentsReady(run, rel) || !destinationOpen(run, rel, kind)) {
        return;
    }
    if (kind === 'copy') {
        await run.transfer.copyEntry(rel);
        return;
    }
    if (makeLink(run, rel) === 'created') {
        run.linked.push(rel);
    }
}

// Copies get no pattern: they are ignored by the repository's own rules; links may not be. Dependency folders get
// theirs from the install stage.
function excludedPatterns(run: SyncRun, actions: readonly Action[]): string[] {
    return actions
        .filter((action) => action.kind === 'link' && isOwnLink(run, action.rel))
        .map((action) => anchoredPattern(action.rel));
}

// Paths that already are the tool's own links in the worktree are shared already, so they are not reported.
function reportNotLinked(run: SyncRun, report: readonly Unlinked[]): void {
    const line = notLinkedLine(report.filter((entry) => !isOwnLink(run, entry.rel)));
    if (line !== undefined) {
        run.deps.log.info(line);
    }
}

// Links and dependency folders the current rules or the --link paths would place again are kept; other own links
// are named by the legacy check.
function keptByRules(main: string, forced: readonly string[], rel: string): boolean {
    const kind = classifyEntry(rel, entryFacts(main, rel));
    return kind === 'link' || kind === 'dep' || forced.some((link) => isAtOrAbove(link, rel));
}

// Problems are warnings and never stop the run; nothing that already stands in the worktree is overwritten. Returns
// the dependency folders of the main clone for the install stage, or undefined when the listing fails.
export async function syncIgnored(
    deps: Deps,
    main: string,
    worktree: string,
    transfer: EntryTransfer,
    options: SyncOptions = NO_OPTIONS
): Promise<string[] | undefined> {
    const listed = await listIgnored(deps, main);
    if (listed === undefined) {
        deps.log.warn(
            `cannot list the ignored files of ${showText(main)}; nothing synced into the worktree, the dependency fallback is skipped and nested projects are not installed automatically`
        );
        return undefined;
    }
    const paths = { main, worktree };
    const { standing: forced, created: linked } = await placeForcedLinks(deps, paths, options.links);
    const plan = planEntries(deps, paths, usableEntries(deps, listed), forced);
    const run: SyncRun = { deps, main, worktree, transfer, linked, depRels: [] };
    // Only copies are placed through temp names here; the dependency clones add the pattern themselves.
    if (plan.actions.some((action) => action.kind === 'copy')) {
        await addExcludePatterns(deps, worktree, [TEMP_PATTERN]);
    }
    for (const action of plan.actions) {
        await syncEntry(run, action);
    }
    logLinked(deps, run.linked);
    await addExcludePatterns(deps, worktree, excludedPatterns(run, plan.actions));
    await checkLegacyExcludes(deps, { ...paths, env: options.env, keeps: (rel) => keptByRules(main, forced, rel) });
    reportNotLinked(run, plan.report);
    return run.depRels;
}
