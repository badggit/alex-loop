import fs from 'node:fs';
import path from 'node:path';

import type { Env } from '../../../src/worktree-add/types.ts';

function isExecutableFile(file: string): boolean {
    try {
        fs.accessSync(file, fs.constants.X_OK);
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

// The first executable NAME on the PATH of env; throws when there is none.
export function realToolPath(name: string, env: Env): string {
    for (const dir of (env.PATH ?? '').split(':')) {
        const file = path.join(dir, name);
        if (path.isAbsolute(dir) && isExecutableFile(file)) {
            return file;
        }
    }
    throw new Error(`${name} is not on PATH`);
}

// Writes BIN_DIR/NAME as an executable #!/bin/sh script running body.
export function writeStubTool(binDir: string, name: string, body: string): void {
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}
