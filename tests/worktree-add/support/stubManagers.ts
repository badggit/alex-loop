import fs from 'node:fs';
import path from 'node:path';

import type { Env } from '../../../src/worktree-add/types.ts';

import { realToolPath } from './tools.ts';

const BASE_TOOLS = ['sh', 'git', 'cp', 'sleep', 'mkdir', 'rm', 'cat', 'touch', 'chmod', 'env'];

// Creates ROOT/bin with links to the real base tools only, so a stub package manager there is the only one found.
export function isolatedBin(root: string): string {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    for (const name of BASE_TOOLS) {
        fs.symlinkSync(realToolPath(name, process.env), path.join(bin, name));
    }
    return bin;
}

export function withPath(env: Env, bin: string): Env {
    return { ...env, PATH: bin };
}
