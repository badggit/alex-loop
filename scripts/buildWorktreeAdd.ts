import fs from 'node:fs';
import path from 'node:path';

import { build } from 'esbuild';

const repoRoot = path.resolve(import.meta.dirname, '..');
const defaultOutfile = path.join(repoRoot, 'plugins/alex-loop/skills/worktree-add/scripts/worktree-add.mjs');

// absWorkingDir pins the path comments in the bundle to the repo root, whatever the caller's directory is.
async function bundleWorktreeAdd(outfile: string): Promise<boolean> {
    try {
        await build({
            absWorkingDir: repoRoot,
            entryPoints: ['src/worktree-add/cli.ts'],
            outfile,
            bundle: true,
            platform: 'node',
            target: 'node22',
            format: 'esm',
            splitting: false,
            minify: false,
            sourcemap: false,
            legalComments: 'none',
            banner: { js: '#!/usr/bin/env node' },
            logLevel: 'silent',
        });
        return true;
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return false;
    }
}

const outfile = path.resolve(process.argv[2] ?? defaultOutfile);

if (await bundleWorktreeAdd(outfile)) {
    fs.chmodSync(outfile, 0o755);
} else {
    process.exitCode = 1;
}
