import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// Step 4 of the skill reads the script's log by these texts, so a reworded warning must fail here until the skill is
// updated with it: plugins/alex-loop/skills/worktree-add/SKILL.md, "## 4. Relay the output".
const ROOT = path.join(import.meta.dirname, '..', '..');
const SKILL = path.join(ROOT, 'plugins', 'alex-loop', 'skills', 'worktree-add', 'SKILL.md');
const SOURCES = path.join(ROOT, 'src', 'worktree-add');

// Every log key the skill keys on; each must still be named in step 4.
const KEYS: readonly string[] = [
    'cannot install dependencies',
    'not installed:',
    'not installed with',
    'cannot remove the partial install',
    'cannot clone',
    'cannot link',
    'to install:',
    'not installed automatically',
    'already stands',
    'stays missing',
    '... is left missing',
    'linked it',
    'linked it instead',
    'linked ... meanwhile',
    'the earlier link was restored',
    'installs skipped (--no-install): linked ...',
    'installs skipped: the network is disabled in this sandbox; linked ...',
];

// Backticked texts in step 4 that are paths, commands, levels or shell messages, not script log text.
const NOT_LOG_TEXT: ReadonlySet<string> = new Set([
    '.venv',
    'venv',
    'node',
    'node_modules',
    'info',
    'error',
    'node: not found',
    'No such file or directory',
    'Node 22 or newer is required, found X',
]);

// Texts the script builds from parts; each part must stand in the sources as written here.
const COMPOSED: Readonly<Record<string, readonly string[]>> = {
    'installs skipped (--no-install): linked ...': ['installs skipped (--no-install): ', '`linked ${shown}`'],
    'installs skipped: the network is disabled in this sandbox; linked ...': [
        'installs skipped: the network is disabled in this sandbox',
        '`linked ${shown}`',
    ],
    'linked node_modules: REASON': ['`linked ${showText(rel)}: ${showText(outcome.reason)}`'],
};

const PLACEHOLDER = /\.\.\.|\bMANAGER\b|\bPATH\b|\bREASON\b/u;

function stepFour(): string {
    const text = fs.readFileSync(SKILL, 'utf8');
    const start = text.indexOf('## 4. Relay the output');
    const end = text.indexOf('## 5.', start);
    assert.ok(start !== -1 && end !== -1, 'step 4 of SKILL.md was not found');
    return text.slice(start, end);
}

function backticked(text: string): string[] {
    return [...new Set([...text.matchAll(/`([^`]+)`/gu)].map((match) => match[1] ?? ''))];
}

function isLogText(token: string): boolean {
    return !NOT_LOG_TEXT.has(token) && !token.startsWith('rm ') && !token.startsWith('cd ');
}

// The literal parts of a skill text: placeholders split it, and parts that are only punctuation say nothing.
function fragments(token: string): readonly string[] {
    return (
        COMPOSED[token] ??
        token
            .split(PLACEHOLDER)
            .map((part) => part.trim())
            .filter((part) => /\w/u.test(part))
    );
}

function sourceText(): string {
    return fs
        .readdirSync(SOURCES)
        .filter((name) => name.endsWith('.ts'))
        .map((name) => fs.readFileSync(path.join(SOURCES, name), 'utf8'))
        .join('\n');
}

await test('step 4 of the skill still names every log key it relies on', () => {
    const tokens = new Set(backticked(stepFour()));
    for (const key of KEYS) {
        assert.ok(tokens.has(key), `SKILL.md step 4 no longer names \`${key}\``);
    }
});

await test('every log text step 4 of the skill keys on stands literally in the script sources', () => {
    const sources = sourceText();
    const missing = backticked(stepFour())
        .filter((token) => isLogText(token))
        .flatMap((token) => fragments(token).map((part) => ({ token, part })))
        .filter(({ part }) => !sources.includes(part))
        .map(({ token, part }) => `${token} (part: ${part})`);
    assert.deepEqual(missing, []);
});
