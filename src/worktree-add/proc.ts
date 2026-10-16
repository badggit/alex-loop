import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import type { Readable } from 'node:stream';

import type { CommandRequest, CommandResult, CommandRunner, Env } from './types.ts';

type SpawnedChild = ChildProcessByStdio<null, Readable, Readable>;

type SpawnAttempt = { child: SpawnedChild } | { error: string };

interface Supervised {
    cancel(): void;
    result: Promise<CommandResult>;
}

export const SPAWN_FAILED_CODE = 127;
const KILLED_CODE = 137;
const KILL_GRACE_MS = 5000;
const GIVE_UP_MS = 10_000;
const GROUP_POLL_MS = 50;
// Node fires a timer after 1 ms when its delay is above this, so longer timeouts are clamped to it.
const MAX_TIMER_MS = 2_147_483_647;

function codeOrUndefined(error: unknown): string | undefined {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
        return error.code;
    }
    return;
}

// The request layer overrides the runner layer; an undefined value is skipped in the runner layer and removes the
// name in the request layer, so a request can keep an inherited variable away from its child.
function childEnv(runnerEnv: Env, requestEnv: Env | undefined): Record<string, string> {
    const result = new Map<string, string>();
    for (const [name, value] of Object.entries(runnerEnv)) {
        if (value !== undefined) {
            result.set(name, value);
        }
    }
    for (const [name, value] of Object.entries(requestEnv ?? {})) {
        if (value === undefined) {
            result.delete(name);
        } else {
            result.set(name, value);
        }
    }
    return Object.fromEntries(result);
}

function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
    if (code !== null) {
        return code;
    }
    if (signal !== null) {
        return 128 + osConstants.signals[signal];
    }
    return 1;
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
    if (pid === undefined) {
        return;
    }
    try {
        process.kill(-pid, signal);
    } catch {
        return;
    }
}

function groupHasMembers(pid: number | undefined): boolean {
    if (pid === undefined) {
        return false;
    }
    try {
        process.kill(-pid, 0);
        return true;
    } catch (error) {
        return codeOrUndefined(error) !== 'ESRCH';
    }
}

// detached gives every child its own process group, so a group signal also reaches the child's own children.
function trySpawn(request: CommandRequest, env: Env): SpawnAttempt {
    try {
        const child = spawn(request.file, [...request.args], {
            cwd: request.cwd,
            env: childEnv(env, request.env),
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
        });
        return { child };
    } catch (error) {
        return { error: codeOrUndefined(error) ?? (error instanceof Error ? error.message : 'spawn failed') };
    }
}

function ignoreResult(): void {
    return;
}

// cancel sends SIGTERM to the whole process group, SIGKILL after KILL_GRACE_MS while any member remains, and
// gives up on the streams at GIVE_UP_MS, so a cancelled run always settles whatever a grandchild does with the
// pipes. A timeoutMs runs the same cancel path and marks the result timedOut unless the child itself had already
// exited; without either there is no time limit.
function superviseChild(child: SpawnedChild, timeoutMs: number | undefined): Supervised {
    let resolveResult: (_result: CommandResult) => void = ignoreResult;
    const result = new Promise<CommandResult>((resolve) => {
        resolveResult = resolve;
    });
    const pid = child.pid;
    const output = { stdout: '', stderr: '' };
    const timers: NodeJS.Timeout[] = [];
    let settled = false;
    let cancelled = false;
    let timedOut = false;
    let killStepDone = false;
    let exitCode: number | undefined;
    let closeCode: number | undefined;

    const finish = (value: CommandResult): void => {
        if (settled) {
            return;
        }
        settled = true;
        for (const timer of timers) {
            clearTimeout(timer);
        }
        resolveResult(timedOut ? { ...value, timedOut: true } : value);
    };
    // A zombie left in the group would keep it non-empty, so after the kill step a closed child is enough.
    const finishWhenQuiet = (): void => {
        if (closeCode !== undefined && (killStepDone || !groupHasMembers(pid))) {
            finish({ code: closeCode, ...output });
        }
    };
    const poll = (): void => {
        finishWhenQuiet();
        if (!settled) {
            timers.push(setTimeout(poll, GROUP_POLL_MS));
        }
    };
    const cancel = (): void => {
        if (cancelled || settled) {
            return;
        }
        cancelled = true;
        signalGroup(pid, 'SIGTERM');
        timers.push(
            setTimeout(() => {
                if (groupHasMembers(pid)) {
                    signalGroup(pid, 'SIGKILL');
                }
                killStepDone = true;
                finishWhenQuiet();
            }, KILL_GRACE_MS),
            setTimeout(() => {
                child.stdout.destroy();
                child.stderr.destroy();
                finish({ code: closeCode ?? exitCode ?? KILLED_CODE, ...output });
            }, GIVE_UP_MS)
        );
        poll();
    };

    if (timeoutMs !== undefined) {
        timers.push(
            setTimeout(
                () => {
                    if (cancelled || settled) {
                        return;
                    }
                    // A child that already exited is not timed out; the cancel still runs, since whatever it left
                    // in its group may hold the pipes open and keep 'close' from ever coming.
                    if (exitCode === undefined) {
                        timedOut = true;
                    }
                    cancel();
                },
                Math.min(timeoutMs, MAX_TIMER_MS)
            )
        );
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
        output.stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
        output.stderr += chunk;
    });
    // ENOENT and other spawn failures emit 'error'; the first settle wins.
    child.on('error', (error) => {
        finish({ code: SPAWN_FAILED_CODE, ...output, spawnError: codeOrUndefined(error) ?? error.message });
    });
    child.on('exit', (code, signal) => {
        exitCode = exitCodeOf(code, signal);
    });
    child.on('close', (code, signal) => {
        closeCode = exitCodeOf(code, signal);
        if (cancelled) {
            finishWhenQuiet();
        } else {
            finish({ code: closeCode, ...output });
        }
    });
    return { cancel, result };
}

function runCommand(request: CommandRequest, env: Env, running: Set<Supervised>): Promise<CommandResult> {
    const attempt = trySpawn(request, env);
    if ('error' in attempt) {
        return Promise.resolve({ code: SPAWN_FAILED_CODE, stdout: '', stderr: '', spawnError: attempt.error });
    }
    const supervised = superviseChild(attempt.child, request.timeoutMs);
    running.add(supervised);
    return supervised.result.finally(() => {
        running.delete(supervised);
    });
}

async function terminateRunning(running: ReadonlySet<Supervised>): Promise<void> {
    const pending = [...running];
    for (const supervised of pending) {
        supervised.cancel();
    }
    await Promise.all(pending.map((supervised) => supervised.result));
}

// Children run without a shell, with stdin ignored and stdout and stderr collected as UTF-8; the runner never throws.
export function createProcessRunner(env: Env): CommandRunner {
    const running = new Set<Supervised>();
    return {
        run: (request) => runCommand(request, env, running),
        terminateAll: () => terminateRunning(running),
    };
}

// True for an integer above 1 that kill(pid, 0) accepts or refuses with EPERM (alive, owned by someone else).
export function pidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 1) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return codeOrUndefined(error) === 'EPERM';
    }
}
