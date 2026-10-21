import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { anchoredPattern, EXCLUDE_HEADER, TEMP_PATTERN } from '../../src/worktree-add/exclude.ts';
import { syncIgnored } from '../../src/worktree-add/sync.ts';
import type { Deps, EntryTransfer, Env } from '../../src/worktree-add/types.ts';

import { testDeps } from './support/deps.ts';
import { commitFile, gitSync, makeRepo, testEnv } from './support/git.ts';
import { withOverride } from './support/runners.ts';
import { tempRoot } from './support/tmp.ts';

const LOG_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z (.*)$/u;
const NOT_LINKED_PREFIX = 'info not linked: ';
const NOT_LINKED_LINE =
    /^info not linked: (.*); to share one with the main clone, run worktree-add --link PATH inside the worktree$/u;
const REPORT_ENTRY = /^(.*) \(([^)]*)\)$/u;
const ROOT_SKIP = process.getuid?.() === 0 ? 'root ignores directory modes' : false;
const IGNORE_RULES = [
    '.env',
    '.env.*',
    '.npmrc',
    '.python-version',
    '.idea/workspace.xml',
    'node_modules/',
    '.venv/',
    'docs.local/',
    'AGENTS.md',
    'config.local.yaml',
    'dist/',
    '__pycache__/',
    '*.egg-info/',
    'secrets/',
    '*.odd',
    'bad*',
    '',
].join('\n');
const TRACKED_FILES = ['apps/web/index.js', '.idea/misc.xml', 'packages/a/package.json', 'app/m.py'];
const IGNORED_FILES = [
    '.env',
    '.npmrc',
    'packages/a/.python-version',
    '.idea/workspace.xml',
    'node_modules/pkg/index.js',
    '.venv/bin/python',
    '.venv/pyvenv.cfg',
    'docs.local/a.md',
    'AGENTS.md',
    'config.local.yaml',
    'dist/out.js',
    'app/__pycache__/m.cpython-312.pyc',
    'x.egg-info/PKG-INFO',
    'apps/api/secrets/.env',
];
const COPY_RELS = ['.env', '.npmrc', 'apps/api/secrets/.env', 'packages/a/.python-version'];
const LINK_RELS = ['.idea/workspace.xml', 'AGENTS.md', 'config.local.yaml', 'docs.local'];
const DEP_RELS = ['.venv', 'node_modules'];
const NOTHING_RELS = ['dist', 'app/__pycache__', 'x.egg-info'];

interface Fixture {
    env: Env;
    main: string;
    worktree: string;
    deps: Deps & { lines: string[] };
    exclude: string;
    baseline: string;
}

interface FixtureExtra {
    rules?: string;
    files?: readonly string[];
    tracked?: readonly string[];
    omitTracked?: readonly string[];
}

interface FakeTransfer extends EntryTransfer {
    copies: string[];
    clones: string[];
}

interface FakeOptions {
    onCopy?: (_rel: string) => void;
}

function writeFile(file: string, text: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}

// The base repository plus extra ignore rules and ignored files written before the worktree is added.
function makeFixture(t: TestContext, extra: FixtureExtra = {}): Fixture {
    const root = tempRoot(t);
    const env = testEnv(root);
    const { main } = makeRepo(root, env);
    commitFile(env, main, '.gitignore', `${IGNORE_RULES}${extra.rules ?? ''}`);
    const omitted = new Set(extra.omitTracked);
    for (const rel of [...TRACKED_FILES, ...(extra.tracked ?? [])].filter((tracked) => !omitted.has(tracked))) {
        commitFile(env, main, rel, `${rel}\n`);
    }
    for (const rel of [...IGNORED_FILES, ...(extra.files ?? [])]) {
        writeFile(path.join(main, rel), `${rel}\n`);
    }
    const worktree = path.join(root, 'app-task');
    gitSync(env, ['-C', main, 'worktree', 'add', '--quiet', '-b', 'task', worktree]);
    const exclude = path.join(main, '.git', 'info', 'exclude');
    return { env, main, worktree, deps: testDeps(env), exclude, baseline: fs.readFileSync(exclude, 'utf8') };
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
            return Promise.resolve({ kind: 'cloned' });
        },
    };
}

function messages(lines: readonly string[]): string[] {
    return lines.map((line) => LOG_LINE.exec(line)?.[1] ?? `unformatted: ${line}`);
}

// The paths of the single not linked line mapped to their size texts; an empty map when no such line was logged.
function reported(lines: readonly string[]): Map<string, string> {
    const found = messages(lines).filter((line) => line.startsWith(NOT_LINKED_PREFIX));
    assert.ok(found.length <= 1, found.join('\n'));
    const result = new Map<string, string>();
    const [line] = found;
    if (line === undefined) {
        return result;
    }
    const body = NOT_LINKED_LINE.exec(line)?.[1];
    assert.ok(body !== undefined, line);
    for (const part of body.split(', ')) {
        const match = REPORT_ENTRY.exec(part);
        assert.ok(match?.[1] !== undefined && match[2] !== undefined, part);
        result.set(match[1], match[2]);
    }
    return result;
}

function linkText(file: string): string | undefined {
    try {
        return fs.readlinkSync(file);
    } catch {
        return;
    }
}

function lstatIsLink(file: string): boolean {
    return fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() === true;
}

function absent(file: string): boolean {
    return fs.lstatSync(file, { throwIfNoEntry: false }) === undefined;
}

function isRealFolder(file: string): boolean {
    return fs.lstatSync(file, { throwIfNoEntry: false })?.isDirectory() === true;
}

function appended(fixture: Fixture): string {
    const text = fs.readFileSync(fixture.exclude, 'utf8');
    assert.equal(text.startsWith(fixture.baseline), true);
    return text.slice(fixture.baseline.length);
}

function excludeLines(fixture: Fixture): string[] {
    return fs.readFileSync(fixture.exclude, 'utf8').split('\n');
}

function listedIgnored(fixture: Fixture): string[] {
    const listed = gitSync(fixture.env, [
        '-C',
        fixture.main,
        'ls-files',
        '-z',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--directory',
    ]);
    return listed.split('\0').filter((entry) => entry.length > 0);
}

function copyIntoWorktree(fixture: Fixture): FakeOptions {
    return {
        onCopy: (rel) => {
            fs.cpSync(path.join(fixture.main, rel), path.join(fixture.worktree, rel), { recursive: true });
        },
    };
}

await test('copies, links and skips each ignored entry by the rules and returns the dependency folders', async (t) => {
    const fixture = makeFixture(t);
    const { main, worktree, deps } = fixture;
    const transfer = fakeTransfer();
    const depRels = await syncIgnored(deps, main, worktree, transfer);
    assert.ok(depRels, 'the ignored files of the main clone could not be listed');
    assert.deepEqual(depRels.toSorted(), DEP_RELS);
    assert.deepEqual(transfer.copies.toSorted(), COPY_RELS.toSorted());
    assert.deepEqual(transfer.clones, []);
    for (const rel of LINK_RELS) {
        assert.equal(linkText(path.join(worktree, rel)), path.join(main, rel), rel);
    }
    for (const rel of [...COPY_RELS, ...DEP_RELS, ...NOTHING_RELS]) {
        assert.equal(absent(path.join(worktree, rel)), true, rel);
    }
    assert.equal(isRealFolder(path.join(worktree, 'apps', 'api')), true);
    assert.equal(isRealFolder(path.join(worktree, 'apps', 'api', 'secrets')), true);
    assert.equal(
        appended(fixture),
        `${EXCLUDE_HEADER}\n${TEMP_PATTERN}\n/.idea/workspace.xml\n/AGENTS.md\n/config.local.yaml\n/docs.local\n`
    );
    assert.deepEqual(messages(deps.lines), [
        'info linked .idea/workspace.xml, AGENTS.md, config.local.yaml, docs.local',
    ]);
});

await test('dependency folders alone add no temp pattern, since the sync places no copy', async (t) => {
    const fixture = makeFixture(t);
    const { main, worktree, deps } = fixture;
    const others = [
        '.env',
        '.npmrc',
        'packages/a/.python-version',
        '.idea/workspace.xml',
        '.venv',
        'docs.local',
        'AGENTS.md',
        'config.local.yaml',
        'apps/api',
        ...NOTHING_RELS,
    ];
    for (const rel of others) {
        fs.rmSync(path.join(main, rel), { recursive: true, force: true });
    }
    const depRels = await syncIgnored(deps, main, worktree, fakeTransfer());
    assert.deepEqual(depRels, ['node_modules']);
    assert.equal(appended(fixture), '');
    assert.deepEqual(deps.lines, []);
});

await test('an ignored folder of any name holding pyvenv.cfg is returned as a dependency folder', async (t) => {
    const fixture = makeFixture(t, {
        rules: 'tools-env/\nplain-tools/\n',
        files: ['tools-env/pyvenv.cfg', 'tools-env/bin/python', 'plain-tools/run.sh'],
    });
    const { main, worktree, deps } = fixture;
    const depRels = await syncIgnored(deps, main, worktree, fakeTransfer());
    assert.ok(depRels, 'the ignored files of the main clone could not be listed');
    assert.deepEqual(depRels.toSorted(), [...DEP_RELS, 'tools-env'].toSorted());
    assert.equal(absent(path.join(worktree, 'tools-env')), true);
    assert.equal(absent(path.join(worktree, 'plain-tools')), true);
    assert.deepEqual([...reported(deps.lines).keys()], ['plain-tools']);
    const lines = excludeLines(fixture);
    assert.equal(lines.includes('/tools-env'), false);
    assert.equal(lines.includes('/plain-tools'), false);
});

await test('a venv or .venv without pyvenv.cfg is neither a dependency folder nor linked', async (t) => {
    const fixture = makeFixture(t, {
        rules: 'venv/\napps/web/.venv\n',
        files: ['venv/settings.ini', 'apps/web/.venv'],
    });
    const { main, worktree, deps } = fixture;
    const depRels = await syncIgnored(deps, main, worktree, fakeTransfer());
    assert.ok(depRels, 'the ignored files of the main clone could not be listed');
    assert.deepEqual(depRels.toSorted(), DEP_RELS);
    assert.equal(absent(path.join(worktree, 'venv')), true);
    assert.equal(absent(path.join(worktree, 'apps', 'web', '.venv')), true);
    assert.deepEqual([...reported(deps.lines).keys()].toSorted(), ['apps/web/.venv', 'venv']);
    const lines = excludeLines(fixture);
    assert.equal(lines.includes('/venv'), false);
    assert.equal(lines.includes('/apps/web/.venv'), false);
});

await test('src/ listed next to src/.idea/ is handled once', async (t) => {
    const fixture = makeFixture(t, { rules: 'src/*\n', files: ['src/.idea/workspace.xml', 'src/pkg/a.py'] });
    const { main, worktree, deps } = fixture;
    const listed = listedIgnored(fixture);
    assert.equal(listed.includes('src/') && listed.includes('src/.idea/'), true, listed.join(' '));
    const transfer = fakeTransfer();
    await syncIgnored(deps, main, worktree, transfer);
    assert.deepEqual([...reported(deps.lines).keys()], ['src']);
    assert.equal(absent(path.join(worktree, 'src')), true);
    assert.equal(
        transfer.copies.some((rel) => rel.startsWith('src/')),
        false
    );
    assert.equal(
        excludeLines(fixture).some((line) => line.startsWith('/src')),
        false
    );
});

await test('unknown top-level entries and a bare .local are not linked and share one not linked line', async (t) => {
    const fixture = makeFixture(t, {
        rules: 'data/\nlocal.settings.json\n.local/\n',
        files: ['data/big.bin', 'local.settings.json', '.local/state'],
    });
    const { main, worktree, deps } = fixture;
    await syncIgnored(deps, main, worktree, fakeTransfer());
    const unlinked = ['.local', 'data', 'local.settings.json'];
    assert.deepEqual([...reported(deps.lines).keys()].toSorted(), unlinked);
    assert.equal(messages(deps.lines).at(-1)?.startsWith(NOT_LINKED_PREFIX), true);
    for (const rel of unlinked) {
        assert.equal(absent(path.join(worktree, rel)), true, rel);
        assert.equal(excludeLines(fixture).includes(anchoredPattern(rel)), false, rel);
    }
});

await test('a top-level collapsed config/ is walked: .env copied into a real folder, the rest reported', async (t) => {
    const fixture = makeFixture(t, { rules: 'config/\n', files: ['config/.env', 'config/c.local.yaml'] });
    const { main, worktree, deps } = fixture;
    const transfer = fakeTransfer();
    await syncIgnored(deps, main, worktree, transfer);
    assert.equal(transfer.copies.includes('config/.env'), true);
    assert.equal(isRealFolder(path.join(worktree, 'config')), true);
    assert.equal(linkText(path.join(worktree, 'config')), undefined);
    assert.deepEqual([...reported(deps.lines).keys()], ['config/c.local.yaml']);
    assert.equal(excludeLines(fixture).includes('/config'), false);
});

await test('a dependency folder found by the walk is returned with its parent created', async (t) => {
    const fixture = makeFixture(t, { rules: '/apps/x/\n', files: ['apps/x/node_modules/p/index.js'] });
    const { main, worktree, deps } = fixture;
    const depRels = await syncIgnored(deps, main, worktree, fakeTransfer());
    assert.ok(depRels, 'the ignored files of the main clone could not be listed');
    assert.deepEqual(depRels.toSorted(), [...DEP_RELS, 'apps/x/node_modules'].toSorted());
    assert.equal(isRealFolder(path.join(worktree, 'apps', 'x')), true);
    assert.equal(absent(path.join(worktree, 'apps', 'x', 'node_modules')), true);
});

await test('an own link already standing at a not linked path keeps it out of the line', async (t) => {
    const fixture = makeFixture(t, {
        rules: 'data/\nlocal.settings.json\n',
        files: ['data/big.bin', 'local.settings.json'],
    });
    const { main, worktree, deps } = fixture;
    fs.symlinkSync(path.join(main, 'data'), path.join(worktree, 'data'));
    await syncIgnored(deps, main, worktree, fakeTransfer());
    assert.deepEqual([...reported(deps.lines).keys()], ['local.settings.json']);
    assert.equal(linkText(path.join(worktree, 'data')), path.join(main, 'data'));
});

await test('a leftover package folder holding only __pycache__ gives no link and no report', async (t) => {
    const fixture = makeFixture(t, { files: ['src/oldpkg/__pycache__/m.cpython-312.pyc'], tracked: ['src/app.py'] });
    const { main, worktree, deps } = fixture;
    assert.equal(listedIgnored(fixture).includes('src/oldpkg/'), true);
    await syncIgnored(deps, main, worktree, fakeTransfer());
    assert.equal(absent(path.join(worktree, 'src', 'oldpkg')), true);
    assert.deepEqual(reported(deps.lines).size, 0);
    assert.equal(
        excludeLines(fixture).some((line) => line.startsWith('/src')),
        false
    );
});

await test('dependency folders get no pattern from the sync and a second run changes nothing', async (t) => {
    const fixture = makeFixture(t, { rules: 'data/\n', files: ['data/big.bin'] });
    const { main, worktree, deps } = fixture;
    await syncIgnored(deps, main, worktree, fakeTransfer(copyIntoWorktree(fixture)));
    assert.equal(excludeLines(fixture).includes('/node_modules'), false);
    assert.equal(excludeLines(fixture).includes('/.venv'), false);
    const excludeAfterFirst = fs.readFileSync(fixture.exclude, 'utf8');
    const reportAfterFirst = messages(deps.lines).filter((line) => line.startsWith(NOT_LINKED_PREFIX));
    assert.equal(reportAfterFirst.length, 1);
    deps.lines.length = 0;
    const second = fakeTransfer(copyIntoWorktree(fixture));
    await syncIgnored(deps, main, worktree, second);
    assert.deepEqual(second.copies, []);
    assert.deepEqual(second.clones, []);
    assert.deepEqual(messages(deps.lines), reportAfterFirst);
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
    writeFile(path.join(worktree, 'packages/a/.python-version'), 'edited\n');
    const transfer = fakeTransfer();
    await syncIgnored(deps, main, worktree, transfer);
    assert.deepEqual(transfer.copies.toSorted(), ['.npmrc', 'apps/api/secrets/.env']);
    assert.equal(linkText(path.join(worktree, '.env')), path.join(worktree, 'elsewhere'));
    assert.equal(fs.readFileSync(path.join(worktree, 'packages/a/.python-version'), 'utf8'), 'edited\n');
});

await test('a collapsed folder over the walk limits is not expanded and is reported with a + size', async (t) => {
    const fixture = makeFixture(t, { rules: 'deep/\n', files: ['deep/a/b/c/d/e/f/g/.env'] });
    const { main, worktree, deps } = fixture;
    const transfer = fakeTransfer();
    await syncIgnored(deps, main, worktree, transfer);
    assert.equal(
        messages(deps.lines).includes(
            'warn not expanded deep: more than 5000 entries or deeper than 6 levels; nothing inside it was copied or linked'
        ),
        true
    );
    assert.equal(
        transfer.copies.some((rel) => rel.startsWith('deep/')),
        false
    );
    assert.equal(absent(path.join(worktree, 'deep')), true);
    assert.match(reported(deps.lines).get('deep') ?? '', /^\d+ (B|KB)\+$/u);
});

await test('entries git lists below a capped folder are placed without report entries of their own', async (t) => {
    const fixture = makeFixture(t, {
        rules: 'data/*\n',
        files: ['data/deep/a/b/c/d/e/f/x.bin', 'data/.env', 'data/b.bin'],
    });
    const { main, worktree, deps } = fixture;
    const listed = listedIgnored(fixture);
    assert.equal(listed.includes('data/') && listed.includes('data/.env'), true, listed.join(' '));
    const transfer = fakeTransfer();
    await syncIgnored(deps, main, worktree, transfer);
    assert.deepEqual(
        transfer.copies.filter((rel) => rel.startsWith('data/')),
        ['data/.env']
    );
    const shown = messages(deps.lines);
    assert.equal(
        shown.includes(
            'warn not expanded data: more than 5000 entries or deeper than 6 levels; only entries git lists separately were placed'
        ),
        true,
        shown.join('\n')
    );
    assert.equal(
        shown.some((line) => line.includes('nothing inside it was copied or linked')),
        false
    );
    const report = reported(deps.lines);
    assert.deepEqual([...report.keys()], ['data']);
    assert.match(report.get('data') ?? '', /^\d+ (B|KB)\+$/u);
});

await test('a capped folder whose listed entries place nothing keeps the nothing copied warning', async (t) => {
    const fixture = makeFixture(t, { rules: 'data/*\n', files: ['data/deep/a/b/c/d/e/f/x.bin', 'data/b.bin'] });
    const { main, worktree, deps } = fixture;
    await syncIgnored(deps, main, worktree, fakeTransfer());
    assert.equal(
        messages(deps.lines).includes(
            'warn not expanded data: more than 5000 entries or deeper than 6 levels; nothing inside it was copied or linked'
        ),
        true
    );
    assert.deepEqual([...reported(deps.lines).keys()], ['data']);
});

await test('a rerun plans nothing below an own link an earlier version made', async (t) => {
    const fixture = makeFixture(t, {
        rules: 'config/\nsettings/*\n',
        files: ['config/.env', 'config/c.local.yaml', 'config/sub/a.bin', 'settings/.env', 'settings/s.local.yaml'],
    });
    const { main, worktree, deps } = fixture;
    for (const rel of ['config', 'settings', 'apps/api']) {
        fs.symlinkSync(path.join(main, rel), path.join(worktree, rel));
    }
    const transfer = fakeTransfer();
    await syncIgnored(deps, main, worktree, transfer);
    assert.deepEqual(transfer.copies.toSorted(), ['.env', '.npmrc', 'packages/a/.python-version']);
    const shown = messages(deps.lines);
    assert.equal(
        shown.some((line) => line.startsWith('warn ')),
        false,
        shown.join('\n')
    );
    assert.equal(
        shown.some((line) => ['config/', 'settings', 'apps/api'].some((part) => line.includes(part))),
        false,
        shown.join('\n')
    );
    assert.equal(reported(deps.lines).has('config'), false);
});

await test('a copied folder hides the entries git lists below it', async (t) => {
    const fixture = makeFixture(t, { rules: 'temp.local/*\n', files: ['temp.local/a.txt', 'temp.local/.env'] });
    const { main, worktree, deps } = fixture;
    const listed = listedIgnored(fixture);
    assert.equal(listed.includes('temp.local/') && listed.includes('temp.local/.env'), true, listed.join(' '));
    const transfer = fakeTransfer();
    await syncIgnored(deps, main, worktree, transfer);
    assert.deepEqual(
        transfer.copies.filter((rel) => rel.startsWith('temp.local')),
        ['temp.local']
    );
    assert.equal(
        [...reported(deps.lines).keys()].some((rel) => rel.startsWith('temp.local')),
        false
    );
});

await test('a fully ignored top-level .vscode folder is linked whole with its exclude line', async (t) => {
    const fixture = makeFixture(t, { rules: '.vscode/\n', files: ['.vscode/settings.json', '.vscode/launch.json'] });
    const { main, worktree, deps } = fixture;
    assert.equal(listedIgnored(fixture).includes('.vscode/'), true);
    await syncIgnored(deps, main, worktree, fakeTransfer());
    assert.equal(linkText(path.join(worktree, '.vscode')), path.join(main, '.vscode'));
    assert.equal(excludeLines(fixture).includes('/.vscode'), true);
    assert.equal(
        messages(deps.lines).some((line) => line.startsWith('info linked ') && line.includes('.vscode')),
        true
    );
});

// A relative link is not the tool's own link (always absolute), so the entry below it is planned and refused.
await test('a copy whose parent in the worktree links into the main clone is skipped with a warning', async (t) => {
    const fixture = makeFixture(t, { files: ['apps/web/.env.local'] });
    const { main, worktree, deps } = fixture;
    fs.rmSync(path.join(worktree, 'apps', 'web'), { recursive: true });
    const linkFile = path.join(worktree, 'apps', 'web');
    fs.symlinkSync(path.relative(path.dirname(linkFile), path.join(main, 'apps', 'web')), linkFile);
    const transfer = fakeTransfer();
    await syncIgnored(deps, main, worktree, transfer);
    assert.equal(transfer.copies.includes('apps/web/.env.local'), false);
    assert.equal(
        messages(deps.lines).includes(
            'warn skipped apps/web/.env.local: its folder apps/web in the worktree is a link or not a folder'
        ),
        true
    );
    assert.deepEqual(fs.readdirSync(path.join(main, 'apps', 'web')).toSorted(), ['.env.local', 'index.js']);
});

await test('a file standing where a parent folder belongs blocks a copy and a found dependency', async (t) => {
    const fixture = makeFixture(t, { rules: '/apps/x/\n', files: ['apps/x/node_modules/p/index.js'] });
    const { main, worktree, deps } = fixture;
    writeFile(path.join(worktree, 'apps', 'api'), 'a file\n');
    writeFile(path.join(worktree, 'apps', 'x'), 'a file\n');
    const transfer = fakeTransfer();
    const depRels = await syncIgnored(deps, main, worktree, transfer);
    assert.ok(depRels, 'the ignored files of the main clone could not be listed');
    assert.deepEqual(depRels.toSorted(), DEP_RELS);
    assert.equal(transfer.copies.includes('apps/api/secrets/.env'), false);
    const shown = messages(deps.lines);
    for (const [rel, blocker] of [
        ['apps/api/secrets/.env', 'apps/api'],
        ['apps/x/node_modules', 'apps/x'],
    ]) {
        const line = `warn skipped ${rel}: its folder ${blocker} in the worktree is a link or not a folder`;
        assert.equal(shown.includes(line), true, line);
    }
});

await test('a parent folder that cannot be created is named with its error code', { skip: ROOT_SKIP }, async (t) => {
    const fixture = makeFixture(t);
    const { main, worktree, deps } = fixture;
    const apps = path.join(worktree, 'apps');
    fs.chmodSync(apps, 0o555);
    const transfer = fakeTransfer();
    try {
        await syncIgnored(deps, main, worktree, transfer);
    } finally {
        fs.chmodSync(apps, 0o755);
    }
    assert.equal(transfer.copies.includes('apps/api/secrets/.env'), false);
    assert.equal(
        messages(deps.lines).includes(
            'warn skipped apps/api/secrets/.env: cannot create its folder apps/api in the worktree (EACCES)'
        ),
        true
    );
});

await test(
    'an unreadable folder inside a walked folder is warned about and its siblings still sync',
    {
        skip: ROOT_SKIP,
    },
    async (t) => {
        const fixture = makeFixture(t, { rules: 'mixed/\n', files: ['mixed/locked/inner.bin', 'mixed/.env'] });
        const { main, worktree, deps } = fixture;
        const locked = path.join(main, 'mixed', 'locked');
        fs.chmodSync(locked, 0o000);
        const transfer = fakeTransfer();
        try {
            await syncIgnored(deps, main, worktree, transfer);
        } finally {
            fs.chmodSync(locked, 0o755);
        }
        assert.equal(
            messages(deps.lines).includes('warn skipped mixed/locked: cannot read it in the main clone'),
            true
        );
        assert.equal(transfer.copies.includes('mixed/.env'), true);
    }
);

await test('odd names are linked byte for byte', async (t) => {
    const fixture = makeFixture(t);
    const { main, worktree, deps } = fixture;
    const names = [
        '\u041F\u0440\u0438\u0432\u0435\u0442.local.odd',
        'my notes.local.odd',
        ' leading.local.odd',
        'say "hi" \'there\'.local.odd',
        String.raw`back\slash.local.odd`,
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
    assert.equal(await syncIgnored(failing, main, worktree, transfer), undefined);
    assert.deepEqual(messages(deps.lines), [
        `warn cannot list the ignored files of ${main}; nothing synced into the worktree, the dependency fallback is skipped and nested projects are not installed automatically`,
    ]);
    assert.deepEqual(fs.readdirSync(worktree).toSorted(), before);
    assert.deepEqual(transfer.copies, []);
    assert.deepEqual(transfer.clones, []);
    assert.equal(fs.readFileSync(fixture.exclude, 'utf8'), fixture.baseline);
});

await test('a forced link inside a walked folder is placed, and its siblings are still placed and reported', async (t) => {
    const fixture = makeFixture(t, {
        rules: 'backend/\n',
        files: ['backend/db.sqlite3', 'backend/.env', 'backend/dump.bin'],
    });
    const { main, worktree, deps, env } = fixture;
    const transfer = fakeTransfer();
    await syncIgnored(deps, main, worktree, transfer, { links: ['backend/db.sqlite3'], env });
    assert.equal(linkText(path.join(worktree, 'backend', 'db.sqlite3')), path.join(main, 'backend', 'db.sqlite3'));
    assert.equal(isRealFolder(path.join(worktree, 'backend')), true);
    assert.equal(transfer.copies.includes('backend/.env'), true);
    const unlinked = reported(deps.lines);
    assert.equal(unlinked.has('backend/dump.bin'), true);
    assert.equal(unlinked.has('backend'), false);
    assert.equal(unlinked.has('backend/db.sqlite3'), false);
    const linkedLines = messages(deps.lines).filter((line) => line.startsWith('info linked '));
    assert.deepEqual(linkedLines, [
        'info linked backend/db.sqlite3, .idea/workspace.xml, AGENTS.md, config.local.yaml, docs.local',
    ]);
    assert.equal(excludeLines(fixture).includes('/backend/db.sqlite3'), true);
});

await test('a forced allowlisted entry is linked once, and legacy block lines are checked before the report', async (t) => {
    const fixture = makeFixture(t, {
        rules: '.idea/\ndata/\n',
        files: ['data/big.bin', 'src/oldpkg/__init__.py'],
        omitTracked: ['.idea/misc.xml'],
    });
    const { main, worktree, deps, env } = fixture;
    fs.appendFileSync(fixture.exclude, `${EXCLUDE_HEADER}\n/src/oldpkg\n`);
    await syncIgnored(deps, main, worktree, fakeTransfer(), { links: ['.idea', 'data'], env });
    assert.equal(linkText(path.join(worktree, '.idea')), path.join(main, '.idea'));
    assert.equal(linkText(path.join(worktree, 'data')), path.join(main, 'data'));
    const shown = messages(deps.lines);
    const linkedIndex = shown.findIndex((line) => line.startsWith('info linked '));
    assert.deepEqual(
        shown.filter((line) => line.startsWith('info linked ')),
        ['info linked .idea, data, AGENTS.md, config.local.yaml, docs.local']
    );
    const legacy = shown.filter((line) => line.includes(' line /'));
    assert.deepEqual(legacy, [
        'warn .git/info/exclude line /src/oldpkg hides 1 file that .gitignore does not ignore (src/oldpkg); git status and git add skip it. Remove the worktree-add links at src/oldpkg in every worktree first, then this line',
    ]);
    const legacyIndex = shown.indexOf(legacy[0] ?? '');
    const reportIndex = shown.findIndex((line) => line.startsWith(NOT_LINKED_PREFIX));
    assert.equal(linkedIndex < legacyIndex && legacyIndex < reportIndex, true, shown.join('\n'));
    assert.equal(
        shown.some((line) => line.includes('outside the current rules')),
        false
    );
    assert.equal(reported(deps.lines).has('data'), false);
    assert.equal(excludeLines(fixture).filter((line) => line === '/.idea').length, 1);
});

await test('a refused forced path is warned about and the rest of the sync still runs', async (t) => {
    const fixture = makeFixture(t);
    const { main, worktree, deps, env } = fixture;
    const transfer = fakeTransfer();
    const depRels = await syncIgnored(deps, main, worktree, transfer, { links: ['app/m.py'], env });
    assert.deepEqual(depRels?.toSorted(), DEP_RELS);
    assert.equal(
        messages(deps.lines).includes('warn not linked with --link: app/m.py is not ignored in the main clone'),
        true
    );
    assert.equal(transfer.copies.includes('.env'), true);
    assert.equal(linkText(path.join(worktree, 'docs.local')), path.join(main, 'docs.local'));
    assert.equal(lstatIsLink(path.join(worktree, 'app', 'm.py')), false);
});

await test('a forced path inside a fully ignored .idea is refused and .idea is still linked whole', async (t) => {
    const fixture = makeFixture(t, {
        rules: '.idea/\n',
        files: ['.idea/other.xml'],
        omitTracked: ['.idea/misc.xml'],
    });
    const { main, worktree, deps, env } = fixture;
    assert.equal(listedIgnored(fixture).includes('.idea/'), true);
    await syncIgnored(deps, main, worktree, fakeTransfer(), { links: ['.idea/workspace.xml'], env });
    assert.equal(linkText(path.join(worktree, '.idea')), path.join(main, '.idea'));
    assert.equal(
        messages(deps.lines).includes(
            'warn not linked with --link: .idea/workspace.xml: it is inside .idea, which is linked whole'
        ),
        true,
        messages(deps.lines).join('\n')
    );
    assert.equal(excludeLines(fixture).includes('/.idea/workspace.xml'), false);
});

await test('a rerun with the same forced paths logs no linked line and adds no exclude lines', async (t) => {
    const fixture = makeFixture(t, {
        rules: 'data/\nbackend/\n',
        files: ['data/big.bin', 'backend/db.sqlite3'],
    });
    const { main, worktree, env } = fixture;
    const options = { links: ['data', 'backend/db.sqlite3'], env };
    await syncIgnored(fixture.deps, main, worktree, fakeTransfer(), options);
    assert.equal(linkText(path.join(worktree, 'data')), path.join(main, 'data'));
    assert.equal(linkText(path.join(worktree, 'backend', 'db.sqlite3')), path.join(main, 'backend', 'db.sqlite3'));
    const before = fs.readFileSync(fixture.exclude, 'utf8');
    const again = testDeps(env);
    await syncIgnored(again, main, worktree, fakeTransfer(), options);
    const shown = messages(again.lines);
    assert.equal(
        shown.some((line) => line.startsWith('info linked ')),
        false,
        shown.join('\n')
    );
    assert.equal(
        shown.some((line) => line.includes('outside the current rules')),
        false,
        shown.join('\n')
    );
    assert.equal(fs.readFileSync(fixture.exclude, 'utf8'), before);
});

await test('a forced folder above entries git lists separately hides them from the plan', async (t) => {
    const fixture = makeFixture(t, { rules: 'backend/*\n', files: ['backend/.env', 'backend/dump.bin'] });
    const { main, worktree, deps, env } = fixture;
    const listed = listedIgnored(fixture);
    assert.equal(
        ['backend/', 'backend/.env', 'backend/dump.bin'].every((rel) => listed.includes(rel)),
        true,
        listed.join(' ')
    );
    const transfer = fakeTransfer();
    await syncIgnored(deps, main, worktree, transfer, { links: ['backend'], env });
    assert.equal(linkText(path.join(worktree, 'backend')), path.join(main, 'backend'));
    assert.equal(
        transfer.copies.some((rel) => rel.startsWith('backend')),
        false
    );
    assert.equal(
        [...reported(deps.lines).keys()].some((rel) => rel.startsWith('backend')),
        false
    );
    assert.deepEqual(
        messages(deps.lines).filter((line) => line.startsWith('warn ')),
        []
    );
});

await test('a forced folder does not hide a sibling whose name starts with the same text', async (t) => {
    const fixture = makeFixture(t, { rules: 'data/\ndata2/*\n', files: ['data/big.bin', 'data2/x.bin'] });
    const { main, worktree, deps, env } = fixture;
    assert.equal(listedIgnored(fixture).includes('data2/x.bin'), true);
    await syncIgnored(deps, main, worktree, fakeTransfer(), { links: ['data'], env });
    assert.equal(linkText(path.join(worktree, 'data')), path.join(main, 'data'));
    const unlinked = reported(deps.lines);
    assert.equal(unlinked.has('data'), false);
    assert.equal(unlinked.has('data2'), true, [...unlinked.keys()].join(' '));
});

await test('a link an earlier --link made is kept when the path is passed again', async (t) => {
    const fixture = makeFixture(t, { rules: 'data/\n', files: ['data/big.bin'] });
    const { main, worktree, env } = fixture;
    fs.appendFileSync(fixture.exclude, `${EXCLUDE_HEADER}\n/data\n`);
    fs.symlinkSync(path.join(main, 'data'), path.join(worktree, 'data'));
    const outsideLines = (lines: readonly string[]): string[] =>
        messages(lines).filter((line) => line.includes('outside the current rules') && line.includes('data'));
    const without = testDeps(env);
    await syncIgnored(without, main, worktree, fakeTransfer(), { links: [], env });
    assert.equal(outsideLines(without.lines).length, 1, messages(without.lines).join('\n'));
    const again = testDeps(env);
    await syncIgnored(again, main, worktree, fakeTransfer(), { links: ['data'], env });
    assert.deepEqual(outsideLines(again.lines), []);
    assert.equal(
        messages(again.lines).some((line) => line.startsWith('info linked ') && line.includes('data')),
        false
    );
    assert.equal(linkText(path.join(worktree, 'data')), path.join(main, 'data'));
});
