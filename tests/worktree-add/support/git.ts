import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { Env } from '../../../src/worktree-add/types.ts';

function definedEntries(env: Env): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) {
        if (value !== undefined) {
            result[name] = value;
        }
    }
    return result;
}

// The process env without any inherited GIT_* name, HOME and XDG_CONFIG_HOME inside root, an empty global config, no system config, a placeholder
// identity and a ceiling at the parent of root, so git never reads the user's config or walks above root.
export function testEnv(root: string): Env {
    const home = path.join(root, 'home');
    const globalConfig = path.join(root, 'gitconfig');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(globalConfig, '');
    const inherited = Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'));
    return {
        ...Object.fromEntries(inherited),
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CEILING_DIRECTORIES: path.dirname(root),
        GIT_AUTHOR_NAME: 'test',
        GIT_COMMITTER_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
        GIT_TERMINAL_PROMPT: '0',
    };
}

// Runs git synchronously with exactly env and returns stdout; throws with stderr on failure.
export function gitSync(env: Env, args: readonly string[], cwd?: string): string {
    const result = spawnSync('git', [...args], { env: definedEntries(env), cwd, encoding: 'utf8' });
    if (result.error !== undefined) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed with ${String(result.status)}: ${result.stderr}`);
    }
    return result.stdout;
}

// Writes DIR/FILE (creating its folders), commits it and returns the new commit id.
export function commitFile(env: Env, dir: string, file: string, text: string): string {
    const full = path.join(dir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
    gitSync(env, ['-C', dir, 'add', '--', file]);
    gitSync(env, ['-C', dir, 'commit', '--quiet', '-m', `add ${file}`]);
    return gitSync(env, ['-C', dir, 'rev-parse', 'HEAD']).trim();
}

// A bare ROOT/origin.git and its main clone ROOT/NAME with one commit on main pushed and origin/HEAD at origin/main.
export function makeRepo(root: string, env: Env, name = 'app'): { main: string; origin: string } {
    const origin = path.join(root, 'origin.git');
    const main = path.join(root, name);
    gitSync(env, ['init', '--quiet', '--bare', '--initial-branch=main', origin]);
    gitSync(env, ['init', '--quiet', '--initial-branch=main', main]);
    gitSync(env, ['-C', main, 'remote', 'add', 'origin', origin]);
    commitFile(env, main, 'README.md', 'app\n');
    gitSync(env, ['-C', main, 'push', '--quiet', '--set-upstream', 'origin', 'main']);
    gitSync(env, ['-C', main, 'remote', 'set-head', 'origin', 'main']);
    return { main: fs.realpathSync.native(main), origin };
}
