import path from 'node:path';

import { cloneFlags } from './cowGate.ts';
import { entrySizeKb, placeCopy, type PlaceResult, sweepDeadTemps } from './place.ts';
import { pidAlive } from './proc.ts';
import { showText } from './text.ts';
import type { CloneGate, CloneOutcome, CopyOutcome, Deps, EntryTransfer } from './types.ts';

export interface TransferOptions {
    main: string;
    worktree: string;
    gate: CloneGate;
    nowMs?: () => number;
}

interface Placement {
    source: string;
    dest: string;
}

type CopyMethod = 'copy-on-write' | 'plain copy';

type CopyResult = { ok: true; method: CopyMethod } | { ok: false; reason: string };

const NO_FLAGS: readonly string[] = [];
const UNSUPPORTED_REASON = 'copy-on-write clones are not supported on this platform';

function seconds(startedMs: number, endedMs: number): string {
    return ((endedMs - startedMs) / 1000).toFixed(1);
}

// The own link text is the main clone's entry, so an own link left at dest is replaced and a foreign entry never is.
function place(deps: Deps, placement: Placement, flags: readonly string[]): Promise<PlaceResult> {
    return placeCopy(deps, { ...placement, ownLinkText: placement.source, cloneFlags: flags });
}

// A clone that fails (no reflink after all, a foreign volume) gets exactly one plain-copy retry.
async function copyWithFallback(
    deps: Deps,
    rel: string,
    placement: Placement,
    flags: readonly string[] | undefined
): Promise<CopyResult> {
    if (flags !== undefined) {
        const cloned = await place(deps, placement, flags);
        if (cloned.ok) {
            return { ok: true, method: 'copy-on-write' };
        }
        deps.log.info(
            `cannot clone ${showText(rel)} with copy-on-write (${showText(cloned.reason)}); copying it instead`
        );
    }
    const copied = await place(deps, placement, NO_FLAGS);
    return copied.ok ? { ok: true, method: 'plain copy' } : copied;
}

// Copies never become links: a missing copy is safer than one shared between worktrees.
export function createTransfer(deps: Deps, options: TransferOptions): EntryTransfer {
    const { main, worktree, gate } = options;
    const nowMs = options.nowMs ?? (() => Date.now());
    const placementOf = (rel: string): Placement => ({
        source: path.join(main, rel),
        dest: path.join(worktree, rel),
    });
    const sweep = (placement: Placement): void => {
        sweepDeadTemps(path.dirname(placement.dest), pidAlive, deps.pid);
    };
    return {
        async copyEntry(rel): Promise<CopyOutcome> {
            const placement = placementOf(rel);
            sweep(placement);
            const verdict = await gate.check(deps, { main, worktree, rel });
            const flags = verdict.kind === 'available' ? cloneFlags(deps.platform) : undefined;
            const startedMs = nowMs();
            const result = await copyWithFallback(deps, rel, placement, flags);
            if (!result.ok) {
                deps.log.warn(`cannot copy ${showText(rel)} into the worktree: ${showText(result.reason)}`);
                return 'failed';
            }
            const elapsed = seconds(startedMs, nowMs());
            const sizeKb = String(entrySizeKb(placement.dest));
            deps.log.info(`copied ${showText(rel)} into the worktree: ${sizeKb} KB in ${elapsed} s (${result.method})`);
            return 'copied';
        },
        async cloneDependency(rel): Promise<CloneOutcome> {
            const verdict = await gate.check(deps, { main, worktree, rel });
            if (verdict.kind === 'unavailable') {
                return verdict;
            }
            const flags = cloneFlags(deps.platform);
            if (flags === undefined) {
                return { kind: 'unavailable', reason: UNSUPPORTED_REASON };
            }
            const placement = placementOf(rel);
            sweep(placement);
            deps.log.info(`cloning ${showText(rel)} into the worktree with copy-on-write`);
            const startedMs = nowMs();
            const result = await place(deps, placement, flags);
            if (!result.ok) {
                return { kind: 'failed', reason: result.reason };
            }
            deps.log.info(`cloned ${showText(rel)} into the worktree in ${seconds(startedMs, nowMs())} s`);
            return { kind: 'cloned' };
        },
    };
}
