import fs from 'node:fs';

import type { TempRegistry } from './types.ts';

function removeQuietly(file: string): void {
    try {
        fs.rmSync(file, { recursive: true, force: true });
    } catch {
        return;
    }
}

// removeAll is best effort and never throws, so it is safe in cleanup and signal paths.
export function createTempRegistry(): TempRegistry {
    const registered = new Set<string>();
    return {
        add: (file) => {
            registered.add(file);
        },
        remove: (file) => {
            registered.delete(file);
        },
        removeAll: () => {
            for (const file of registered) {
                removeQuietly(file);
            }
            registered.clear();
        },
    };
}
