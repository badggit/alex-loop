import fs from 'node:fs';
import path from 'node:path';

import type { Ecosystem } from './discover.ts';
import { SPAWN_FAILED_CODE } from './proc.ts';
import type { CommandResult, Deps, ManagerName } from './types.ts';

export interface ExpectedVersion {
    // For messages, for example 'yarn 2 or newer'.
    text: string;
    accepts(_major: number): boolean;
    // npm ignores packageManager, so a pin it does not match is only reported and the install still runs.
    advisory?: true;
}

export type ManagerChoice =
    | { kind: 'manager'; manager: ManagerName; expected: ExpectedVersion | undefined }
    | { kind: 'conflict'; reason: string };

export type VersionCheck =
    | { kind: 'ok'; version: string }
    | { kind: 'missing' }
    | { kind: 'mismatch'; expected: string; found: string }
    | { kind: 'differs'; expected: string; found: string };

type JsFamily = 'npm' | 'pnpm' | 'yarn' | 'bun';

interface PinnedManager {
    family: JsFamily;
    major: number;
    // As written in package.json, for example 'yarn@4.1.0'.
    spec: string;
}

type PackageManagerField =
    { kind: 'absent' } | { kind: 'pinned'; pin: PinnedManager } | { kind: 'invalid'; text: string };

export const VERSION_TIMEOUT_MS = 20_000;

// Lock headers and .yarnrc.yml settings sit near the top, so a large lock is never read whole.
const HEAD_BYTES = 64 * 1024;

const LOCK_FAMILIES: ReadonlyMap<string, JsFamily> = new Map([
    ['package-lock.json', 'npm'],
    ['npm-shrinkwrap.json', 'npm'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
]);

const FAMILY_LOCKS: Readonly<Record<JsFamily, readonly string[]>> = {
    npm: ['package-lock.json', 'npm-shrinkwrap.json'],
    pnpm: ['pnpm-lock.yaml'],
    yarn: ['yarn.lock'],
    bun: ['bun.lock', 'bun.lockb'],
};

// The single manager-to-binary mapping: the version check and the install both start this binary.
const EXECUTABLES: Readonly<Record<ManagerName, string>> = {
    npm: 'npm',
    pnpm: 'pnpm',
    'yarn-classic': 'yarn',
    'yarn-berry': 'yarn',
    bun: 'bun',
    uv: 'uv',
};

// The newest lock format has only a first writer: later pnpm majors keep writing it (pnpm 12 still writes 9.0)
// until pnpm moves to a new format, and a lock in a format unknown here skips the version check.
type PnpmLockWriters = { majors: readonly number[] } | { firstMajor: number };

// pnpm lockfileVersion major to the pnpm majors that write it.
const PNPM_LOCK_MAJORS: ReadonlyMap<number, PnpmLockWriters> = new Map([
    [9, { firstMajor: 9 }],
    [6, { majors: [8] }],
    [5, { majors: [6, 7] }],
]);

export function executableOf(manager: ManagerName): string {
    return EXECUTABLES[manager];
}

function isJsFamily(name: string): name is JsFamily {
    return Object.hasOwn(FAMILY_LOCKS, name);
}

function readHead(file: string): string | undefined {
    let fd: number | undefined;
    try {
        fd = fs.openSync(file, 'r');
        const buffer = Buffer.alloc(HEAD_BYTES);
        const size = fs.readSync(fd, buffer, 0, HEAD_BYTES, 0);
        return buffer.subarray(0, size).toString('utf8');
    } catch {
        return;
    } finally {
        if (fd !== undefined) {
            fs.closeSync(fd);
        }
    }
}

function readPackageManagerField(projectDir: string): PackageManagerField {
    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
    } catch {
        return { kind: 'absent' };
    }
    if (typeof parsed !== 'object' || !parsed || !('packageManager' in parsed)) {
        return { kind: 'absent' };
    }
    const value = parsed.packageManager;
    if (typeof value !== 'string') {
        return { kind: 'absent' };
    }
    const spec = value.trim();
    const match = /^([a-z]+)@(\d+)\.\d+\.\d+(?:[-+].*)?$/.exec(spec);
    const name = match?.[1];
    const major = match?.[2];
    if (name === undefined || major === undefined || !isJsFamily(name)) {
        return { kind: 'invalid', text: value };
    }
    return { kind: 'pinned', pin: { family: name, major: Number(major), spec } };
}

function exactMajor(name: string, major: number): ExpectedVersion {
    return { text: `${name} ${major}`, accepts: (found) => found === major };
}

function majorOrNewer(name: string, first: number): ExpectedVersion {
    return { text: `${name} ${first} or newer`, accepts: (found) => found >= first };
}

function yarnKind(projectDir: string): 'yarn-classic' | 'yarn-berry' | undefined {
    const head = readHead(path.join(projectDir, 'yarn.lock')) ?? '';
    if (/^__metadata:/m.test(head)) {
        return 'yarn-berry';
    }
    if (/^# yarn lockfile v1\s*$/m.test(head)) {
        return 'yarn-classic';
    }
    return;
}

function yarnPathMajor(projectDir: string): number | undefined {
    const rc = readHead(path.join(projectDir, '.yarnrc.yml')) ?? '';
    const match = /^yarnPath:\s*["']?([^"'\n#]*?)["']?\s*(?:#.*)?$/m.exec(rc);
    const release = /(?:^|\/)yarn-(\d+)\.\d+\.\d+\.cjs$/.exec(match?.[1] ?? '');
    return release?.[1] === undefined ? undefined : Number(release[1]);
}

function berryExpectation(projectDir: string): ExpectedVersion {
    const pinned = yarnPathMajor(projectDir);
    if (pinned !== undefined) {
        return exactMajor('yarn', pinned);
    }
    return majorOrNewer('yarn', 2);
}

function pnpmExpectation(projectDir: string): ExpectedVersion | undefined {
    const head = readHead(path.join(projectDir, 'pnpm-lock.yaml')) ?? '';
    const match = /^lockfileVersion:\s*["']?(\d+)(?:\.\d+)?["']?\s*$/m.exec(head);
    const writers = match?.[1] === undefined ? undefined : PNPM_LOCK_MAJORS.get(Number(match[1]));
    if (writers === undefined) {
        return;
    }
    if ('firstMajor' in writers) {
        return majorOrNewer('pnpm', writers.firstMajor);
    }
    const { majors } = writers;
    return { text: `pnpm ${majors.join(' or ')}`, accepts: (major) => majors.includes(major) };
}

function fromLock(projectDir: string, family: JsFamily): ManagerChoice {
    switch (family) {
        case 'npm':
        case 'bun': {
            return { kind: 'manager', manager: family, expected: undefined };
        }
        case 'pnpm': {
            return { kind: 'manager', manager: 'pnpm', expected: pnpmExpectation(projectDir) };
        }
        case 'yarn': {
            const kind = yarnKind(projectDir);
            if (kind === undefined) {
                return {
                    kind: 'conflict',
                    reason: 'yarn.lock has neither a "# yarn lockfile v1" header nor a __metadata: section',
                };
            }
            const expected = kind === 'yarn-berry' ? berryExpectation(projectDir) : exactMajor('yarn', 1);
            return { kind: 'manager', manager: kind, expected };
        }
    }
}

// A pin whose major cannot have written the lock file found next to it is a conflict, not a silent override.
function pinLockMismatch(projectDir: string, pin: PinnedManager): string | undefined {
    const shownPin = pin.spec.replace(/\+.*$/, '');
    if (pin.family === 'yarn') {
        const kind = yarnKind(projectDir);
        if (kind === 'yarn-berry' && pin.major === 1) {
            return `packageManager names ${shownPin} but yarn.lock is a yarn 2 or newer (berry) lock file`;
        }
        if (kind === 'yarn-classic' && pin.major !== 1) {
            return `packageManager names ${shownPin} but yarn.lock is a yarn 1 lock file`;
        }
        return;
    }
    if (pin.family === 'pnpm') {
        const allowed = pnpmExpectation(projectDir);
        if (allowed !== undefined && !allowed.accepts(pin.major)) {
            return `packageManager names ${shownPin} but pnpm-lock.yaml is written by ${allowed.text}`;
        }
    }
    return;
}

function fromPin(projectDir: string, pin: PinnedManager, lockNames: readonly string[]): ManagerChoice {
    const own = FAMILY_LOCKS[pin.family];
    if (!lockNames.some((name) => own.includes(name))) {
        return {
            kind: 'conflict',
            reason: `packageManager names ${pin.family} ${pin.major} but ${own.join(' / ')} is missing (found ${lockNames.join(', ')})`,
        };
    }
    const mismatch = pinLockMismatch(projectDir, pin);
    if (mismatch !== undefined) {
        return { kind: 'conflict', reason: mismatch };
    }
    const { family } = pin;
    let manager: ManagerName;
    if (family === 'yarn') {
        manager = pin.major === 1 ? 'yarn-classic' : 'yarn-berry';
    } else {
        manager = family;
    }
    const expected = exactMajor(pin.family, pin.major);
    return { kind: 'manager', manager, expected: family === 'npm' ? { ...expected, advisory: true } : expected };
}

export function chooseManager(projectDir: string, ecosystem: Ecosystem, lockNames: readonly string[]): ManagerChoice {
    if (ecosystem === 'uv') {
        return { kind: 'manager', manager: 'uv', expected: undefined };
    }
    const field = readPackageManagerField(projectDir);
    if (field.kind === 'invalid') {
        return {
            kind: 'conflict',
            reason: `package.json packageManager "${field.text}" is not a supported NAME@X.Y.Z`,
        };
    }
    if (field.kind === 'pinned') {
        return fromPin(projectDir, field.pin, lockNames);
    }
    const jsLocks = lockNames.filter((name) => LOCK_FAMILIES.has(name));
    const families = new Set(jsLocks.map((name) => LOCK_FAMILIES.get(name)));
    const [family, ...others] = families;
    if (family === undefined) {
        return { kind: 'conflict', reason: 'no JS lock file was found' };
    }
    if (others.length > 0) {
        return {
            kind: 'conflict',
            reason: `several package managers' lock files (${jsLocks.join(', ')}) and no packageManager in package.json`,
        };
    }
    return fromLock(projectDir, family);
}

function failureReason(result: CommandResult, timeoutMs: number): string {
    if (result.timedOut === true) {
        return `--version timed out after ${timeoutMs} ms`;
    }
    if (result.spawnError !== undefined) {
        return `could not start: ${result.spawnError}`;
    }
    const detail = (result.stderr.trim() || result.stdout.trim()).split('\n', 1)[0] ?? '';
    return `--version exited with code ${result.code}${detail ? `: ${detail}` : ''}`;
}

export async function checkManagerVersion(
    deps: Deps,
    manager: ManagerName,
    expected: ExpectedVersion | undefined,
    projectDir: string,
    timeoutMs: number = VERSION_TIMEOUT_MS
): Promise<VersionCheck> {
    // cwd is the project so a committed yarnPath release answers instead of the global yarn.
    const result = await deps.runner.run({
        file: executableOf(manager),
        args: ['--version'],
        cwd: projectDir,
        timeoutMs,
    });
    if (result.code === SPAWN_FAILED_CODE && result.spawnError === 'ENOENT') {
        return { kind: 'missing' };
    }
    const expectedText = expected?.text ?? `${executableOf(manager)} (any version)`;
    if (result.code !== 0 || result.timedOut === true) {
        return { kind: 'mismatch', expected: expectedText, found: `unknown (${failureReason(result, timeoutMs)})` };
    }
    const match = /(\d+)\.\d+(?:\.\d+)?/.exec(result.stdout);
    const version = match?.[0];
    const major = match?.[1];
    if (version === undefined || major === undefined) {
        return { kind: 'mismatch', expected: expectedText, found: 'unknown (no version in --version output)' };
    }
    if (expected !== undefined && !expected.accepts(Number(major))) {
        return { kind: expected.advisory === true ? 'differs' : 'mismatch', expected: expected.text, found: version };
    }
    return { kind: 'ok', version };
}
