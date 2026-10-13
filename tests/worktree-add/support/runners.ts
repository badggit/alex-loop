import path from 'node:path';

import type { CommandRequest, CommandResult, CommandRunner } from '../../../src/worktree-add/types.ts';

const CLONE_FLAGS: ReadonlySet<string> = new Set(['--reflink=always', '-c']);
const LOCK_LINE_PREFIXES = ['locked', 'prunable'];

function isCp(request: CommandRequest): boolean {
    return path.basename(request.file) === 'cp';
}

// Options end at the first --, so an operand spelled like a flag is never taken for one.
function optionArgs(args: readonly string[]): readonly string[] {
    const end = args.indexOf('--');
    return end === -1 ? args : args.slice(0, end);
}

function carriesCloneFlag(request: CommandRequest): boolean {
    return isCp(request) && optionArgs(request.args).some((arg) => CLONE_FLAGS.has(arg));
}

function withoutCloneFlags(args: readonly string[]): string[] {
    const options = optionArgs(args);
    return [...options.filter((arg) => !CLONE_FLAGS.has(arg)), ...args.slice(options.length)];
}

function isPorcelainWorktreeList(request: CommandRequest): boolean {
    const { args } = request;
    const at = args.indexOf('worktree');
    return (
        path.basename(request.file) === 'git' && at !== -1 && args[at + 1] === 'list' && args.includes('--porcelain')
    );
}

// Every request is recorded in calls before it goes to inner.
export function recording(inner: CommandRunner): CommandRunner & { calls: CommandRequest[] } {
    const calls: CommandRequest[] = [];
    return {
        calls,
        run: (request) => {
            calls.push(request);
            return inner.run(request);
        },
        terminateAll: () => inner.terminateAll(),
    };
}

// A cp request runs without --reflink=always and -c, so the real copy stands in for a successful clone; calls
// records every cp request as it was received.
export function withCowEmulation(inner: CommandRunner): CommandRunner & { calls: CommandRequest[] } {
    const calls: CommandRequest[] = [];
    return {
        calls,
        run: (request) => {
            if (!isCp(request)) {
                return inner.run(request);
            }
            calls.push(request);
            return inner.run({ ...request, args: withoutCloneFlags(request.args) });
        },
        terminateAll: () => inner.terminateAll(),
    };
}

// A cloning cp (--reflink=always or -c) fails with code 1 without running, forcing the no-CoW outcome on any host.
export function withoutCow(inner: CommandRunner): CommandRunner {
    return {
        run: (request) => {
            if (carriesCloneFlag(request)) {
                return Promise.resolve({ code: 1, stdout: '', stderr: 'failed to clone' });
            }
            return inner.run(request);
        },
        terminateAll: () => inner.terminateAll(),
    };
}

// Requests that match answer result without running; every other request goes to inner.
export function withOverride(
    inner: CommandRunner,
    match: (_request: CommandRequest) => boolean,
    result: CommandResult
): CommandRunner {
    return {
        run: (request) => (match(request) ? Promise.resolve({ ...result }) : inner.run(request)),
        terminateAll: () => inner.terminateAll(),
    };
}

// Emulates git 2.29, whose worktree list --porcelain has no locked or prunable lines.
export function withoutLockLines(inner: CommandRunner): CommandRunner {
    return {
        run: async (request) => {
            const result = await inner.run(request);
            if (!isPorcelainWorktreeList(request)) {
                return result;
            }
            const separator = request.args.includes('-z') ? '\0' : '\n';
            const kept = result.stdout
                .split(separator)
                .filter((line) => !LOCK_LINE_PREFIXES.some((prefix) => line.startsWith(prefix)));
            return { ...result, stdout: kept.join(separator) };
        },
        terminateAll: () => inner.terminateAll(),
    };
}
