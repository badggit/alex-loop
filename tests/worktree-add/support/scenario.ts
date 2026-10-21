import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { TestContext } from 'node:test';

import { runWorktreeAdd, type CommandIo } from '../../../src/worktree-add/command.ts';
import { createProcessRunner } from '../../../src/worktree-add/proc.ts';
import type { Deps, Env, Outcome } from '../../../src/worktree-add/types.ts';

import { testDeps } from './deps.ts';
import { commitFile, gitSync, makeRepo, testEnv } from './git.ts';
import { withoutCow } from './runners.ts';
import { tempRoot } from './tmp.ts';

export interface Scenario {
    root: string;
    env: Env;
    main: string;
    deps: Deps & { lines: string[] };
}

export interface ScenarioSpec {
    ignore: string;
    tracked?: Record<string, string>;
    ignored?: Record<string, string>;
}

const LOG_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z (.*)$/u;

// A main clone app with SPEC.ignore as .gitignore, the tracked files pushed and the ignored ones written; no-CoW.
export function makeScenario(t: TestContext, spec: ScenarioSpec): Scenario {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    commitFile(env, main, '.gitignore', spec.ignore);
    for (const [file, text] of Object.entries(spec.tracked ?? {})) {
        commitFile(env, main, file, text);
    }
    gitSync(env, ['-C', main, 'push', '--quiet', 'origin', 'main']);
    for (const [file, text] of Object.entries(spec.ignored ?? {})) {
        const full = path.join(main, file);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, text);
    }
    const runner = withoutCow(createProcessRunner(env));
    t.after(() => runner.terminateAll());
    return { root, env, main, deps: testDeps(env, { runner }) };
}

export function runScenario(
    s: Scenario,
    argv: readonly string[],
    cwd = s.main,
    extra: Partial<CommandIo> = {}
): Promise<Outcome> {
    return runWorktreeAdd({ deps: s.deps, env: s.env, cwd, ...extra }, argv);
}

// The log lines as LEVEL MESSAGE, without the timestamp.
export function messages(s: Scenario): string[] {
    return s.deps.lines.map((line) => LOG_LINE.exec(line)?.[1] ?? `unformatted: ${line}`);
}

export function linkTextOf(file: string): string | undefined {
    return fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() === true ? fs.readlinkSync(file) : undefined;
}

export function okPath(outcome: Outcome): string {
    assert.equal(outcome.kind, 'ok', JSON.stringify(outcome));
    return outcome.kind === 'ok' ? outcome.path : '';
}
