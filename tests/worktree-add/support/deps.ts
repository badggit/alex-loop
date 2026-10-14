import { createLogger } from '../../../src/worktree-add/log.ts';
import { createProcessRunner } from '../../../src/worktree-add/proc.ts';
import { createTempRegistry } from '../../../src/worktree-add/temps.ts';
import type { Deps, Env } from '../../../src/worktree-add/types.ts';

// Real runner with env, a logger capturing full lines in lines, a real temp registry, platform linux and this pid.
export function testDeps(env: Env, overrides?: Partial<Deps>): Deps & { lines: string[] } {
    const lines: string[] = [];
    const log = createLogger(
        (line) => {
            lines.push(line);
        },
        () => new Date()
    );
    return {
        runner: createProcessRunner(env),
        log,
        temps: createTempRegistry(),
        platform: 'linux',
        pid: process.pid,
        ...overrides,
        lines,
    };
}
