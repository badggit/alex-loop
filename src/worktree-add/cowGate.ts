import fs from 'node:fs';
import path from 'node:path';

import { lstatOrUndefined } from './paths.ts';
import { cpFile, tempName } from './place.ts';
import type { CloneGate, CommandRequest, Deps, GateResult } from './types.ts';

export interface DfMount {
    device: string;
    mountPoint: string;
}

export interface GateEnv {
    deviceOf: (_file: string) => number | undefined;
}

export const SAMPLE_ENTRY_LIMIT = 1000;

// Device, three numeric columns, a capacity ending with % and the mount point, which may hold spaces.
const DF_LINE = /^(\S+)\s+\S+\s+\S+\s+\S+\s+\S*%\s+(\S.*)$/;

const UNSUPPORTED: GateResult = {
    kind: 'unavailable',
    reason: 'copy-on-write clones are not supported on this platform',
};
const DIFFERENT_VOLUMES: GateResult = {
    kind: 'unavailable',
    reason: 'the clone and the worktree are on different volumes',
};
const NOT_APFS: GateResult = { kind: 'unavailable', reason: 'the worktree volume is not APFS' };
const VOLUME_READ_FAILURE: GateResult = { kind: 'unavailable', reason: 'cannot read the volume type' };
const NO_COW: GateResult = { kind: 'unavailable', reason: 'no copy-on-write between the clone and the worktree' };
const AVAILABLE: GateResult = { kind: 'available' };

// GNU --reflink=always fails where it cannot clone; macOS -c silently makes a full copy instead (hence the gate).
export function cloneFlags(platform: NodeJS.Platform): readonly string[] | undefined {
    if (platform === 'linux') {
        return ['--reflink=always'];
    }
    if (platform === 'darwin') {
        return ['-c'];
    }
    return;
}

// Reads the second line of `df -P PATH` output.
export function parseDfMount(stdout: string): DfMount | undefined {
    // Only leading space and a CR are dropped: a mount point may end with a space.
    const line = stdout.split('\n', 2)[1]?.replace(/\r$/, '').trimStart();
    if (!line) {
        return;
    }
    const match = DF_LINE.exec(line);
    const device = match?.[1];
    const mountPoint = match?.[2];
    if (!device || !mountPoint?.startsWith('/')) {
        return;
    }
    return { device, mountPoint };
}

// True only for a `mount` line "DEVICE on MOUNTPOINT (apfs, ...)" naming exactly this device and mount point.
export function isApfsMount(mountStdout: string, mount: DfMount): boolean {
    const prefix = `${mount.device} on ${mount.mountPoint} (`;
    return mountStdout.split('\n').some((line) => {
        if (!line.startsWith(prefix)) {
            return false;
        }
        const fsType = line.slice(prefix.length).split(/[),]/, 1)[0]?.trim();
        return fsType === 'apfs';
    });
}

function readEntries(dir: string): fs.Dirent[] {
    try {
        return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
}

// Breadth-first search for a regular file that never follows symbolic links and gives up after `limit` entries.
export function findSampleFile(dir: string, limit = SAMPLE_ENTRY_LIMIT): string | undefined {
    const queue = [path.resolve(dir)];
    let seen = 0;
    // Directories pushed while iterating are still visited: an array iterator reads the length on every step.
    for (const current of queue) {
        for (const entry of readEntries(current)) {
            if (seen >= limit) {
                return;
            }
            seen += 1;
            const full = path.join(current, entry.name);
            if (entry.isFile()) {
                return full;
            }
            if (entry.isDirectory()) {
                queue.push(full);
            }
        }
    }
    return;
}

function defaultDeviceOf(file: string): number | undefined {
    try {
        return fs.statSync(file).dev;
    } catch {
        return;
    }
}

function sampleUnder(source: string): string | undefined {
    const stat = lstatOrUndefined(source);
    if (stat?.isFile()) {
        return source;
    }
    return stat?.isDirectory() ? findSampleFile(source) : undefined;
}

function removeQuietly(file: string): void {
    try {
        fs.rmSync(file, { recursive: true, force: true });
    } catch {
        return;
    }
}

// The probe is registered before cp runs, so an interrupt mid-probe still removes it.
async function probeLinux(deps: Deps, sample: string, destination: string): Promise<GateResult> {
    const probe = tempName(destination, deps.pid);
    deps.temps.add(probe);
    try {
        const result = await deps.runner.run({
            file: cpFile('linux'),
            args: [...(cloneFlags('linux') ?? []), sample, probe],
        });
        return result.code === 0 && result.spawnError === undefined ? AVAILABLE : NO_COW;
    } finally {
        removeQuietly(probe);
        deps.temps.remove(probe);
    }
}

// The runner has no per-request environment, so LC_ALL=C goes through env(1).
function darwinTool(tool: string, args: readonly string[]): CommandRequest {
    return { file: '/usr/bin/env', args: ['LC_ALL=C', tool, ...args] };
}

async function checkDarwin(deps: Deps, worktree: string): Promise<GateResult> {
    const df = await deps.runner.run(darwinTool('/bin/df', ['-P', worktree]));
    const mount = await deps.runner.run(darwinTool('/sbin/mount', []));
    if (df.code !== 0 || mount.code !== 0 || df.spawnError !== undefined || mount.spawnError !== undefined) {
        return VOLUME_READ_FAILURE;
    }
    const volume = parseDfMount(df.stdout);
    if (!volume) {
        return VOLUME_READ_FAILURE;
    }
    return isApfsMount(mount.stdout, volume) ? AVAILABLE : NOT_APFS;
}

function sameVolume(deviceOf: GateEnv['deviceOf'], files: readonly string[]): boolean {
    const devices = files.map((file) => deviceOf(file));
    const first = devices[0];
    return first !== undefined && devices.every((device) => device === first);
}

// Caches one answer per (main, worktree) pair; an empty source tree and a volume mismatch are never cached.
export function createCloneGate(env?: Partial<GateEnv>): CloneGate {
    const deviceOf = env?.deviceOf ?? defaultDeviceOf;
    const cache = new Map<string, GateResult>();
    return {
        async check(deps, request) {
            if (deps.platform !== 'linux' && deps.platform !== 'darwin') {
                return UNSUPPORTED;
            }
            const source = path.join(request.main, request.rel);
            const destination = path.dirname(path.join(request.worktree, request.rel));
            if (deps.platform === 'darwin' && !sameVolume(deviceOf, [source, request.worktree, destination])) {
                return DIFFERENT_VOLUMES;
            }
            const key = `${request.main}\0${request.worktree}`;
            const cached = cache.get(key);
            if (cached) {
                return cached;
            }
            let result: GateResult;
            if (deps.platform === 'darwin') {
                result = await checkDarwin(deps, request.worktree);
            } else {
                const sample = sampleUnder(source);
                if (sample === undefined) {
                    return AVAILABLE;
                }
                result = await probeLinux(deps, sample, destination);
            }
            cache.set(key, result);
            return result;
        },
    };
}
