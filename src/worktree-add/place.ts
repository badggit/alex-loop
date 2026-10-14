import fs from 'node:fs';
import path from 'node:path';

import { isLinkWithText, lstatOrUndefined } from './paths.ts';
import { showText } from './text.ts';
import type { CommandResult, Deps } from './types.ts';

export const TEMP_PREFIX = '.alex-loop-tmp-';

const TEMP_NAME_PATTERN = /^\.alex-loop-tmp-(\d+)-\d+$/u;

export interface PlaceRequest {
    source: string;
    dest: string;
    ownLinkText: string;
    cloneFlags: readonly string[];
}

export type PlaceResult = { ok: true } | { ok: false; reason: string };

type Rename = (_from: string, _to: string) => void;

function errorCode(error: unknown): string {
    return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'unknown';
}

// Best effort: a temp that cannot be removed now is left for the next dead-PID sweep.
function removeQuietly(file: string): void {
    try {
        fs.rmSync(file, { recursive: true, force: true });
    } catch {
        return;
    }
}

// An injected alive check that throws keeps the temp: an unknown PID counts as alive.
function isAlive(alive: (_pid: number) => boolean, pid: number): boolean {
    try {
        return alive(pid);
    } catch {
        return true;
    }
}

export function tempName(dir: string, pid: number): string {
    let counter = 1;
    let temp = path.join(dir, `${TEMP_PREFIX}${String(pid)}-${String(counter)}`);
    while (lstatOrUndefined(temp) !== undefined) {
        counter += 1;
        temp = path.join(dir, `${TEMP_PREFIX}${String(pid)}-${String(counter)}`);
    }
    return temp;
}

// Removes temps left by runs that died mid-copy; temps of live runs and every other entry stay. Never throws.
export function sweepDeadTemps(dir: string, alive: (_pid: number) => boolean, ownPid: number): void {
    let names: string[];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return;
    }
    for (const name of names) {
        const match = TEMP_NAME_PATTERN.exec(name);
        if (match === null) {
            continue;
        }
        const pid = Number(match[1]);
        if (pid === ownPid || isAlive(alive, pid)) {
            continue;
        }
        removeQuietly(path.join(dir, name));
    }
}

// Sums lstat sizes without following links; an entry that cannot be read counts as 0.
export function entrySizeKb(file: string): number {
    let total = 0;
    const pending = [file];
    let next = pending.pop();
    while (next !== undefined) {
        const stat = lstatOrUndefined(next);
        if (stat !== undefined) {
            total += stat.size;
            if (stat.isDirectory()) {
                const dir = next;
                try {
                    for (const name of fs.readdirSync(dir)) {
                        pending.push(path.join(dir, name));
                    }
                } catch {
                    // An unreadable folder still counts its own size.
                }
            }
        }
        next = pending.pop();
    }
    return Math.ceil(total / 1024);
}

// macOS pins /bin/cp so a GNU cp earlier on PATH (Homebrew) is never used with -c; elsewhere cp comes from PATH.
export function cpFile(platform: NodeJS.Platform): string {
    return platform === 'darwin' ? '/bin/cp' : 'cp';
}

function cpFailure(result: CommandResult): string {
    const firstLine = result.stderr.split('\n', 1)[0] ?? '';
    const detail = firstLine === '' ? result.spawnError : firstLine;
    const reason = `cp exited with ${String(result.code)}`;
    return detail ? `${reason}: ${showText(detail)}` : reason;
}

// Best effort: the link comes back only where nothing else has appeared at dest meanwhile.
function restoreOwnLink(dest: string, ownLinkText: string): void {
    if (lstatOrUndefined(dest) !== undefined) {
        return;
    }
    try {
        fs.symlinkSync(ownLinkText, dest);
    } catch {
        // The rename error is the one reported; a failed restore must not hide it.
    }
}

// Only an absent dest or the tool's own link (text exactly ownLinkText) is replaced; anything else is never touched.
function moveIntoPlace(temp: string, request: PlaceRequest, rename: Rename): PlaceResult {
    const { dest, ownLinkText } = request;
    const replacesOwnLink = isLinkWithText(dest, ownLinkText);
    if (!replacesOwnLink && lstatOrUndefined(dest) !== undefined) {
        return { ok: false, reason: `something appeared at ${showText(dest)}` };
    }
    // Node has no RENAME_NOREPLACE, so an empty folder created at dest after the check above would be replaced by
    // rename(2); that window is accepted.
    try {
        if (replacesOwnLink) {
            fs.unlinkSync(dest);
        }
        rename(temp, dest);
        return { ok: true };
    } catch (error) {
        if (replacesOwnLink) {
            restoreOwnLink(dest, ownLinkText);
        }
        return { ok: false, reason: `cannot rename the copy into place (${errorCode(error)})` };
    }
}

// The temp sits next to dest for an atomic rename and stays registered in deps.temps until it is gone on return.
export async function placeCopy(
    deps: Deps,
    request: PlaceRequest,
    rename: Rename = fs.renameSync
): Promise<PlaceResult> {
    const temp = tempName(path.dirname(request.dest), deps.pid);
    deps.temps.add(temp);
    try {
        // cp -R into an existing target would nest the copy inside it; tempName guarantees TEMP is absent.
        const result = await deps.runner.run({
            file: cpFile(deps.platform),
            args: ['-R', '-P', '-p', ...request.cloneFlags, request.source, temp],
        });
        if (result.code !== 0 || result.spawnError !== undefined) {
            return { ok: false, reason: cpFailure(result) };
        }
        if (lstatOrUndefined(temp) === undefined) {
            return { ok: false, reason: 'cp exited with 0 but created nothing' };
        }
        return moveIntoPlace(temp, request, rename);
    } finally {
        removeQuietly(temp);
        deps.temps.remove(temp);
    }
}
