import path from 'node:path';

import { isAtOrAbove } from './assign.ts';
import { removalCommand, removeSafely } from './cleanup.ts';
import { clearPartialMarks, readPartialMarks } from './privateArea.ts';
import { showText } from './text.ts';
import type { Deps } from './types.ts';

export interface LeftoverScope {
    deps: Deps;
    worktree: string;
    privateDir: string | undefined;
}

export type LeftoverResult = { ok: true } | { ok: false; failed: readonly string[]; problem: string };

// The project folder that owns a marked path: the longest one at or above it, so a nested project's leftover is
// never the root's. Undefined when no project folder is at or above it.
export function markOwner(projectDirs: readonly string[], rel: string): string | undefined {
    let best: string | undefined;
    for (const dir of projectDirs) {
        if (isAtOrAbove(dir, rel) && (best === undefined || dir.length > best.length)) {
            best = dir;
        }
    }
    return best;
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
