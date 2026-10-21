import path from 'node:path';

import { addExcludePatterns, anchoredPattern } from './exclude.ts';
import { makeLink } from './fallback.ts';
import { blockedReason, ensureParents } from './parents.ts';
import { isOwnLink, lstatOrUndefined } from './paths.ts';
import { classifyEntry, entryFacts, type EntryClass } from './rules.ts';
import { showText } from './text.ts';
import type { Deps } from './types.ts';

interface LinkPaths {
    main: string;
    worktree: string;
}

const NOT_LINKED = 'not linked with --link: ';

// The ignored entries git lists for the given paths, each searched literally; undefined when git fails.
async function listIgnoredAt(deps: Deps, main: string, rels: readonly string[]): Promise<Set<string> | undefined> {
    const listed = await deps.runner.run({
        file: 'git',
        args: [
            '-C',
            main,
            'ls-files',
            '-z',
            '--others',
            '--ignored',
            '--exclude-standard',
            '--directory',
            '--',
            ...rels.map((rel) => `:(literal)${rel}`),
        ],
    });
    return listed.code === 0 ? new Set(listed.stdout.split('\0')) : undefined;
}

// check-ignore exits 1 for a folder ignored only through its contents (config/* without a folder rule), so a folder
// that git lists as fully ignored counts too. Git 2.43 lists such a folder as PATH/ followed by its files.
async function isIgnored(deps: Deps, main: string, rel: string): Promise<boolean> {
    const checked = await deps.runner.run({ file: 'git', args: ['-C', main, 'check-ignore', '-q', '--', rel] });
    if (checked.code === 0) {
        return true;
    }
    // Searched, not matched whole: the listing holds PATH/ followed by every file git lists below it.
    const listed = await listIgnoredAt(deps, main, [rel]);
    return listed?.has(`${rel}/`) === true;
}

// The topmost folder above REL that the rules link and git lists as ignored whole: the sync links it whole, so a
// real folder made for REL there would keep that link from being placed.
async function wholeLinkAncestor(deps: Deps, main: string, rel: string): Promise<string | undefined> {
    const parts = rel.split('/');
    const ancestors: string[] = [];
    for (let count = 1; count < parts.length; count += 1) {
        const ancestor = parts.slice(0, count).join('/');
        if (classifyEntry(ancestor, entryFacts(main, ancestor)) === 'link') {
            ancestors.push(ancestor);
        }
    }
    if (ancestors.length === 0) {
        return undefined;
    }
    const listed = await listIgnoredAt(deps, main, ancestors);
    return ancestors.find((ancestor) => listed?.has(`${ancestor}/`) === true || listed?.has(ancestor) === true);
}

// A dependency or copied folder above REL owns everything inside it, so REL refuses like that folder would.
function ownerClass(main: string, rel: string, kind: EntryClass): EntryClass {
    const parts = rel.split('/');
    for (let count = 1; count < parts.length; count += 1) {
        const ancestor = parts.slice(0, count).join('/');
        const ancestorKind = classifyEntry(ancestor, entryFacts(main, ancestor));
        if (ancestorKind === 'dep' || ancestorKind === 'copy') {
            return ancestorKind;
        }
    }
    return kind;
}

// True when REL stands as the tool's own link afterwards; every refusal is warned about here.
async function linkOne(deps: Deps, paths: LinkPaths, rel: string): Promise<boolean> {
    const shown = showText(rel);
    if (lstatOrUndefined(path.join(paths.main, rel)) === undefined) {
        deps.log.warn(`${NOT_LINKED}${shown} does not exist in the main clone`);
        return false;
    }
    if (!(await isIgnored(deps, paths.main, rel))) {
        deps.log.warn(`${NOT_LINKED}${shown} is not ignored in the main clone`);
        return false;
    }
    const kind = classifyEntry(rel, entryFacts(paths.main, rel));
    const owner = ownerClass(paths.main, rel, kind);
    if (owner === 'dep') {
        deps.log.warn(`${NOT_LINKED}${shown} is a dependency folder; the install stage handles it`);
        return false;
    }
    if (owner === 'copy') {
        deps.log.warn(`${NOT_LINKED}${shown} is copied per worktree, never linked`);
        return false;
    }
    const linkedWhole = await wholeLinkAncestor(deps, paths.main, rel);
    if (linkedWhole !== undefined) {
        deps.log.warn(`${NOT_LINKED}${shown}: it is inside ${showText(linkedWhole)}, which is linked whole`);
        return false;
    }
    const parents = ensureParents(paths.worktree, rel);
    if (!parents.ok) {
        deps.log.warn(`${NOT_LINKED}${shown}: ${blockedReason(parents)}`);
        return false;
    }
    const result = makeLink({ deps, ...paths }, rel);
    if (result === 'failed') {
        return false;
    }
    if (result === 'exists' && !isOwnLink(paths, rel)) {
        deps.log.warn(`${NOT_LINKED}something else already stands at ${shown} in the worktree`);
        return false;
    }
    // Only a new link warns, so a repeated call for the same path stays silent.
    if (result === 'created' && kind === 'skip') {
        deps.log.warn(`linked ${shown} with --link: build outputs are now shared with the main clone`);
    }
    return true;
}

function uniqueLinks(links: readonly string[]): string[] {
    return [...new Set(links)];
}

// Links each --link path that passes the checks and records its anchored exclude pattern; the caller logs the
// linked line with logLinked.
export async function linkForced(deps: Deps, paths: LinkPaths, links: readonly string[]): Promise<string[]> {
    const linked: string[] = [];
    for (const rel of uniqueLinks(links)) {
        if (await linkOne(deps, paths, rel)) {
            linked.push(rel);
        }
    }
    await addExcludePatterns(
        deps,
        paths.worktree,
        linked.map((rel) => anchoredPattern(rel))
    );
    return linked;
}

export interface ForcedLinks {
    // Every --link path that stands as an own link afterwards.
    standing: string[];
    // Only the links this run placed: paths that already were own links are not named in the linked line again.
    created: string[];
}

export async function placeForcedLinks(deps: Deps, paths: LinkPaths, links: readonly string[]): Promise<ForcedLinks> {
    const before = new Set(uniqueLinks(links).filter((rel) => isOwnLink(paths, rel)));
    const standing = await linkForced(deps, paths, links);
    return { standing, created: standing.filter((rel) => !before.has(rel)) };
}

// Same text as the linked line of the sync report.
export function logLinked(deps: Deps, rels: readonly string[]): void {
    if (rels.length > 0) {
        deps.log.info(`linked ${rels.map((rel) => showText(rel)).join(', ')}`);
    }
}
