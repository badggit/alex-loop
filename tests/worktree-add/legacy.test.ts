import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { EXCLUDE_HEADER } from '../../src/worktree-add/exclude.ts';
import { checkLegacyExcludes, toolBlockPaths } from '../../src/worktree-add/legacy.ts';
import type { CommandRequest, Env } from '../../src/worktree-add/types.ts';

import { testDeps } from './support/deps.ts';
import { commitFile, gitSync, makeRepo, testEnv } from './support/git.ts';
import { recording, withOverride } from './support/runners.ts';
import { tempRoot } from './support/tmp.ts';

const LOG_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z (info|warn|error) (.*)$/u;
const CANNOT_CHECK = 'cannot check the worktree-add lines of the exclude file: ';
const OWN_LINKS = 'this worktree has links to the main clone outside the current rules: ';

interface Fixture {
    env: Env;
    main: string;
    worktree: string;
}

function makeFixture(t: TestContext): Fixture {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    const worktree = path.join(root, 'app-wt');
    gitSync(env, ['-C', main, 'worktree', 'add', '--quiet', '-b', 'wt', worktree]);
    return { env, main, worktree: fs.realpathSync.native(worktree) };
}

function writeFile(root: string, rel: string, text = 'x\n'): void {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
}

function writeExclude(main: string, userLines: readonly string[], blockLines: readonly string[]): void {
    const text = [...userLines, EXCLUDE_HEADER, ...blockLines].join('\n');
    fs.writeFileSync(path.join(main, '.git', 'info', 'exclude'), `${text}\n`);
}

function messages(lines: readonly string[], level: string): string[] {
    return lines.flatMap((line) => {
        const match = LOG_LINE.exec(line);
        return match?.[1] === level ? [match[2] ?? ''] : [];
    });
}

function isLsFiles(request: CommandRequest): boolean {
    return request.file === 'git' && request.args.includes('ls-files');
}

function ownLink(fixture: Fixture, rel: string): void {
    fs.mkdirSync(path.join(fixture.main, rel), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(fixture.worktree, rel)), { recursive: true });
    fs.symlinkSync(path.join(fixture.main, rel), path.join(fixture.worktree, rel));
}

async function run(fixture: Fixture, keeps: (_rel: string) => boolean = () => true, deps = testDeps(fixture.env)) {
    await checkLegacyExcludes(deps, { main: fixture.main, worktree: fixture.worktree, env: fixture.env, keeps });
    return deps;
}

await test('toolBlockPaths reads the anchored lines after the header up to the next comment', () => {
    const text = ['/user', EXCLUDE_HEADER, '/a', '.alex-loop-tmp-*', String.raw`/b\*`, '', '# other', '/c'].join('\n');
    assert.deepEqual(toolBlockPaths(text), ['a', 'b*']);
    assert.deepEqual(toolBlockPaths('/a\n/b\n'), []);
});

await test('only the block line that hides files the repository rules do not ignore is warned about', async (t) => {
    const fixture = makeFixture(t);
    const { env, main } = fixture;
    commitFile(env, main, '.gitignore', '__pycache__/\n*.sqlite3\n/data/\n');
    commitFile(env, main, 'src/oldpkg/core.py', 'core\n');
    writeFile(main, 'src/oldpkg/__init__.py');
    writeFile(main, 'src/app/__pycache__/m.pyc');
    writeFile(main, 'backend/db.sqlite3');
    writeFile(main, 'data/a.csv');
    writeExclude(main, [], ['/src/oldpkg', '/src/app/__pycache__', '/backend/db.sqlite3', '/data']);
    const deps = await run(fixture);
    assert.deepEqual(messages(deps.lines, 'warn'), [
        '.git/info/exclude line /src/oldpkg hides 1 file that .gitignore does not ignore (src/oldpkg/__init__.py);' +
            ' git status and git add skip it. Remove the worktree-add links at src/oldpkg in every worktree first,' +
            ' then this line',
    ]);
    assert.deepEqual(messages(deps.lines, 'info'), []);
});

await test("a user's own exclude line outside the block counts as a repository rule", async (t) => {
    const fixture = makeFixture(t);
    writeFile(fixture.main, 'vendor-local/a.txt');
    writeExclude(fixture.main, ['# mine', '/vendor-local'], ['/vendor-local']);
    const deps = await run(fixture);
    assert.deepEqual(deps.lines, []);
});

await test('a user line after the tool block, past a comment line, counts as a repository rule', async (t) => {
    const fixture = makeFixture(t);
    writeFile(fixture.main, 'vendor-local/a.txt');
    writeExclude(fixture.main, [], ['/vendor-local', '# mine', '/vendor-local/']);
    const deps = await run(fixture);
    assert.deepEqual(deps.lines, []);
});

await test('own links outside the rules are named in one info line and nothing is removed', async (t) => {
    const fixture = makeFixture(t);
    ownLink(fixture, 'src/oldpkg');
    ownLink(fixture, 'docs.local');
    writeExclude(fixture.main, [], ['/src/oldpkg', '/docs.local', '/missing']);
    const deps = await run(fixture, (rel) => rel === 'docs.local');
    assert.deepEqual(messages(deps.lines, 'info'), [`${OWN_LINKS}src/oldpkg`]);
    assert.deepEqual(messages(deps.lines, 'warn'), []);
    assert.equal(fs.lstatSync(path.join(fixture.worktree, 'src/oldpkg')).isSymbolicLink(), true);
});

await test('a folder of untracked files is named as the folder, with at most three paths', async (t) => {
    const fixture = makeFixture(t);
    const { env, main } = fixture;
    for (let index = 0; index < 50; index += 1) {
        writeFile(main, `data/f${String(index)}.txt`);
    }
    commitFile(env, main, 'src/keep.txt', 'keep\n');
    for (const name of ['a', 'b', 'c', 'd']) {
        writeFile(main, `src/${name}.txt`);
    }
    writeExclude(main, [], ['/data', '/src']);
    const deps = await run(fixture);
    assert.deepEqual(messages(deps.lines, 'warn'), [
        '.git/info/exclude line /data hides 1 file that .gitignore does not ignore (data); git status and git add' +
            ' skip it. Remove the worktree-add links at data in every worktree first, then this line',
        '.git/info/exclude line /src hides 4 files that .gitignore does not ignore (src/a.txt, src/b.txt,' +
            ' src/c.txt, ...); git status and git add skip them. Remove the worktree-add links at src in every worktree' +
            ' first, then this line',
    ]);
});

await test('files ignored by the global excludes file from XDG_CONFIG_HOME are not reported', async (t) => {
    const fixture = makeFixture(t);
    const xdg = fixture.env.XDG_CONFIG_HOME ?? '';
    writeFile(xdg, 'git/ignore', '*.log\n');
    writeFile(fixture.main, 'app.log');
    writeExclude(fixture.main, [], ['/app.log']);
    const runner = recording(testDeps(fixture.env).runner);
    const deps = await run(fixture, () => true, testDeps(fixture.env, { runner }));
    assert.deepEqual(deps.lines, []);
    assert.equal(runner.calls.filter((request) => isLsFiles(request)).length, 1);
    const verbs = runner.calls.map((request) =>
        request.args.find((arg) => !arg.startsWith('-') && arg !== fixture.main)
    );
    assert.deepEqual(verbs, ['rev-parse', 'config', 'ls-files']);
});

await test('a relative core.excludesFile resolves against the main clone, not HOME', async (t) => {
    const fixture = makeFixture(t);
    writeFile(fixture.env.HOME ?? '', 'myignore', '*.log\n');
    writeFile(fixture.main, 'myignore', '*.tmp\n');
    gitSync(fixture.env, ['-C', fixture.main, 'config', 'core.excludesFile', 'myignore']);
    writeFile(fixture.main, 'scratch.tmp');
    writeFile(fixture.main, 'app.log');
    writeExclude(fixture.main, [], ['/scratch.tmp', '/app.log']);
    const deps = await run(fixture);
    assert.deepEqual(messages(deps.lines, 'warn'), [
        '.git/info/exclude line /app.log hides 1 file that .gitignore does not ignore (app.log); git status and' +
            ' git add skip it. Remove the worktree-add links at app.log in every worktree first, then this line',
    ]);
});

await test('a failing listing gives exactly one warning and nothing else', async (t) => {
    const fixture = makeFixture(t);
    ownLink(fixture, 'src/oldpkg');
    writeFile(fixture.main, 'src/oldpkg/__init__.py');
    writeExclude(fixture.main, [], ['/src/oldpkg']);
    const inner = testDeps(fixture.env);
    const runner = withOverride(inner.runner, isLsFiles, { code: 128, stdout: '', stderr: 'fatal: boom\n' });
    const deps = await run(fixture, () => false, testDeps(fixture.env, { runner }));
    assert.deepEqual(messages(deps.lines, 'warn'), [`${CANNOT_CHECK}fatal: boom`]);
    assert.equal(deps.lines.length, 1);
});

await test('an exclude file without the header or with an empty block runs no git call', async (t) => {
    const fixture = makeFixture(t);
    fs.writeFileSync(path.join(fixture.main, '.git', 'info', 'exclude'), '/src/oldpkg\n');
    const runner = recording(testDeps(fixture.env).runner);
    const deps = await run(fixture, () => false, testDeps(fixture.env, { runner }));
    assert.deepEqual(deps.lines, []);
    assert.equal(runner.calls.filter((request) => isLsFiles(request)).length, 0);
    writeExclude(fixture.main, [], ['.alex-loop-tmp-*']);
    const again = await run(fixture, () => false, testDeps(fixture.env, { runner }));
    assert.deepEqual(again.lines, []);
    assert.equal(runner.calls.filter((request) => isLsFiles(request)).length, 0);
});

await test('a missing exclude file is silent', async (t) => {
    const fixture = makeFixture(t);
    fs.rmSync(path.join(fixture.main, '.git', 'info', 'exclude'));
    const deps = await run(fixture);
    assert.deepEqual(deps.lines, []);
});

await test('an unknown exclude file path gives exactly one warning', async (t) => {
    const fixture = makeFixture(t);
    const inner = testDeps(fixture.env);
    const runner = withOverride(inner.runner, (request) => request.args.includes('rev-parse'), {
        code: 128,
        stdout: '',
        stderr: 'fatal: not a git repository\n',
    });
    const deps = await run(fixture, () => true, testDeps(fixture.env, { runner }));
    assert.equal(deps.lines.length, 1);
    assert.match(messages(deps.lines, 'warn')[0] ?? '', /^cannot check the worktree-add lines of the exclude file: /u);
});
