import fs from 'node:fs';

import { executableOf } from './managers.ts';
import { errorCode } from './paths.ts';
import { messageOf } from './text.ts';
import type { CommandResult, Deps, Env, ManagerName } from './types.ts';

export interface AttemptRequest {
    manager: ManagerName;
    projectDir: string;
    // npm or npm in services/api
    label: string;
    // Absolute paths.
    lockFiles: readonly string[];
    deadlineMs: number;
    nowMs: () => number;
    networkTimeoutMs: number;
    progressMs: number;
}

export interface AttemptResult {
    ok: boolean;
    output: string;
    code: number;
    timedOut: boolean;
    spawnError: string | undefined;
    lockChanged: boolean;
    lockRestoreProblem: string | undefined;
    elapsedMs: number;
    online: boolean;
    lastOutput: string;
}

interface ManagerCommands {
    shown: string;
    offline: readonly string[] | undefined;
    offlineMissSignals: readonly string[];
    online: (_networkTimeoutMs: number) => readonly string[];
    // Applies to every attempt; an undefined value keeps an inherited variable away from the manager.
    env: Env;
    onlineEnv: (_networkTimeoutMs: number) => Env;
}

interface Attempt {
    args: readonly string[];
    env: Env;
}

const NPM_STYLE_FETCH_LIMITS = (timeoutMs: number): readonly string[] => [
    `--fetch-timeout=${timeoutMs}`,
    '--fetch-retries=1',
    '--fetch-retry-mintimeout=2000',
    '--fetch-retry-maxtimeout=10000',
];

const NO_ENV = (): Env => ({});

// An activated virtualenv or a project environment set in the shell would make uv sync into that environment
// instead of the worktree's own .venv, so both are removed for uv.
const UV_OWN_ENV: Env = { UV_PROJECT_ENVIRONMENT: undefined, VIRTUAL_ENV: undefined };

// uv reads its HTTP limits in whole seconds; the connect limit is a third of the read limit, at least 1 s.
function uvEnv(timeoutMs: number): Env {
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    return {
        UV_HTTP_TIMEOUT: String(seconds),
        UV_HTTP_RETRIES: '1',
        UV_HTTP_CONNECT_TIMEOUT: String(Math.max(1, Math.floor(seconds / 3))),
    };
}

const COMMANDS: Readonly<Record<ManagerName, ManagerCommands>> = {
    npm: {
        shown: 'npm ci',
        offline: ['ci', '--offline'],
        offlineMissSignals: ['ENOTCACHED'],
        online: (timeoutMs) => ['ci', ...NPM_STYLE_FETCH_LIMITS(timeoutMs)],
        env: {},
        onlineEnv: NO_ENV,
    },
    pnpm: {
        shown: 'pnpm install --frozen-lockfile',
        offline: ['install', '--frozen-lockfile', '--offline'],
        offlineMissSignals: ['ERR_PNPM_NO_OFFLINE_TARBALL', 'ERR_PNPM_NO_OFFLINE_META'],
        online: (timeoutMs) => ['install', '--frozen-lockfile', ...NPM_STYLE_FETCH_LIMITS(timeoutMs)],
        env: {},
        onlineEnv: NO_ENV,
    },
    'yarn-classic': {
        shown: 'yarn install --frozen-lockfile',
        offline: ['install', '--frozen-lockfile', '--offline'],
        offlineMissSignals: ["Couldn't find any versions", "Can't make a request in offline mode"],
        online: (timeoutMs) => ['install', '--frozen-lockfile', '--network-timeout', String(timeoutMs)],
        env: {},
        onlineEnv: NO_ENV,
    },
    'yarn-berry': {
        shown: 'yarn install --immutable',
        offline: undefined,
        offlineMissSignals: [],
        online: () => ['install', '--immutable'],
        env: {},
        onlineEnv: (timeoutMs) => ({ YARN_HTTP_TIMEOUT: String(timeoutMs), YARN_HTTP_RETRY: '1' }),
    },
    bun: {
        shown: 'bun install --frozen-lockfile',
        offline: undefined,
        offlineMissSignals: [],
        online: () => ['install', '--frozen-lockfile'],
        env: {},
        onlineEnv: NO_ENV,
    },
    uv: {
        shown: 'uv sync --frozen',
        offline: ['sync', '--frozen', '--offline'],
        // The last one is uv's hint when the project's Python must be downloaded, which offline mode forbids.
        offlineMissSignals: ['not found in the cache', 'Network connectivity is disabled', 'uv is set to offline mode'],
        online: () => ['sync', '--frozen'],
        env: UV_OWN_ENV,
        onlineEnv: uvEnv,
    },
};

export function installCommand(manager: ManagerName): string {
    return COMMANDS[manager].shown;
}

function combined(result: CommandResult): string {
    return result.stdout + result.stderr;
}

type LockState = { kind: 'absent' } | { kind: 'bytes'; bytes: Buffer } | { kind: 'unreadable'; reason: string };

// Only ENOENT counts as absent, so a lock that exists but cannot be read is never deleted by the restore.
function readLock(file: string): LockState {
    try {
        return { kind: 'bytes', bytes: fs.readFileSync(file) };
    } catch (error) {
        return errorCode(error) === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable', reason: messageOf(error) };
    }
}

function readLocks(files: readonly string[]): Map<string, LockState> {
    return new Map(files.map((file) => [file, readLock(file)]));
}

function sameLock(before: LockState, after: LockState): boolean {
    if (before.kind === 'bytes' && after.kind === 'bytes') {
        return before.bytes.equals(after.bytes);
    }
    return before.kind === 'absent' && after.kind === 'absent';
}

// Puts every changed lock file back as it was; a file that did not exist before is removed. A lock that could not
// be read before the install is left alone and reported, since there are no bytes to compare or restore.
function restoreLocks(snapshot: ReadonlyMap<string, LockState>): { changed: boolean; problem?: string } {
    let changed = false;
    const problems: string[] = [];
    for (const [file, before] of snapshot) {
        if (before.kind === 'unreadable') {
            problems.push(`${file}: could not be read before the install, left as it is: ${before.reason}`);
            continue;
        }
        if (sameLock(before, readLock(file))) {
            continue;
        }
        changed = true;
        try {
            if (before.kind === 'absent') {
                fs.rmSync(file, { force: true });
            } else {
                fs.writeFileSync(file, before.bytes);
            }
        } catch (error) {
            problems.push(`${file}: ${messageOf(error)}`);
        }
    }
    return problems.length === 0 ? { changed } : { changed, problem: problems.join('; ') };
}

function attemptsOf(commands: ManagerCommands, networkTimeoutMs: number): { offline?: Attempt; online: Attempt } {
    const online = {
        args: commands.online(networkTimeoutMs),
        env: { ...commands.env, ...commands.onlineEnv(networkTimeoutMs) },
    };
    const offline = commands.offline === undefined ? undefined : { args: commands.offline, env: commands.env };
    return offline === undefined ? { online } : { offline, online };
}

function showsOfflineMiss(commands: ManagerCommands, result: CommandResult): boolean {
    const text = combined(result);
    return commands.offlineMissSignals.some((signal) => text.includes(signal));
}

// Logs a progress line every progressMs while the attempt runs; the interval is cleared once it settles.
async function runWithProgress(
    deps: Deps,
    request: AttemptRequest,
    attempt: Attempt,
    firstStartMs: number
): Promise<CommandResult> {
    const timer = setInterval(() => {
        const seconds = Math.floor((request.nowMs() - firstStartMs) / 1000);
        deps.log.info(`still installing with ${request.label} (${seconds} s)`);
    }, request.progressMs);
    try {
        return await deps.runner.run({
            file: executableOf(request.manager),
            args: attempt.args,
            cwd: request.projectDir,
            env: attempt.env,
            timeoutMs: Math.max(0, request.deadlineMs - request.nowMs()),
        });
    } finally {
        clearInterval(timer);
    }
}

function noTimeLeft(request: AttemptRequest): boolean {
    return request.deadlineMs - request.nowMs() <= 0;
}

// Runs the offline attempt, then the online one only after a failed offline attempt shows a cache miss; the lock
// files are compared across both and restored when changed. Manager output is only returned, never printed.
export async function runInstall(deps: Deps, request: AttemptRequest): Promise<AttemptResult> {
    const commands = COMMANDS[request.manager];
    const attempts = attemptsOf(commands, request.networkTimeoutMs);
    const locks = readLocks(request.lockFiles);
    const startedMs = request.nowMs();
    let output = '';
    let last: CommandResult | undefined;
    let online = false;
    let skippedForTime = false;

    if (attempts.offline !== undefined) {
        if (noTimeLeft(request)) {
            skippedForTime = true;
        } else {
            last = await runWithProgress(deps, request, attempts.offline, startedMs);
            output += combined(last);
        }
    }
    const wantsOnline =
        last === undefined ? !skippedForTime : last.code !== 0 && !last.timedOut && showsOfflineMiss(commands, last);
    if (wantsOnline) {
        if (noTimeLeft(request)) {
            skippedForTime = true;
        } else {
            online = true;
            last = await runWithProgress(deps, request, attempts.online, startedMs);
            output += combined(last);
        }
    }

    const lockCheck = restoreLocks(locks);
    const timedOut = skippedForTime || last?.timedOut === true;
    const code = last?.code ?? 1;
    return {
        ok: code === 0 && !timedOut && !lockCheck.changed && lockCheck.problem === undefined,
        output,
        code,
        timedOut,
        spawnError: last?.spawnError,
        lockChanged: lockCheck.changed,
        lockRestoreProblem: lockCheck.problem,
        elapsedMs: request.nowMs() - startedMs,
        online,
        lastOutput: last === undefined ? '' : combined(last),
    };
}
