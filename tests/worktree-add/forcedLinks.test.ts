import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { linkForced, logLinked, placeForcedLinks } from '../../src/worktree-add/forcedLinks.ts';
import type { Env } from '../../src/worktree-add/types.ts';

import { testDeps } from './support/deps.ts';
import { commitFile, gitSync, makeRepo, testEnv } from './support/git.ts';
import { tempRoot } from './support/tmp.ts';

const LOG_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z (info|warn|error) (.*)$/u;
const NOT_LINKED = 'not linked with --link: ';
const ROOT_SKIP = process.getuid?.() === 0 ? 'root ignores directory modes' : false;

interface Fixture {
    env: Env;
    main: string;
    worktree: string;
}

function makeFixture(t: TestContext, gitignore: string): Fixture {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    commitFile(env, main, '.gitignore', gitignore);
    const worktree = path.join(root, 'app-wt');
    gitSync(env, ['-C', main, 'worktree', 'add', '--quiet', '-b', 'wt', worktree]);
    return { env, main, worktree: fs.realpathSync.native(worktree) };
}

function writeFile(root: string, rel: string, text = 'x\n'): void {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
}

function messages(lines: readonly string[], level: string): string[] {
    return lines.flatMap((line) => {
        const match = LOG_LINE.exec(line);
        return match?.[1] === level ? [match[2] ?? ''] : [];
    });
}

function excludeLines(main: string): string[] {
    const file = path.join(main, '.git', 'info', 'exclude');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
}

function linkText(worktree: string, rel: string): string | undefined {
    const file = path.join(worktree, rel);
    return fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() === true ? fs.readlinkSync(file) : undefined;
}

function exists(file: string): boolean {
    return fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined;
}

await test('a folder ignored only through its files and a file in an absent ignored folder are linked', async (t) => {
    const fixture = makeFixture(t, 'config/*\nbackend/\n');
    const { env, main, worktree } = fixture;
    writeFile(main, 'config/settings.json');
    writeFile(main, 'config/keys.json');
    writeFile(main, 'backend/db.sqlite3');
    const deps = testDeps(env);
    const linked = await linkForced(deps, { main, worktree }, ['config', 'backend/db.sqlite3']);
    assert.deepEqual(linked, ['config', 'backend/db.sqlite3']);
    assert.equal(linkText(worktree, 'config'), path.join(main, 'config'));
    const backend = fs.lstatSync(path.join(worktree, 'backend'));
    assert.equal(backend.isDirectory() && !backend.isSymbolicLink(), true);
    assert.equal(linkText(worktree, 'backend/db.sqlite3'), path.join(main, 'backend/db.sqlite3'));
    const lines = excludeLines(main);
    assert.equal(lines.includes('/backend/db.sqlite3'), true);
    assert.equal(lines.includes('/config'), true);
    assert.deepEqual(deps.lines, []);
});

await test('only a file in an absent ignored folder is returned when it is the only path', async (t) => {
    const fixture = makeFixture(t, 'backend/\n');
    const { env, main, worktree } = fixture;
    writeFile(main, 'backend/db.sqlite3');
    const deps = testDeps(env);
    const linked = await linkForced(deps, { main, worktree }, ['backend/db.sqlite3']);
    assert.deepEqual(linked, ['backend/db.sqlite3']);
    assert.equal(excludeLines(main).filter((line) => line === '/backend/db.sqlite3').length, 1);
});

await test('a build output folder is linked with a warning once; a second call changes and logs nothing', async (t) => {
    const fixture = makeFixture(t, 'target/\n');
    const { env, main, worktree } = fixture;
    commitFile(env, main, 'Cargo.toml', '[package]\n');
    gitSync(env, ['-C', worktree, 'merge', '--quiet', '--ff-only', 'main']);
    writeFile(main, 'target/debug/app');
    const deps = testDeps(env);
    assert.deepEqual(await linkForced(deps, { main, worktree }, ['target']), ['target']);
    assert.deepEqual(messages(deps.lines, 'warn'), [
        'linked target with --link: build outputs are now shared with the main clone',
    ]);
    assert.deepEqual(messages(deps.lines, 'info'), []);
    assert.equal(linkText(worktree, 'target'), path.join(main, 'target'));
    const before = excludeLines(main);
    assert.equal(before.filter((line) => line === '/target').length, 1);
    const again = testDeps(env);
    assert.deepEqual(await linkForced(again, { main, worktree }, ['target']), ['target']);
    assert.deepEqual(again.lines, []);
    assert.deepEqual(excludeLines(main), before);
});

await test('placeForcedLinks names as created only the links this call placed', async (t) => {
    const { env, main, worktree } = makeFixture(t, 'data/\nmore/\n');
    writeFile(main, 'data/a.txt');
    writeFile(main, 'more/b.txt');
    const deps = testDeps(env);
    assert.deepEqual(await placeForcedLinks(deps, { main, worktree }, ['data']), {
        standing: ['data'],
        created: ['data'],
    });
    assert.deepEqual(await placeForcedLinks(deps, { main, worktree }, ['data', 'more', 'data']), {
        standing: ['data', 'more'],
        created: ['more'],
    });
});

await test('invalid targets each get their pinned warning, create nothing and are not returned', async (t) => {
    const fixture = makeFixture(t, 'node_modules/\n.env\nvendor/\n');
    const { env, main, worktree } = fixture;
    commitFile(env, main, 'src/app.ts', 'app\n');
    gitSync(env, ['-C', worktree, 'merge', '--quiet', '--ff-only', 'main']);
    writeFile(main, 'node_modules/pkg/index.js');
    writeFile(main, '.env');
    writeFile(main, 'vendor/lib/x.bin');
    fs.symlinkSync(path.join(main, 'vendor'), path.join(worktree, 'vendor'));
    const deps = testDeps(env);
    const targets = ['missing/file', 'src/app.ts', 'node_modules', '.env', 'vendor/lib/x.bin'];
    const linked = await linkForced(deps, { main, worktree }, targets);
    assert.deepEqual(linked, []);
    assert.deepEqual(messages(deps.lines, 'warn'), [
        `${NOT_LINKED}missing/file does not exist in the main clone`,
        `${NOT_LINKED}src/app.ts is not ignored in the main clone`,
        `${NOT_LINKED}node_modules is a dependency folder; the install stage handles it`,
        `${NOT_LINKED}.env is copied per worktree, never linked`,
        `${NOT_LINKED}vendor/lib/x.bin: its folder vendor in the worktree is a link or not a folder`,
    ]);
    assert.equal(exists(path.join(worktree, 'missing')), false);
    assert.equal(linkText(worktree, 'src/app.ts'), undefined);
    assert.equal(exists(path.join(worktree, 'node_modules')), false);
    assert.equal(exists(path.join(worktree, '.env')), false);
    assert.equal(fs.readdirSync(path.join(main, 'vendor/lib')).join(','), 'x.bin');
    assert.deepEqual(
        excludeLines(main).filter((line) => line.startsWith('/')),
        []
    );
});

await test('a path below a dependency folder or a copied folder is refused and creates nothing', async (t) => {
    const fixture = makeFixture(t, 'node_modules/\n.venv/\ntemp.local/\n');
    const { env, main, worktree } = fixture;
    writeFile(main, 'node_modules/foo/index.js');
    writeFile(main, '.venv/pyvenv.cfg');
    writeFile(main, '.venv/lib/x.py');
    writeFile(main, 'temp.local/x');
    const deps = testDeps(env);
    const linked = await linkForced(deps, { main, worktree }, ['node_modules/foo', '.venv/lib', 'temp.local/x']);
    assert.deepEqual(linked, []);
    assert.deepEqual(messages(deps.lines, 'warn'), [
        `${NOT_LINKED}node_modules/foo is a dependency folder; the install stage handles it`,
        `${NOT_LINKED}.venv/lib is a dependency folder; the install stage handles it`,
        `${NOT_LINKED}temp.local/x is copied per worktree, never linked`,
    ]);
    for (const rel of ['node_modules', '.venv', 'temp.local']) {
        assert.equal(exists(path.join(worktree, rel)), false, rel);
    }
    assert.deepEqual(
        excludeLines(main).filter((line) => line.startsWith('/')),
        []
    );
});

await test('a path inside a folder the rules link whole is refused and creates nothing', async (t) => {
    const fixture = makeFixture(t, '.idea/\ndocs.local/\n');
    const { env, main, worktree } = fixture;
    writeFile(main, '.idea/workspace.xml');
    writeFile(main, '.idea/misc.xml');
    writeFile(main, 'docs.local/x/a.md');
    const deps = testDeps(env);
    const linked = await linkForced(deps, { main, worktree }, ['.idea/workspace.xml', 'docs.local/x']);
    assert.deepEqual(linked, []);
    assert.deepEqual(messages(deps.lines, 'warn'), [
        `${NOT_LINKED}.idea/workspace.xml: it is inside .idea, which is linked whole`,
        `${NOT_LINKED}docs.local/x: it is inside docs.local, which is linked whole`,
    ]);
    assert.equal(exists(path.join(worktree, '.idea')), false);
    assert.equal(exists(path.join(worktree, 'docs.local')), false);
    assert.deepEqual(
        excludeLines(main).filter((line) => line.startsWith('/')),
        []
    );
    fs.symlinkSync(path.join(main, '.idea'), path.join(worktree, '.idea'));
    const again = testDeps(env);
    assert.deepEqual(await linkForced(again, { main, worktree }, ['.idea/workspace.xml']), []);
    assert.deepEqual(messages(again.lines, 'warn'), [
        `${NOT_LINKED}.idea/workspace.xml: it is inside .idea, which is linked whole`,
    ]);
});

await test('a path inside a link folder that git does not list whole is linked', async (t) => {
    const fixture = makeFixture(t, '.idea/workspace.xml\n');
    const { env, main, worktree } = fixture;
    commitFile(env, main, '.idea/misc.xml', 'misc\n');
    gitSync(env, ['-C', worktree, 'merge', '--quiet', '--ff-only', 'main']);
    writeFile(main, '.idea/workspace.xml');
    const deps = testDeps(env);
    assert.deepEqual(await linkForced(deps, { main, worktree }, ['.idea/workspace.xml']), ['.idea/workspace.xml']);
    assert.equal(linkText(worktree, '.idea/workspace.xml'), path.join(main, '.idea/workspace.xml'));
    assert.deepEqual(deps.lines, []);
});

await test('a parent that is a file in the worktree is named as not a folder', async (t) => {
    const fixture = makeFixture(t, 'data/\n');
    const { env, main, worktree } = fixture;
    writeFile(main, 'data/models/w.bin');
    writeFile(worktree, 'data', 'file\n');
    const deps = testDeps(env);
    assert.deepEqual(await linkForced(deps, { main, worktree }, ['data/models']), []);
    assert.deepEqual(messages(deps.lines, 'warn'), [
        `${NOT_LINKED}data/models: its folder data in the worktree is a link or not a folder`,
    ]);
});

await test('a parent that cannot be created is named with the error code', { skip: ROOT_SKIP }, async (t) => {
    const fixture = makeFixture(t, 'data/\n');
    const { env, main, worktree } = fixture;
    writeFile(main, 'data/models/w.bin');
    fs.chmodSync(worktree, 0o555);
    const deps = testDeps(env);
    try {
        assert.deepEqual(await linkForced(deps, { main, worktree }, ['data/models']), []);
    } finally {
        fs.chmodSync(worktree, 0o755);
    }
    assert.deepEqual(messages(deps.lines, 'warn'), [
        `${NOT_LINKED}data/models: cannot create its folder data in the worktree (EACCES)`,
    ]);
});

await test('another entry standing at the path in the worktree is left alone', async (t) => {
    const fixture = makeFixture(t, 'data/\n');
    const { env, main, worktree } = fixture;
    writeFile(main, 'data/a.csv');
    writeFile(worktree, 'data/a.csv', 'mine\n');
    const deps = testDeps(env);
    assert.deepEqual(await linkForced(deps, { main, worktree }, ['data']), []);
    assert.deepEqual(messages(deps.lines, 'warn'), [
        `${NOT_LINKED}something else already stands at data in the worktree`,
    ]);
    assert.equal(fs.readFileSync(path.join(worktree, 'data/a.csv'), 'utf8'), 'mine\n');
});

await test('logLinked writes one info line and nothing for an empty list', (t) => {
    const env = testEnv(tempRoot(t));
    const deps = testDeps(env);
    logLinked(deps, []);
    assert.deepEqual(deps.lines, []);
    logLinked(deps, ['config', 'bad\nname']);
    assert.deepEqual(messages(deps.lines, 'info'), ['linked config, bad?name']);
});
