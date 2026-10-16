import path from 'node:path';

import { maskSecrets } from './mask.ts';
import { failureLine, showText } from './text.ts';
import type { CommandResult, Deps, Env } from './types.ts';

export interface ConfigSnapshot {
    file: string;
    entries: ReadonlyMap<string, readonly string[]>;
}

type ReadResult = { ok: true; entries: Map<string, string[]> } | { ok: false; reason: string };

const KEY_ABSENT_CODE = 5;
const UNSET = '(unset)';
const UNKNOWN = '(unknown)';
const HIDDEN = '***';
const SENSITIVE_KEY = /extraheader|password|passwd|token|secret|cookie|credential|auth/iu;
// push -u, branch --set-upstream-to and remote add from another worktree write these while the install runs.
const CONCURRENT_SECTIONS: ReadonlySet<string> = new Set(['branch', 'remote']);

function configGit(deps: Deps, file: string, args: readonly string[]): Promise<CommandResult> {
    return deps.runner.run({ file: 'git', args: ['config', '--file', file, ...args] });
}

// Records are KEY newline VALUE, NUL-terminated; a record without a newline is a valueless key, which git reads as true.
function parseList(stdout: string): Map<string, string[]> {
    const entries = new Map<string, string[]>();
    for (const record of stdout.split('\0')) {
        if (record.length === 0) {
            continue;
        }
        const at = record.indexOf('\n');
        const key = at === -1 ? record : record.slice(0, at);
        const value = at === -1 ? 'true' : record.slice(at + 1);
        const values = entries.get(key);
        if (values === undefined) {
            entries.set(key, [value]);
        } else {
            values.push(value);
        }
    }
    return entries;
}

async function readConfig(deps: Deps, file: string): Promise<ReadResult> {
    const result = await configGit(deps, file, ['--list', '-z']);
    if (result.code !== 0) {
        return { ok: false, reason: failureLine(result) };
    }
    return { ok: true, entries: parseList(result.stdout) };
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

// A sensitive key (an auth header, a token, ...) shows every value as *** so no part of it reaches the log.
function shownValues(key: string, values: readonly string[], env: Env): string {
    if (values.length === 0) {
        return UNSET;
    }
    if (SENSITIVE_KEY.test(key)) {
        return values.map(() => HIDDEN).join(', ');
    }
    return showText(maskSecrets(values.join(', '), env));
}

// A failed revert may have unset the key before an add failed, so the warning shows what the file holds now.
async function currentValues(deps: Deps, env: Env, file: string, key: string): Promise<string> {
    const read = await readConfig(deps, file);
    return read.ok ? shownValues(key, read.entries.get(key) ?? [], env) : UNKNOWN;
}

// Git compares section names without case (the subsection keeps its case), so the section is lowercased here.
function isConcurrentKey(key: string): boolean {
    const [section = ''] = key.split('.', 1);
    return CONCURRENT_SECTIONS.has(section.toLowerCase());
}

// Undefined when the folder is not a git checkout or its shared config cannot be read.
export async function snapshotSharedConfig(deps: Deps, worktree: string): Promise<ConfigSnapshot | undefined> {
    const result = await deps.runner.run({ file: 'git', args: ['-C', worktree, 'rev-parse', '--git-common-dir'] });
    const printed = result.stdout.trim();
    if (result.code !== 0 || printed.length === 0) {
        return;
    }
    const file = path.join(path.resolve(worktree, printed), 'config');
    const read = await readConfig(deps, file);
    return read.ok ? { file, entries: read.entries } : undefined;
}

// Returns the failure reason, or undefined when every recorded value is back.
async function restoreKey(
    deps: Deps,
    file: string,
    key: string,
    values: readonly string[]
): Promise<string | undefined> {
    const unset = await configGit(deps, file, ['--unset-all', key]);
    if (unset.code !== 0 && unset.code !== KEY_ABSENT_CODE) {
        return failureLine(unset);
    }
    for (const value of values) {
        const added = await configGit(deps, file, ['--add', key, value]);
        if (added.code !== 0) {
            return failureLine(added);
        }
    }
    return;
}

// Every key whose value list differs from the snapshot gets the recorded values back; returns the reverted keys.
// branch.* and remote.* keys are left alone, as other worktrees set them concurrently; any other change made by
// another process meanwhile cannot be told apart from the installs and is reverted too.
export async function revertConfigChanges(deps: Deps, env: Env, snapshot: ConfigSnapshot): Promise<string[]> {
    const file = showText(snapshot.file);
    const read = await readConfig(deps, snapshot.file);
    if (!read.ok) {
        const reason = showText(maskSecrets(read.reason, env));
        deps.log.warn(`cannot check the shared repository config ${file} after the install: ${reason}`);
        return [];
    }
    const keys = new Set([...snapshot.entries.keys(), ...read.entries.keys()]);
    const reverted: string[] = [];
    for (const key of keys) {
        const before = snapshot.entries.get(key) ?? [];
        const after = read.entries.get(key) ?? [];
        if (isConcurrentKey(key) || sameValues(before, after)) {
            continue;
        }
        const shownKey = showText(maskSecrets(key, env));
        const failure = await restoreKey(deps, snapshot.file, key, before);
        if (failure === undefined) {
            reverted.push(key);
            deps.log.warn(
                `reverted ${shownKey} in the shared repository config: an install changed it from ` +
                    `${shownValues(key, before, env)} to ${shownValues(key, after, env)}; ` +
                    'set it by hand if the branch needs it'
            );
        } else {
            const reason = showText(maskSecrets(failure, env));
            const stays = await currentValues(deps, env, snapshot.file, key);
            deps.log.warn(`cannot revert ${shownKey} in ${file}: ${reason}; it stays ${stays}`);
        }
    }
    return reverted;
}
