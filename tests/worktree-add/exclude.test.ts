import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { addExcludePatterns, anchoredPattern, EXCLUDE_HEADER } from '../../src/worktree-add/exclude.ts';

import { testDeps } from './support/deps.ts';
import { gitSync, makeRepo, testEnv } from './support/git.ts';
import { tempRoot } from './support/tmp.ts';

const CYRILLIC_NAME = '\u041F\u0440\u0438\u0432\u0435\u0442';
const OTHER_TOOL_HEADER = '# other-tool: links and dependency clones in worktrees, ignored in the main clone already';
const FAILURE_TAIL = '; the worktree links show as untracked and must be removed before git worktree remove';
const WARN_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z warn (.*)$/u;

function excludeFile(main: string): string {
    return path.join(main, '.git', 'info', 'exclude');
}

function warnMessages(lines: readonly string[]): string[] {
    return lines.map((line) => WARN_LINE.exec(line)?.[1] ?? `not a warn line: ${line}`);
}

await test('anchoredPattern escapes glob characters and the last trailing space only', () => {
    assert.equal(anchoredPattern('node_modules'), '/node_modules');
    assert.equal(anchoredPattern(String.raw`a*b?[c]\d`), String.raw`/a\*b\?\[c]\\d`);
    assert.equal(anchoredPattern('x '), String.raw`/x\ `);
    assert.equal(anchoredPattern('x  '), String.raw`/x \ `);
    assert.equal(anchoredPattern(CYRILLIC_NAME), `/${CYRILLIC_NAME}`);
    assert.equal(anchoredPattern('my notes/a b'), '/my notes/a b');
});

await test('two patterns on a fresh repo are written once under one header', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    const before = fs.readFileSync(excludeFile(main), 'utf8');
    const deps = testDeps(env);
    await addExcludePatterns(deps, main, ['/node_modules', '/docs.local']);
    assert.equal(
        fs.readFileSync(excludeFile(main), 'utf8'),
        `${before}${EXCLUDE_HEADER}\n/node_modules\n/docs.local\n`
    );
    assert.deepEqual(deps.lines, []);
});

await test('a second call appends only the new pattern and no second header', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    const before = fs.readFileSync(excludeFile(main), 'utf8');
    const deps = testDeps(env);
    await addExcludePatterns(deps, main, ['/node_modules', '/docs.local']);
    await addExcludePatterns(deps, main, ['/node_modules', '/docs.local', '/.claude']);
    assert.equal(
        fs.readFileSync(excludeFile(main), 'utf8'),
        `${before}${EXCLUDE_HEADER}\n/node_modules\n/docs.local\n/.claude\n`
    );
    assert.deepEqual(deps.lines, []);
});

await test('a last line without a newline gets one first', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    fs.writeFileSync(excludeFile(main), '*.log');
    await addExcludePatterns(testDeps(env), main, ['/node_modules']);
    assert.equal(fs.readFileSync(excludeFile(main), 'utf8'), `*.log\n${EXCLUDE_HEADER}\n/node_modules\n`);
});

await test('a missing info folder is created with the file', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    fs.rmSync(path.join(main, '.git', 'info'), { recursive: true, force: true });
    await addExcludePatterns(testDeps(env), main, ['/node_modules']);
    assert.equal(fs.readFileSync(excludeFile(main), 'utf8'), `${EXCLUDE_HEADER}\n/node_modules\n`);
});

await test('a known pattern under another header is not repeated, a new one goes under the alex-loop header', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    fs.writeFileSync(excludeFile(main), `${OTHER_TOOL_HEADER}\n/node_modules\n`);
    await addExcludePatterns(testDeps(env), main, ['/node_modules', '/temp.local']);
    assert.equal(
        fs.readFileSync(excludeFile(main), 'utf8'),
        `${OTHER_TOOL_HEADER}\n/node_modules\n${EXCLUDE_HEADER}\n/temp.local\n`
    );
});

await test('literal output of another worktree tool is recognized and left byte-identical', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    const seeded = [
        OTHER_TOOL_HEADER,
        '/node_modules',
        '/docs.local',
        String.raw`/notes\[1]`,
        String.raw`/a\*b\?`,
        String.raw`/back\\slash`,
        String.raw`/trail\ `,
        '',
    ].join('\n');
    fs.writeFileSync(excludeFile(main), seeded);
    const rels = ['node_modules', 'docs.local', 'notes[1]', 'a*b?', String.raw`back\slash`, 'trail '];
    const deps = testDeps(env);
    await addExcludePatterns(
        deps,
        main,
        rels.map((rel) => anchoredPattern(rel))
    );
    assert.equal(fs.readFileSync(excludeFile(main), 'utf8'), seeded);
    assert.deepEqual(deps.lines, []);
});

await test('a linked worktree writes the common info/exclude of the main clone', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    const worktree = path.join(root, 'app-task');
    gitSync(env, ['-C', main, 'worktree', 'add', '--quiet', '-b', 'task', worktree]);
    const before = fs.readFileSync(excludeFile(main), 'utf8');
    await addExcludePatterns(testDeps(env), worktree, ['/node_modules']);
    assert.equal(fs.readFileSync(excludeFile(main), 'utf8'), `${before}${EXCLUDE_HEADER}\n/node_modules\n`);
    assert.equal(fs.existsSync(path.join(main, '.git', 'worktrees', 'app-task', 'info')), false);
});

await test('an info path that is a regular file gives one warning and changes nothing', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    const info = path.join(main, '.git', 'info');
    fs.rmSync(info, { recursive: true, force: true });
    fs.writeFileSync(info, 'not a folder\n');
    const deps = testDeps(env);
    await addExcludePatterns(deps, main, ['/node_modules']);
    assert.deepEqual(warnMessages(deps.lines), [`cannot update ${excludeFile(main)}${FAILURE_TAIL}`]);
    assert.equal(fs.lstatSync(info).isFile(), true);
    assert.equal(fs.readFileSync(info, 'utf8'), 'not a folder\n');
});

await test('a folder outside any repository gives one warning and creates nothing', async (t) => {
    const root = tempRoot(t);
    const env = testEnv(root);
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    const deps = testDeps(env);
    await addExcludePatterns(deps, plain, ['/node_modules']);
    assert.deepEqual(warnMessages(deps.lines), [`cannot find the info/exclude file of the repository${FAILURE_TAIL}`]);
    assert.deepEqual(fs.readdirSync(plain), []);
});
