import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { anchoredPattern, EXCLUDE_HEADER, TEMP_PATTERN } from '../../src/worktree-add/exclude.ts';
import { classify, syncIgnored } from '../../src/worktree-add/sync.ts';
import type { CloneOutcome, Deps, EntryTransfer } from '../../src/worktree-add/types.ts';

import { testDeps } from './support/deps.ts';
import { commitFile, gitSync, makeRepo, testEnv } from './support/git.ts';
import { withOverride } from './support/runners.ts';
import { tempRoot } from './support/tmp.ts';

const LOG_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z (.*)$/u;
const IGNORE_RULES = [
    '.env',
    '.env.*',
    'CLAUDE.local.md',
    'temp.local',
    'node_modules/',
    'docs.local/',
    '.claude/',
    '.venv/',
    'config/',
    'dist/',
    '*.tsbuildinfo',
    '*.odd',
    'bad*',
    '',
].join('\n');
const IGNORED_FILES = [
    '.env',
    'apps/web/.env.local',
    'CLAUDE.local.md',
    'temp.local/notes.txt',
    'node_modules/pkg/index.js',
    'docs.local/a.md',
    '.claude/settings.json',
    '.venv/bin/python',
    'config/.env',
    'dist/out.js',
    'x.tsbuildinfo',
];
const COPY_RELS = ['.env', 'CLAUDE.local.md', 'apps/web/.env.local', 'temp.local'];
const LINK_RELS = ['.claude', '.venv', 'config', 'docs.local'];

interface Fixture {
    main: string;
    worktree: string;
    deps: Deps & { lines: string[] };
    exclude: string;
    baseline: string;
}

interface FakeTransfer extends EntryTransfer {
    copies: string[];
    clones: string[];
}

interface FakeOptions {
    clone?: (_rel: string) => CloneOutcome;
    onCopy?: (_rel: string) => void;
}

function writeFile(file: string, text: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}

function makeFixture(t: TestContext): Fixture {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    commitFile(env, main, '.gitignore', IGNORE_RULES);
    commitFile(env, main, 'apps/web/index.js', 'web\n');
    for (const rel of IGNORED_FILES) {
        writeFile(path.join(main, rel), `${rel}\n`);
    }
    const worktree = path.join(root, 'app-task');
    gitSync(env, ['-C', main, 'worktree', 'add', '--quiet', '-b', 'task', worktree]);
    const exclude = path.join(main, '.git', 'info', 'exclude');
    return { main, worktree, deps: testDeps(env), exclude, baseline: fs.readFileSync(exclude, 'utf8') };
}

function fakeTransfer(options: FakeOptions = {}): FakeTransfer {
    const copies: string[] = [];
    const clones: string[] = [];
    return {
        copies,
        clones,
        copyEntry: (rel) => {
            copies.push(rel);
            options.onCopy?.(rel);
            return Promise.resolve('copied');
        },
        cloneDependency: (rel) => {
            clones.push(rel);
            return Promise.resolve(options.clone?.(rel) ?? { kind: 'cloned' });
        },
    };
}

function messages(lines: readonly string[]): string[] {
    return lines.map((line) => LOG_LINE.exec(line)?.[1] ?? `unformatted: ${line}`);
}

function linkText(file: string): string | undefined {
    try {
        return fs.readlinkSync(file);
    } catch {
        return;
    }
}

function appended(fixture: Fixture): string {
    const text = fs.readFileSync(fixture.exclude, 'utf8');
    assert.equal(text.startsWith(fixture.baseline), true);
    return text.slice(fixture.baseline.length);
}

function excludeLines(fixture: Fixture): string[] {
    return fs.readFileSync(fixture.exclude, 'utf8').split('\n');
}

await test('classify follows the class table by the last path component', () => {
    const table: [string, string][] = [
        ['.env', 'copy'],
        ['.env.local', 'copy'],
        ['apps/web/.env.production', 'copy'],
        ['CLAUDE.local.md', 'copy'],
        ['temp.local', 'copy'],
        ['node_modules', 'dep'],
        ['packages/a/node_modules', 'dep'],
        ['.cache', 'skip'],
        ['.eslintcache', 'skip'],
        ['.next', 'skip'],
        ['.turbo', 'skip'],
        ['build', 'skip'],
        ['coverage', 'skip'],
        ['dist', 'skip'],
        ['out', 'skip'],
        ['tsconfig.tsbuildinfo', 'skip'],
        ['docs.local', 'link'],
        ['.claude', 'link'],
        ['.venv', 'link'],
        ['venv', 'link'],
        ['AGENTS.local.md', 'link'],
        ['config', 'link'],
        ['.envrc', 'link'],
    ];
    for (const [rel, expected] of table) {
        assert.equal(classify(rel), expected, rel);
    }
});

await test('copies, clones, links and skips each ignored entry by its class', async (t) => {
    const fixture = makeFixture(t);
    const { main, worktree, deps } = fixture;
    const transfer = fakeTransfer();
    await syncIgnored(deps, main, worktree, transfer);
    assert.deepEqual(transfer.copies.toSorted(), COPY_RELS.toSorted());
    assert.deepEqual(transfer.clones, ['node_modules']);
    for (const rel of LINK_RELS) {
        assert.equal(linkText(path.join(worktree, rel)), path.join(main, rel), rel);
    }
    for (const rel of [...COPY_RELS, 'node_modules', 'dist', 'x.tsbuildinfo']) {
        assert.equal(fs.existsSync(path.join(worktree, rel)), false, rel);
    }
    assert.equal(appended(fixture), `${EXCLUDE_HEADER}\n${TEMP_PATTERN}\n/.claude\n/.venv\n/config\n/docs.local\n`);
    assert.deepEqual(messages(deps.lines), ['info linked .claude, .venv, config, docs.local']);
});

await test('an unavailable clone gate links the dependency and says so', async (t) => {
    const fixture = makeFixture(t);
    const { main, worktree, deps } = fixture;
    const transfer = fakeTransfer({ clone: () => ({ kind: 'unavailable', reason: 'different filesystems' }) });
    await syncIgnored(deps, main, worktree, transfer);
    assert.equal(linkText(path.join(worktree, 'node_modules')), path.join(main, 'node_modules'));
    assert.deepEqual(messages(deps.lines), [
        'info linked .claude, .venv, config, docs.local',
        'info linked node_modules: no copy-on-write between the clone and the worktree',
    ]);
    assert.equal(excludeLines(fixture).includes('/node_modules'), true);
});

await test('a failed clone links the dependency and warns', async (t) => {
    const fixture = makeFixture(t);
    const { main, worktree, deps } = fixture;
    const transfer = fakeTransfer({ clone: () => ({ kind: 'failed', reason: 'disk full' }) });
    await syncIgnored(deps, main, worktree, transfer);
    assert.equal(linkText(path.join(worktree, 'node_modules')), path.join(main, 'node_modules'));
    assert.deepEqual(messages(deps.lines), [
        'warn cannot clone node_modules into the worktree (disk full); linked it instead',
        'info linked .claude, .venv, config, docs.local',
    ]);
    assert.equal(excludeLines(fixture).includes('/node_modules'), true);
});

await test('a cloned dependency folder gets its pattern and a second run changes nothing', async (t) => {
    const fixture = makeFixture(t);
    const { main, worktree, deps } = fixture;
    const options: FakeOptions = {
        clone: (rel) => {
            fs.mkdirSync(path.join(worktree, rel));
            return { kind: 'cloned' };
        },
        onCopy: (rel) => {
            fs.cpSync(path.join(main, rel), path.join(worktree, rel), { recursive: true });
        },
    };
    await syncIgnored(deps, main, worktree, fakeTransfer(options));
    assert.equal(excludeLines(fixture).includes('/node_modules'), true);
    const excludeAfterFirst = fs.readFileSync(fixture.exclude, 'utf8');
    deps.lines.length = 0;
    const second = fakeTransfer(options);
    await syncIgnored(deps, main, worktree, second);
    assert.deepEqual(second.copies, []);
    assert.deepEqual(second.clones, []);
    assert.deepEqual(deps.lines, []);
    assert.equal(fs.readFileSync(fixture.exclude, 'utf8'), excludeAfterFirst);
});

await test('an own link at a copy entry is routed to the copy', async (t) => {
    const fixture = makeFixture(t);
    const { main, worktree, deps } = fixture;
    fs.symlinkSync(path.join(main, '.env'), path.join(worktree, '.env'));
    const transfer = fakeTransfer();
    await syncIgnored(deps, main, worktree, transfer);
    assert.equal(transfer.copies.includes('.env'), true);
});

await test('a foreign link and an edited copy are left alone', async (t) => {
    const fixture = makeFixture(t);
    const { main, worktree, deps } = fixture;
    fs.symlinkSync(path.join(worktree, 'elsewhere'), path.join(worktree, '.env'));
    writeFile(path.join(worktree, 'apps/web/.env.local'), 'edited\n');
    const transfer = fakeTransfer();
    await syncIgnored(deps, main, worktree, transfer);
    assert.deepEqual(transfer.copies.toSorted(), ['CLAUDE.local.md', 'temp.local']);
    assert.equal(linkText(path.join(worktree, '.env')), path.join(worktree, 'elsewhere'));
    assert.equal(fs.readFileSync(path.join(worktree, 'apps/web/.env.local'), 'utf8'), 'edited\n');
});

await test('a destination parent that links into the main clone is skipped', async (t) => {
    const fixture = makeFixture(t);
    const { main, worktree, deps } = fixture;
    fs.rmSync(path.join(worktree, 'apps', 'web'), { recursive: true });
    fs.symlinkSync(path.join(main, 'apps', 'web'), path.join(worktree, 'apps', 'web'));
    const transfer = fakeTransfer();
    await syncIgnored(deps, main, worktree, transfer);
    assert.equal(transfer.copies.includes('apps/web/.env.local'), false);
    assert.deepEqual(fs.readdirSync(path.join(main, 'apps', 'web')).toSorted(), ['.env.local', 'index.js']);
});

await test('odd names are linked byte for byte', async (t) => {
    const fixture = makeFixture(t);
    const { main, worktree, deps } = fixture;
    const names = [
        '\u041F\u0440\u0438\u0432\u0435\u0442.odd',
        'my notes.odd',
        ' leading.odd',
        'say "hi" \'there\'.odd',
        String.raw`back\slash.odd`,
    ];
    for (const name of names) {
        writeFile(path.join(main, name), 'odd\n');
    }
    await syncIgnored(deps, main, worktree, fakeTransfer());
    const lines = excludeLines(fixture);
    for (const name of names) {
        assert.equal(linkText(path.join(worktree, name)), path.join(main, name), name);
        assert.equal(lines.includes(anchoredPattern(name)), true, name);
    }
});

await test('names with control characters are skipped with a warning', async (t) => {
    const fixture = makeFixture(t);
    const { main, worktree, deps } = fixture;
    writeFile(path.join(main, '.env.tab\there'), 'x\n');
    writeFile(path.join(main, '.env.line\nbreak'), 'x\n');
    const transfer = fakeTransfer();
    await syncIgnored(deps, main, worktree, transfer);
    const shown = messages(deps.lines);
    assert.equal(
        shown.includes('warn skipped an ignored path with a control character in its name: .env.tab?here'),
        true
    );
    assert.equal(
        shown.includes('warn skipped an ignored path with a control character in its name: .env.line?break'),
        true
    );
    assert.equal(
        transfer.copies.some((rel) => rel.includes('tab') || rel.includes('line')),
        false
    );
    const text = fs.readFileSync(fixture.exclude, 'utf8');
    for (const part of ['tab', 'here', 'line', 'break']) {
        assert.equal(text.includes(part), false, part);
    }
});

await test(
    'a name that is not valid UTF-8 is skipped with a warning',
    { skip: process.platform === 'darwin' ? 'APFS refuses names that are not valid UTF-8' : false },
    async (t) => {
        const fixture = makeFixture(t);
        const { main, worktree, deps } = fixture;
        const badName = Buffer.from([0x62, 0x61, 0x64, 0xff]);
        fs.writeFileSync(Buffer.concat([Buffer.from(`${main}/`), badName]), 'x\n');
        await syncIgnored(deps, main, worktree, fakeTransfer());
        assert.equal(
            messages(deps.lines).includes('warn skipped an ignored path whose name is not valid UTF-8: bad\uFFFD'),
            true
        );
        const entries = fs.readdirSync(worktree, { encoding: 'buffer' });
        assert.equal(
            entries.some((entry) => entry.equals(badName)),
            false
        );
        assert.equal(fs.readFileSync(fixture.exclude, 'utf8').includes('bad'), false);
    }
);

await test('a failing listing warns and creates nothing', async (t) => {
    const fixture = makeFixture(t);
    const { main, worktree, deps } = fixture;
    const failing: Deps = {
        ...deps,
        runner: withOverride(deps.runner, (request) => request.args.includes('ls-files'), {
            code: 128,
            stdout: '',
            stderr: 'fatal: broken',
        }),
    };
    const before = fs.readdirSync(worktree).toSorted();
    const transfer = fakeTransfer();
    await syncIgnored(failing, main, worktree, transfer);
    assert.deepEqual(messages(deps.lines), [
        `warn cannot list the ignored files of ${main}; nothing synced into the worktree`,
    ]);
    assert.deepEqual(fs.readdirSync(worktree).toSorted(), before);
    assert.deepEqual(transfer.copies, []);
    assert.deepEqual(transfer.clones, []);
    assert.equal(fs.readFileSync(fixture.exclude, 'utf8'), fixture.baseline);
});
