import fs from 'node:fs';
import path from 'node:path';

import { lstatOrUndefined } from './paths.ts';
import type { EntryClass } from './rules.ts';

export interface WalkLimits {
    maxEntries: number;
    maxDepth: number;
}

export const DEFAULT_WALK_LIMITS: WalkLimits = { maxEntries: 5000, maxDepth: 6 };

export interface WalkFind {
    rel: string;
    kind: 'copy' | 'dep' | 'link';
}

export interface Unlinked {
    rel: string;
    bytes: number;
    partial: boolean;
}

export type WalkResult =
    | { kind: 'expanded'; finds: WalkFind[]; unlinked: Unlinked[]; unreadable: string[] }
    | { kind: 'capped'; bytes: number };

interface WalkState {
    main: string;
    classify: (_childRel: string) => EntryClass;
    handled: (_childRel: string) => boolean;
    limits: WalkLimits;
    visited: number;
    bytes: number;
    capped: boolean;
    finds: WalkFind[];
    unreadable: string[];
}

// What one folder's subtree gives its parent: whether it placed anything (a find or a handled child), its unmatched
// entries reported one by one, whether any reportable content exists and its summed size.
interface FolderOutcome {
    placed: boolean;
    reportable: boolean;
    bytes: number;
    children: Unlinked[];
}

function readNames(state: WalkState, folderRel: string): string[] | undefined {
    try {
        return fs.readdirSync(path.join(state.main, folderRel)).toSorted();
    } catch {
        state.unreadable.push(folderRel);
        return;
    }
}

// Collapses an unplaced subtree with reportable content into one entry; a placed subtree keeps its own entries.
function reportFor(childRel: string, outcome: FolderOutcome): Unlinked[] {
    if (outcome.placed) {
        return outcome.children;
    }
    return outcome.reportable ? [{ rel: childRel, bytes: outcome.bytes, partial: false }] : [];
}

function walkFolder(state: WalkState, folderRel: string, depth: number): FolderOutcome {
    const outcome: FolderOutcome = { placed: false, reportable: false, bytes: 0, children: [] };
    const names = readNames(state, folderRel);
    if (names === undefined) {
        return outcome;
    }
    for (const name of names) {
        const childRel = `${folderRel}/${name}`;
        if (state.handled(childRel)) {
            outcome.placed = true;
            continue;
        }
        state.visited += 1;
        if (state.visited > state.limits.maxEntries) {
            state.capped = true;
            return outcome;
        }
        const stat = lstatOrUndefined(path.join(state.main, childRel));
        const size = stat?.size ?? 0;
        state.bytes += size;
        const kind = state.classify(childRel);
        // Skip-class content is never reported, so it must not inflate the size of a collapsed folder.
        if (kind !== 'skip') {
            outcome.bytes += size;
        }
        switch (kind) {
            case 'copy':
            case 'dep':
            case 'link': {
                state.finds.push({ rel: childRel, kind });
                outcome.placed = true;
                break;
            }
            case 'not-linked': {
                outcome.reportable = true;
                outcome.children.push({ rel: childRel, bytes: size, partial: false });
                break;
            }
            case 'walk': {
                // Only a real directory is descended: readdir would follow a symlink to a folder.
                if (stat?.isDirectory() !== true) {
                    outcome.reportable = true;
                    outcome.children.push({ rel: childRel, bytes: size, partial: false });
                    break;
                }
                if (depth + 1 > state.limits.maxDepth) {
                    state.capped = true;
                    return outcome;
                }
                const inner = walkFolder(state, childRel, depth + 1);
                if (state.capped) {
                    return outcome;
                }
                outcome.bytes += inner.bytes;
                outcome.placed ||= inner.placed;
                outcome.reportable ||= inner.reportable;
                outcome.children.push(...reportFor(childRel, inner));
                break;
            }
            case 'skip': {
                break;
            }
        }
    }
    return outcome;
}

// Expands a collapsed folder of the main clone without following symlinks; see Unlinked for the report granularity.
export function walkCollapsed(
    main: string,
    rel: string,
    classify: (_childRel: string) => EntryClass,
    handled: (_childRel: string) => boolean,
    limits: WalkLimits = DEFAULT_WALK_LIMITS
): WalkResult {
    const state: WalkState = {
        main,
        classify,
        handled,
        limits,
        visited: 0,
        bytes: 0,
        capped: false,
        finds: [],
        unreadable: [],
    };
    const outcome = walkFolder(state, rel, 0);
    if (state.capped) {
        return { kind: 'capped', bytes: state.bytes };
    }
    return { kind: 'expanded', finds: state.finds, unlinked: reportFor(rel, outcome), unreadable: state.unreadable };
}

// Sums lstat sizes of FILE and everything below it without following symlinks, stopping after maxEntries entries.
export function boundedSize(file: string, maxEntries: number): { bytes: number; partial: boolean } {
    const pending = [file];
    let bytes = 0;
    let count = 0;
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
        if (count >= maxEntries) {
            return { bytes, partial: true };
        }
        count += 1;
        const stat = lstatOrUndefined(next);
        bytes += stat?.size ?? 0;
        if (stat?.isDirectory() !== true) {
            continue;
        }
        try {
            for (const name of fs.readdirSync(next)) {
                pending.push(path.join(next, name));
            }
        } catch {
            continue;
        }
    }
    return { bytes, partial: false };
}
