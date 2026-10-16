import path from 'node:path';

import { removalCommand, removeSafely } from './cleanup.ts';
import type { Ecosystem, Project } from './discover.ts';
import { isAtOrAbove, JS_DEPS } from './paths.ts';
import { clearPartialMarks, readPartialMarks } from './privateArea.ts';
import { showText } from './text.ts';
import type { Deps } from './types.ts';

export interface LeftoverScope {
    deps: Deps;
    worktree: string;
    privateDir: string | undefined;
}

export type LeftoverResult = { ok: true } | { ok: false; failed: readonly string[]; problem: string };

export type ProjectSite = Pick<Project, 'dir' | 'ecosystem'>;

function deepestAbove(sites: readonly ProjectSite[], rel: string): ProjectSite | undefined {
    let best: ProjectSite | undefined;
    for (const site of sites) {
        if (isAtOrAbove(site.dir, rel) && (best === undefined || site.dir.length > best.dir.length)) {
            best = site;
        }
    }
    return best;
}

// The project that owns a marked path: the deepest one at or above it of the path's own ecosystem (node_modules is
// the JS project's, a Python environment the uv project's), so neither a nested project's leftover nor one of the
// other ecosystem in the same folder is ever its. With no such project the deepest one of any ecosystem takes it, so
// a mark whose project is gone from this branch is still cleared. Undefined when no project is at or above it.
export function markOwner(sites: readonly ProjectSite[], rel: string): ProjectSite | undefined {
    const ecosystem: Ecosystem = path.posix.basename(rel) === JS_DEPS ? 'js' : 'uv';
    return (
        deepestAbove(
            sites.filter((site) => site.ecosystem === ecosystem),
            rel
        ) ?? deepestAbove(sites, rel)
    );
}

// Removes the marked paths of an earlier interrupted or failed install that OWNS accepts and drops them from the
// marker; a path that cannot be removed stays marked and is named in the problem with a removal command.
export function removeMarkedLeftovers(scope: LeftoverScope, owns: (_rel: string) => boolean): LeftoverResult {
    const dir = scope.privateDir;
    if (dir === undefined) {
        return { ok: true };
    }
    const removed: string[] = [];
    const failed: string[] = [];
    let firstReason: string | undefined;
    for (const rel of readPartialMarks(dir).filter((mark) => owns(mark))) {
        const result = removeSafely(scope.worktree, rel);
        if (result.ok) {
            removed.push(rel);
        } else {
            failed.push(rel);
            firstReason ??= result.reason;
        }
    }
    if (removed.length > 0 && !clearPartialMarks(dir, removed)) {
        scope.deps.log.warn(`cannot update the partial install marker in ${showText(dir)}`);
    }
    if (firstReason === undefined) {
        return { ok: true };
    }
    const command = removalCommand(failed.map((rel) => path.join(scope.worktree, rel)));
    return {
        ok: false,
        failed,
        problem:
            `cannot remove the partial install of an earlier run: ${showText(firstReason)}; ` +
            `remove it with: ${showText(command)}`,
    };
}
