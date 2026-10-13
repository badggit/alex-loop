import fs from 'node:fs';

import type { Logger } from './types.ts';

type Level = 'info' | 'warn' | 'error';

function formatTime(date: Date): string {
    return `${date.toISOString().slice(0, 19)}Z`;
}

// Lines look like 2026-10-13T10:00:00Z info message (UTC, whole seconds).
export function createLogger(write: (_line: string) => void, clock: () => Date): Logger {
    const emit = (level: Level, message: string): void => {
        write(`${formatTime(clock())} ${level} ${message}`);
    };
    return {
        info: (message) => {
            emit('info', message);
        },
        warn: (message) => {
            emit('warn', message);
        },
        error: (message) => {
            emit('error', message);
        },
    };
}

// Synchronous writes keep every line on stderr even when the process ends right after logging.
export function stderrLogger(): Logger {
    return createLogger(
        (line) => {
            fs.writeSync(2, `${line}\n`);
        },
        () => new Date()
    );
}
