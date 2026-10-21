import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { parseArgs, usageText } from '../../src/worktree-add/args.ts';
import { deriveTarget } from '../../src/worktree-add/target.ts';
import { gitVersionProblem, nodeVersionProblem } from '../../src/worktree-add/versions.ts';

import { tempRoot } from './support/tmp.ts';

const HOME = '/home/test';
const SUFFIX = 'abc-123-oauth-login';

function usageMessage(argv: readonly string[]): string {
    const parsed = parseArgs(argv, HOME);
    assert.equal(parsed.kind, 'usage', `expected usage for ${JSON.stringify(argv)}`);
    return parsed.kind === 'usage' ? parsed.message : '';
}

function parsedParent(value: string): string | undefined {
    const parsed = parseArgs(['--suffix', 'x', '--parent', value], HOME);
    assert.equal(parsed.kind, 'ok');
    return parsed.kind === 'ok' ? parsed.parent : undefined;
}

await test('parseArgs accepts the suffix alone and options in any order', () => {
    assert.deepEqual(parseArgs(['--suffix', SUFFIX], HOME), {
        kind: 'ok',
        suffix: SUFFIX,
        parent: undefined,
        install: true,
        links: [],
    });
    assert.deepEqual(parseArgs(['--parent', '../wt', '--suffix', 'x'], HOME), {
        kind: 'ok',
        suffix: 'x',
        parent: '../wt',
        install: true,
        links: [],
    });
});

await test('parseArgs reads --no-install at any position', () => {
    assert.deepEqual(parseArgs(['--no-install', '--suffix', 'a'], HOME), {
        kind: 'ok',
        suffix: 'a',
        parent: undefined,
        install: false,
        links: [],
    });
    assert.deepEqual(parseArgs(['--suffix', 'a', '--no-install'], HOME), {
        kind: 'ok',
        suffix: 'a',
        parent: undefined,
        install: false,
        links: [],
    });
    assert.deepEqual(parseArgs(['--suffix', 'a'], HOME), {
        kind: 'ok',
        suffix: 'a',
        parent: undefined,
        install: true,
        links: [],
    });
});

await test('parseArgs keeps the --parent value next to --no-install', () => {
    assert.deepEqual(parseArgs(['--suffix', 'a', '--no-install', '--parent', '../wt'], HOME), {
        kind: 'ok',
        suffix: 'a',
        parent: '../wt',
        install: false,
        links: [],
    });
    assert.deepEqual(parseArgs(['--parent', '~/wt', '--no-install', '--suffix', 'a'], HOME), {
        kind: 'ok',
        suffix: 'a',
        parent: `${HOME}/wt`,
        install: false,
        links: [],
    });
});

await test('parseArgs refuses a repeated --no-install', () => {
    assert.equal(
        usageMessage(['--no-install', '--suffix', 'a', '--no-install']),
        '--no-install can be given only once'
    );
});

await test('parseArgs expands only a leading ~ and ~/', () => {
    assert.equal(parsedParent('~'), HOME);
    assert.equal(parsedParent('~/worktrees'), `${HOME}/worktrees`);
    assert.equal(parsedParent('~/'), HOME);
    assert.equal(parsedParent('~/a/../b'), `${HOME}/a/../b`);
    assert.equal(parsedParent('a/~b'), 'a/~b');
});

await test('parseArgs accepts suffixes within the rule', () => {
    for (const suffix of ['a', '1.2_x-y', 'a'.repeat(100)]) {
        assert.deepEqual(parseArgs(['--suffix', suffix], HOME), {
            kind: 'ok',
            suffix,
            parent: undefined,
            install: true,
            links: [],
        });
    }
});

await test('parseArgs gives help when --help appears among other options', () => {
    assert.deepEqual(parseArgs(['--suffix', 'x', '--help', '--parent', 'p'], HOME), { kind: 'help' });
    assert.deepEqual(parseArgs(['--branch', '--help'], HOME), { kind: 'help' });
});

await test('parseArgs refuses missing, unknown, repeated and valueless options', () => {
    assert.match(usageMessage([]), /--suffix/u);
    assert.match(usageMessage(['--parent', 'p']), /--suffix/u);
    assert.match(usageMessage(['--suffix', 'x', '--branch', 'b']), /unknown option: --branch/u);
    assert.match(usageMessage(['--suffix', 'x', '--suffix', 'y']), /--suffix can be given only once/u);
    assert.match(usageMessage(['--suffix']), /missing value for --suffix/u);
    assert.match(
        usageMessage(['--suffix', 'x', '--parent', '--no-install']),
        /missing value for --parent: got the option --no-install/u
    );
    assert.match(
        usageMessage(['--suffix', '--parent', '/tmp']),
        /missing value for --suffix: got the option --parent/u
    );
    assert.match(usageMessage(['--suffix', 'x', 'extra']), /unexpected argument: extra/u);
});

await test('parseArgs refuses suffixes outside the rule', () => {
    const bad = ['Rep-1', '-x', '.x', '_x', 'a..b', 'x.lock', 'x.', 'a/b', 'a b', 'a\tb', '', 'a'.repeat(101)];
    for (const suffix of bad) {
        assert.match(usageMessage(['--suffix', suffix]), /suffix/u);
    }
});

await test('parseArgs refuses ~user, an empty parent and a parent with a control character', () => {
    assert.equal(usageMessage(['--suffix', 'x', '--parent', '~user/x']), 'only ~ and ~/ are expanded: ~user/x');
    assert.equal(usageMessage(['--suffix', 'x', '--parent', '~x/y']), 'only ~ and ~/ are expanded: ~x/y');
    assert.match(usageMessage(['--suffix', 'x', '--parent', '']), /--parent/u);
    const tabbed = usageMessage(['--suffix', 'x', '--parent', 'a\tb']);
    assert.match(tabbed, /control character/u);
    assert.ok(tabbed.includes('a?b'));
});

await test('parseArgs collects repeated --link values and strips trailing slashes', () => {
    assert.deepEqual(parseArgs(['--suffix', 't', '--link', 'data', '--link', 'backend/db.sqlite3/'], HOME), {
        kind: 'ok',
        suffix: 't',
        parent: undefined,
        install: true,
        links: ['data', 'backend/db.sqlite3'],
    });
    assert.deepEqual(parseArgs(['--suffix', 't', '--link', 'cache///'], HOME), {
        kind: 'ok',
        suffix: 't',
        parent: undefined,
        install: true,
        links: ['cache'],
    });
});

await test('parseArgs accepts --link without --suffix', () => {
    assert.deepEqual(parseArgs(['--link', '.idea'], HOME), {
        kind: 'ok',
        suffix: undefined,
        parent: undefined,
        install: true,
        links: ['.idea'],
    });
});

await test('parseArgs keeps the first position of a repeated --link value', () => {
    assert.deepEqual(parseArgs(['--link', 'a', '--link', 'b', '--link', 'a/'], HOME), {
        kind: 'ok',
        suffix: undefined,
        parent: undefined,
        install: true,
        links: ['a', 'b'],
    });
});

await test('parseArgs keeps --link next to --no-install and --parent in any order', () => {
    const expected = { kind: 'ok', suffix: 'a', parent: '../wt', install: false, links: ['x', 'y'] };
    assert.deepEqual(
        parseArgs(['--link', 'x', '--no-install', '--suffix', 'a', '--parent', '../wt', '--link', 'y'], HOME),
        expected
    );
    assert.deepEqual(
        parseArgs(['--parent', '../wt', '--link', 'x', '--suffix', 'a', '--link', 'y', '--no-install'], HOME),
        expected
    );
});

await test('parseArgs still validates --suffix when --link is given', () => {
    assert.match(usageMessage(['--link', 'a', '--suffix', 'Bad']), /the suffix must start with/u);
});

await test('parseArgs refuses bad --link values with the pinned messages', () => {
    const relative = (value: string): string =>
        `--link takes a path relative to the repository root, without "..": ${value}`;
    assert.equal(usageMessage(['--link', '']), 'the --link value must not be empty');
    assert.equal(usageMessage(['--link', '/etc/passwd']), relative('/etc/passwd'));
    assert.equal(usageMessage(['--link', '../x']), relative('../x'));
    assert.equal(usageMessage(['--link', 'a/../b']), relative('a/../b'));
    assert.equal(usageMessage(['--link', '.']), relative('.'));
    assert.equal(usageMessage(['--link', './']), relative('./'));
    assert.equal(usageMessage(['--link', './.idea']), relative('./.idea'));
    assert.equal(usageMessage(['--link', 'a/./b']), relative('a/./b'));
    assert.equal(usageMessage(['--link', 'a//b']), relative('a//b'));
    assert.equal(usageMessage(['--link', 'a/.']), relative('a/.'));
    assert.equal(usageMessage(['--link', 'a\u0001']), 'the --link value contains a control character: a?');
    assert.equal(usageMessage(['--link', '--no-install']), 'missing value for --link: got the option --no-install');
    assert.equal(usageMessage(['--link']), 'missing value for --link');
});

await test('parseArgs still requires --suffix without --link', () => {
    assert.equal(usageMessage([]), '--suffix SUFFIX is required');
    assert.equal(usageMessage(['--no-install']), '--suffix SUFFIX is required');
});

await test('usageText names the options, the ~ expansion and the exit codes', () => {
    const text = usageText();
    for (const part of ['--suffix SUFFIX', '--parent DIR', '--help', '~/', '0', '1', '2']) {
        assert.ok(text.includes(part), `usage text lacks ${part}`);
    }
    assert.match(text, /exit codes/iu);
});

await test('usageText names the --no-install flag and what it does', () => {
    const text = usageText();
    assert.ok(
        text.startsWith('Usage: worktree-add.mjs --suffix SUFFIX [--parent DIR] [--no-install] [--link PATH]...\n'),
        text
    );
    assert.match(
        text,
        /^ {2}--no-install +skip the dependency installs; dependency folders are cloned or linked instead$/mu
    );
});

await test('usageText names the --link flag and its in-worktree mode', () => {
    const text = usageText();
    assert.match(
        text,
        /^ {2}--link PATH {6}link PATH \(relative to the repository root, repeatable\) from the main clone into the worktree;$/mu
    );
    assert.match(text, /^ {19}inside a linked worktree it links only these paths and needs no --suffix$/mu);
});

await test('nodeVersionProblem accepts 22 and newer', () => {
    assert.equal(nodeVersionProblem('22.0.0'), undefined);
    assert.equal(nodeVersionProblem('24.15.0'), undefined);
});

await test('nodeVersionProblem refuses older or unparseable versions', () => {
    assert.equal(nodeVersionProblem('20.11.1'), 'Node 22 or newer is required, found 20.11.1');
    assert.equal(nodeVersionProblem('banana'), 'Node 22 or newer is required, found banana');
});

await test('gitVersionProblem accepts 2.29 and newer in every known spelling', () => {
    for (const output of [
        'git version 2.29.0',
        'git version 2.30',
        'git version 2.39.3 (Apple Git-146)',
        'git version 2.45.1.windows.1\n',
        'git version 3.0.0',
    ]) {
        assert.equal(gitVersionProblem(output), undefined, output);
    }
});

await test('gitVersionProblem refuses older or unparseable output', () => {
    assert.equal(gitVersionProblem('git version 2.28.0'), 'git 2.29 or newer is required, found 2.28.0');
    assert.equal(gitVersionProblem('git version 1.9.5'), 'git 2.29 or newer is required, found 1.9.5');
    assert.ok(gitVersionProblem('something else')?.startsWith('git 2.29 or newer is required, found '));
});

await test('deriveTarget defaults to a sibling of the main clone', (t) => {
    const root = tempRoot(t);
    const main = path.join(root, 'app');
    fs.mkdirSync(main);
    assert.deepEqual(deriveTarget(SUFFIX, undefined, main, main), {
        ok: true,
        target: {
            suffix: SUFFIX,
            name: `app-${SUFFIX}`,
            branch: SUFFIX,
            parent: root,
            parentMissing: false,
            path: path.join(root, `app-${SUFFIX}`),
        },
    });
});

await test('deriveTarget resolves a relative parent against cwd and creates nothing', (t) => {
    const root = tempRoot(t);
    const main = path.join(root, 'app');
    const sub = path.join(main, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    const result = deriveTarget('x', '../wt', sub, main);
    assert.ok(result.ok);
    assert.equal(result.target.parent, path.join(main, 'wt'));
    assert.equal(result.target.path, path.join(main, 'wt', 'app-x'));
    assert.equal(result.target.parentMissing, true);
    assert.equal(fs.existsSync(path.join(main, 'wt')), false);
});

await test('deriveTarget gives the physical path of a parent reached through a symlink', (t) => {
    const root = tempRoot(t);
    const main = path.join(root, 'app');
    fs.mkdirSync(main);
    fs.mkdirSync(path.join(root, 'real'));
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'));
    const result = deriveTarget('x', 'link', root, main);
    assert.ok(result.ok);
    assert.equal(result.target.parent, path.join(root, 'real'));
    assert.equal(result.target.path, path.join(root, 'real', 'app-x'));
    assert.equal(result.target.parentMissing, false);
});

await test('deriveTarget resolves .. after a symlink physically, as mkdir would', (t) => {
    const root = tempRoot(t);
    const main = path.join(root, 'app');
    fs.mkdirSync(main);
    fs.mkdirSync(path.join(root, 'real', 'deep'), { recursive: true });
    fs.symlinkSync(path.join(root, 'real', 'deep'), path.join(root, 'link'));
    const result = deriveTarget('x', 'link/../wt', root, main);
    assert.ok(result.ok);
    assert.equal(result.target.parent, path.join(root, 'real', 'wt'));
    assert.equal(result.target.path, path.join(root, 'real', 'wt', 'app-x'));
    assert.equal(result.target.parentMissing, true);
    fs.mkdirSync(`${root}/link/../wt`);
    assert.ok(fs.existsSync(path.join(root, 'real', 'wt')));
});

await test('deriveTarget refuses a parent that is a file or a dangling symlink with code 2', (t) => {
    const root = tempRoot(t);
    const main = path.join(root, 'app');
    fs.mkdirSync(main);
    const file = path.join(root, 'file');
    fs.writeFileSync(file, 'x\n');
    const dangling = path.join(root, 'dangling');
    fs.symlinkSync(path.join(root, 'nowhere'), dangling);
    for (const parent of [file, dangling]) {
        const result = deriveTarget('x', parent, root, main);
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 2);
            assert.ok(result.message.includes(parent), result.message);
        }
    }
    assert.equal(fs.existsSync(path.join(root, 'nowhere')), false);
    assert.equal(fs.statSync(file).isFile(), true);
});

await test('deriveTarget refuses a main folder name with a control character with code 1', (t) => {
    const root = tempRoot(t);
    const main = path.join(root, 'a\tb');
    fs.mkdirSync(main);
    const result = deriveTarget('x', undefined, main, main);
    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.equal(result.code, 1);
        assert.ok(result.message.includes('a?b'), result.message);
    }
});
