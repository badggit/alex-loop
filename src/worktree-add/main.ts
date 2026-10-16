import fs from 'node:fs';

import { usageText } from './args.ts';
import { runWorktreeAdd } from './command.ts';
import { stderrLogger } from './log.ts';
import { createProcessRunner } from './proc.ts';
import { createTempRegistry } from './temps.ts';
import { showText } from './text.ts';
import type { CommandRunner, Deps, Logger, Outcome } from './types.ts';

interface StoppableRunner extends CommandRunner {
    stop(): void;
    stopped(): boolean;
}

const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const;
const STOPPED_CODE = 1;

// After a signal no child starts, so a run never rolls back a branch it made; the next run reuses it as existing.
function stoppable(inner: CommandRunner): StoppableRunner {
    let stopped = false;
    return {
        run: (request) =>
            stopped
                ? Promise.resolve({ code: STOPPED_CODE, stdout: '', stderr: '', spawnError: 'interrupted' })
                : inner.run(request),
        terminateAll: () => inner.terminateAll(),
        stop: () => {
            stopped = true;
        },
        stopped: () => stopped,
    };
}

// First signal: stop child groups, drop temps, re-raise; later signals are ignored.
function installSignalCleanup(deps: Deps, runner: StoppableRunner): () => void {
    const listeners = new Map<NodeJS.Signals, () => void>();
    const uninstall = (): void => {
        for (const [signal, listener] of listeners) {
            process.removeListener(signal, listener);
        }
        listeners.clear();
    };
    const cleanUp = async (signal: NodeJS.Signals): Promise<void> => {
        await runner.terminateAll();
        deps.temps.removeAll();
        uninstall();
        process.kill(process.pid, signal);
    };
    for (const signal of STOP_SIGNALS) {
        const listener = (): void => {
            if (runner.stopped()) {
                return;
            }
            runner.stop();
            void cleanUp(signal);
        };
        listeners.set(signal, listener);
        process.on(signal, listener);
    }
    return uninstall;
}

function writeStderr(text: string): void {
    fs.writeSync(2, text);
}

function report(deps: Deps, outcome: Outcome): number {
    switch (outcome.kind) {
        case 'ok': {
            fs.writeSync(1, `${outcome.path}\n`);
            return 0;
        }
        case 'refused': {
            deps.log.error(outcome.reason);
            return 1;
        }
        case 'usage': {
            deps.log.error(outcome.message);
            writeStderr(usageText());
            return 2;
        }
        case 'help': {
            writeStderr(usageText());
            return 0;
        }
    }
}

export interface MainOptions {
    run?: typeof runWorktreeAdd;
    log?: Logger;
}

export async function main(options: MainOptions = {}): Promise<void> {
    const startedMs = Date.now();
    const run = options.run ?? runWorktreeAdd;
    const env = process.env;
    const runner = stoppable(createProcessRunner(env));
    const deps: Deps = {
        runner,
        log: options.log ?? stderrLogger(),
        temps: createTempRegistry(),
        platform: process.platform,
        pid: process.pid,
    };
    const uninstall = installSignalCleanup(deps, runner);
    try {
        const outcome = await run({ deps, env, cwd: process.cwd(), startedMs }, process.argv.slice(2));
        // A signal cleanup in progress owns the exit: it re-raises the signal once the children are gone.
        if (runner.stopped()) {
            return;
        }
        uninstall();
        process.exitCode = report(deps, outcome);
    } catch (error) {
        if (runner.stopped()) {
            return;
        }
        uninstall();
        deps.log.error(showText(error instanceof Error ? error.message : String(error)));
        process.exitCode = 1;
    }
}
