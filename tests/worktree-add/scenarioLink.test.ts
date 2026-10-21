import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { EXCLUDE_HEADER } from '../../src/worktree-add/exclude.ts';

import { gitSync } from './support/git.ts';
import { linkTextOf, makeScenario, messages, okPath, runScenario, type Scenario } from './support/scenario.ts';

const OUTSIDE_RULES = 'info this worktree has links to the main clone outside the current rules: ';

function excludeFile(s: Scenario): string {
    return path.join(s.main, '.git', 'info', 'exclude');
}

function excludeLines(s: Scenario): string[] {
    return fs.readFileSync(excludeFile(s), 'utf8').split('\n');
}

function writeExclude(s: Scenario, userLines: readonly string[], blockLines: readonly string[]): void {
    fs.writeFileSync(excludeFile(s), `${[...userLines, EXCLUDE_HEADER, ...blockLines].join('\n')}\n`);
}

function writeFile(root: string, rel: string, text = 'x\n'): void {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
}

function isOwnLink(s: Scenario, worktree: string, rel: string): boolean {
    return linkTextOf(path.join(worktree, rel)) === path.join(s.main, rel);
}

// An own link as an earlier version placed it: a symlink in the worktree pointing at the main clone path.
function placeOldLink(s: Scenario, worktree: string, rel: string): void {
    const full = path.join(worktree, rel);
    fs.rmSync(full, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.symlinkSync(path.join(s.main, rel), full);
}

function warnings(s: Scenario): string[] {
    return messages(s).filter((line) => line.startsWith('warn '));
}

function worktreeCount(s: Scenario): number {
    return gitSync(s.env, ['-C', s.main, 'worktree', 'list', '--porcelain'])
        .split('\n')
        .filter((line) => line.startsWith('worktree ')).length;
}

function makeDataScenario(t: TestContext): Scenario {
    return makeScenario(t, { ignore: 'data/\n', ignored: { 'data/a.txt': 'a\n' } });
}

await test('K4: --link inside a worktree links the path, adds its exclude line and creates nothing else', async (t) => {
    const s = makeDataScenario(t);
    const target = okPath(await runScenario(s, ['--suffix', 't', '--no-install']));
    const rootBefore = fs.readdirSync(s.root).toSorted();
    const targetBefore = fs.readdirSync(target).toSorted();
    const countBefore = worktreeCount(s);
    assert.equal(excludeLines(s).includes('/data'), false);
    s.deps.lines.length = 0;
    assert.equal(okPath(await runScenario(s, ['--link', 'data'], target)), target);
    assert.ok(isOwnLink(s, target, 'data'), messages(s).join('\n'));
    assert.ok(excludeLines(s).includes('/data'));
    assert.deepEqual(messages(s), ['info linked data']);
    assert.deepEqual(fs.readdirSync(s.root).toSorted(), rootBefore);
    assert.deepEqual(fs.readdirSync(target).toSorted(), [...targetBefore, 'data'].toSorted());
    assert.equal(worktreeCount(s), countBefore);
});

await test('K4: a run without --link inside a worktree only says it is already there', async (t) => {
    const s = makeDataScenario(t);
    const target = okPath(await runScenario(s, ['--suffix', 't', '--no-install']));
    const targetBefore = fs.readdirSync(target).toSorted();
    const excludeBefore = fs.readFileSync(excludeFile(s), 'utf8');
    s.deps.lines.length = 0;
    assert.equal(okPath(await runScenario(s, ['--suffix', 'other', '--no-install'], target)), target);
    assert.deepEqual(messages(s), [
        `info already in the worktree ${target}: no new worktree is created; run it from the main working tree ${s.main} to create one`,
    ]);
    assert.deepEqual(fs.readdirSync(target).toSorted(), targetBefore);
    assert.equal(linkTextOf(path.join(target, 'data')), undefined);
    assert.equal(fs.readFileSync(excludeFile(s), 'utf8'), excludeBefore);
});

await test('K4: --suffix with --link inside a worktree is ignored and no other worktree is created', async (t) => {
    const s = makeDataScenario(t);
    const target = okPath(await runScenario(s, ['--suffix', 't', '--no-install']));
    const countBefore = worktreeCount(s);
    const rootBefore = fs.readdirSync(s.root).toSorted();
    s.deps.lines.length = 0;
    assert.equal(okPath(await runScenario(s, ['--suffix', 'other', '--link', 'data'], target)), target);
    assert.deepEqual(messages(s), [
        'info --suffix and --parent are ignored inside a linked worktree: only the --link paths are linked',
        'info linked data',
    ]);
    assert.equal(worktreeCount(s), countBefore);
    assert.deepEqual(fs.readdirSync(s.root).toSorted(), rootBefore);
    assert.ok(isOwnLink(s, target, 'data'));
});

await test('every --link branch from the main clone warns once each and the rest still syncs', async (t) => {
    const s = makeScenario(t, {
        ignore: '.env\n.npmrc\n.idea/\nbackend/\ntarget/\nnode_modules/\n',
        tracked: { 'Cargo.toml': '[package]\nname = "app"\n' },
        ignored: {
            '.env': 'A=1\n',
            '.npmrc': 'x=1\n',
            '.idea/ws.xml': '<w/>\n',
            'backend/db.sqlite3': 'db\n',
            'backend/notes.txt': 'n\n',
            'target/debug/app': 'bin\n',
            'node_modules/pkg/index.js': 'js\n',
        },
    });
    const links = ['backend/db.sqlite3', 'target', 'missing', 'README.md', 'node_modules', '.npmrc'];
    const argv = ['--suffix', 't', '--no-install', ...links.flatMap((rel) => ['--link', rel])];
    const target = okPath(await runScenario(s, argv));
    const all = messages(s).join('\n');
    assert.deepEqual(
        warnings(s).toSorted(),
        [
            'warn linked target with --link: build outputs are now shared with the main clone',
            'warn not linked with --link: missing does not exist in the main clone',
            'warn not linked with --link: README.md is not ignored in the main clone',
            'warn not linked with --link: node_modules is a dependency folder; the install stage handles it',
            'warn not linked with --link: .npmrc is copied per worktree, never linked',
        ].toSorted(),
        all
    );
    assert.ok(isOwnLink(s, target, 'backend/db.sqlite3'), all);
    const backend = fs.lstatSync(path.join(target, 'backend'));
    assert.ok(backend.isDirectory() && !backend.isSymbolicLink(), all);
    assert.ok(isOwnLink(s, target, 'target'), all);
    assert.equal(fs.existsSync(path.join(target, 'missing')), false, all);
    assert.equal(linkTextOf(path.join(target, 'README.md')), undefined, all);
    for (const copied of ['.env', '.npmrc']) {
        const stat = fs.lstatSync(path.join(target, copied));
        assert.ok(stat.isFile() && !stat.isSymbolicLink(), `${copied}\n${all}`);
    }
    assert.ok(isOwnLink(s, target, '.idea'), all);
    const lines = excludeLines(s);
    for (const pattern of ['/backend/db.sqlite3', '/target', '/.idea']) {
        assert.ok(lines.includes(pattern), `${pattern}\n${lines.join('\n')}`);
    }
    for (const pattern of ['/missing', '/README.md', '/.npmrc']) {
        assert.equal(lines.includes(pattern), false, pattern);
    }
    // --no-install without copy-on-write links node_modules in the install stage, never through --link.
    assert.ok(messages(s).includes('info linked backend/db.sqlite3, target, .idea'), all);
    assert.ok(messages(s).includes('info installs skipped (--no-install): linked node_modules'), all);
    const notLinked = messages(s).find((line) => line.startsWith('info not linked: ')) ?? '';
    assert.match(notLinked, /backend\/notes\.txt \(/u, all);
});

await test('malformed --link values are usage errors', async (t) => {
    const s = makeDataScenario(t);
    const before = fs.readdirSync(s.root).toSorted();
    for (const value of ['../x', '/abs']) {
        const outcome = await runScenario(s, ['--suffix', 't', '--link', value]);
        assert.equal(outcome.kind, 'usage', `${value}: ${JSON.stringify(outcome)}`);
    }
    assert.deepEqual(fs.readdirSync(s.root).toSorted(), before);
});

// A main clone whose tool block still holds lines from older versions; src/oldpkg/__init__.py was restored since.
function makeLegacyScenario(t: TestContext): Scenario {
    const s = makeScenario(t, {
        ignore: '__pycache__/\nbackend/\n',
        tracked: { 'src/app/main.py': 'print(1)\n' },
        ignored: { 'src/app/__pycache__/main.pyc': 'c\n', 'backend/db.sqlite3': 'db\n' },
    });
    writeFile(s.main, 'src/oldpkg/__init__.py');
    writeExclude(s, [], ['/src/oldpkg', '/src/app/__pycache__', '/backend/db.sqlite3']);
    return s;
}

function hidingWarnings(s: Scenario, line: string): string[] {
    return warnings(s).filter((warning) => warning.includes(`line ${line} hides`));
}

await test('K5: a block line hiding a restored file warns once and the other block lines stay silent', async (t) => {
    const s = makeLegacyScenario(t);
    okPath(await runScenario(s, ['--suffix', 't', '--no-install']));
    const all = messages(s).join('\n');
    // The check lists with --directory, so a wholly untracked folder is named as the folder.
    assert.deepEqual(
        hidingWarnings(s, '/src/oldpkg'),
        [
            'warn .git/info/exclude line /src/oldpkg hides 1 file that .gitignore does not ignore (src/oldpkg); ' +
                'git status and git add skip it. Remove the worktree-add links at src/oldpkg in every worktree first, then this line',
        ],
        all
    );
    assert.deepEqual(hidingWarnings(s, '/src/app/__pycache__'), [], all);
    assert.deepEqual(hidingWarnings(s, '/backend/db.sqlite3'), [], all);
    assert.equal(
        messages(s).some((line) => line.startsWith(OUTSIDE_RULES)),
        false,
        all
    );
});

await test('K5: a reused worktree with an own link at the hidden folder is named once and keeps it', async (t) => {
    const s = makeLegacyScenario(t);
    const target = okPath(await runScenario(s, ['--suffix', 't', '--no-install']));
    placeOldLink(s, target, 'src/oldpkg');
    s.deps.lines.length = 0;
    assert.equal(okPath(await runScenario(s, ['--suffix', 't', '--no-install'])), target);
    const all = messages(s).join('\n');
    assert.deepEqual(
        messages(s).filter((line) => line.startsWith(OUTSIDE_RULES)),
        [`${OUTSIDE_RULES}src/oldpkg`],
        all
    );
    assert.equal(hidingWarnings(s, '/src/oldpkg').length, 1, all);
    assert.ok(isOwnLink(s, target, 'src/oldpkg'), all);
});

await test('P2: a block line the user also wrote above the header gets no legacy warning', async (t) => {
    const s = makeScenario(t, { ignore: '.env\n', ignored: { '.env': 'A=1\n' } });
    writeFile(s.main, 'vendor-local/a.txt');
    writeExclude(s, ['/vendor-local'], ['/vendor-local']);
    okPath(await runScenario(s, ['--suffix', 't', '--no-install']));
    const all = messages(s).join('\n');
    assert.deepEqual(hidingWarnings(s, '/vendor-local'), [], all);
    assert.equal(
        warnings(s).some((line) => line.includes('vendor-local')),
        false,
        all
    );
});

await test('P3: an old own link at data is kept out of the not linked line and named as outside the rules', async (t) => {
    const s = makeDataScenario(t);
    const target = okPath(await runScenario(s, ['--suffix', 't', '--no-install']));
    assert.ok(
        messages(s).some((line) => line.startsWith('info not linked: data ')),
        messages(s).join('\n')
    );
    placeOldLink(s, target, 'data');
    fs.appendFileSync(excludeFile(s), `${EXCLUDE_HEADER}\n/data\n`);
    s.deps.lines.length = 0;
    assert.equal(okPath(await runScenario(s, ['--suffix', 't', '--no-install'])), target);
    const all = messages(s).join('\n');
    assert.equal(
        messages(s).some((line) => line.startsWith('info not linked:') && line.includes('data')),
        false,
        all
    );
    assert.deepEqual(
        messages(s).filter((line) => line.startsWith(OUTSIDE_RULES)),
        [`${OUTSIDE_RULES}data`],
        all
    );
    assert.ok(isOwnLink(s, target, 'data'), all);
});
