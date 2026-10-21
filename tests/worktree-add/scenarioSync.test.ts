import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { SANDBOX_NETWORK_VARIABLE } from '../../src/worktree-add/installStage.ts';
import { createProcessRunner } from '../../src/worktree-add/proc.ts';
import type { Env } from '../../src/worktree-add/types.ts';

import { testDeps } from './support/deps.ts';
import { withoutCow } from './support/runners.ts';
import { linkTextOf, makeScenario, messages, okPath, runScenario, type Scenario } from './support/scenario.ts';
import { isolatedBin, withPath } from './support/stubManagers.ts';
import { writeStubTool } from './support/tools.ts';

const NO_INSTALL = ['--suffix', 't', '--no-install'];
const NPM_LOCK = '{"lockfileVersion":3}\n';
// Records which of the copied settings files the install found in its own folder.
const SEEN_STUB = [
    'case "$1" in --version) echo 10.9.0; exit 0;; esac',
    ': > seen.txt',
    'for f in .npmrc .python-version; do if [ -f "$f" ]; then echo "$f" >> seen.txt; fi; done',
    'mkdir -p node_modules',
    'exit 0',
].join('\n');

function log(s: Scenario): string {
    return messages(s).join('\n');
}

function notLinkedMessage(s: Scenario): string | undefined {
    return messages(s).find((line) => line.startsWith('info not linked: '));
}

function assertOwnLink(s: Scenario, worktree: string, rel: string): void {
    assert.equal(linkTextOf(path.join(worktree, rel)), path.join(s.main, rel), `${rel}\n${log(s)}`);
}

function assertRealFolder(worktree: string, rel: string): void {
    assert.equal(fs.lstatSync(path.join(worktree, rel)).isDirectory(), true, rel);
}

// A regular file (not a link) with the main clone's content and permission bits.
function assertCopied(s: Scenario, worktree: string, rel: string): void {
    const copy = fs.lstatSync(path.join(worktree, rel), { throwIfNoEntry: false });
    assert.equal(copy?.isFile(), true, `${rel}\n${log(s)}`);
    const original = fs.lstatSync(path.join(s.main, rel));
    assert.equal((copy?.mode ?? 0) & 0o777, original.mode & 0o777, rel);
    assert.equal(fs.readFileSync(path.join(worktree, rel), 'utf8'), fs.readFileSync(path.join(s.main, rel), 'utf8'));
}

function assertAbsent(worktree: string, rel: string): void {
    assert.equal(fs.lstatSync(path.join(worktree, rel), { throwIfNoEntry: false }), undefined, rel);
}

// Every symlink below ROOT, relative to it, without descending into .git or into links.
function linksBelow(root: string, rel = ''): string[] {
    const found: string[] = [];
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
        const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
        if (entry.isSymbolicLink()) {
            found.push(childRel);
        } else if (entry.isDirectory() && childRel !== '.git') {
            found.push(...linksBelow(root, childRel));
        }
    }
    return found;
}

function countOf(text: string, part: string): number {
    return text.split(part).length - 1;
}

// The same scenario with a stub npm as the only package manager on an isolated PATH and network allowed.
function withStubNpm(t: TestContext, s: Scenario): Scenario {
    const bin = isolatedBin(s.root);
    writeStubTool(bin, 'npm', SEEN_STUB);
    const env: Env = { ...withPath(s.env, bin), [SANDBOX_NETWORK_VARIABLE]: undefined };
    const runner = withoutCow(createProcessRunner(env));
    t.after(() => runner.terminateAll());
    return { ...s, env, deps: testDeps(env, { runner }) };
}

await test('K1: copies and links found in collapsed folders land with their parents created', async (t) => {
    const s = makeScenario(t, {
        ignore: 'apps/api/secrets/\ntools/agent/\n.env\n',
        tracked: {
            'apps/api/index.js': 'api\n',
            'apps/web/secrets/README.md': 'readme\n',
            'tools/README.md': 'tools\n',
        },
        ignored: {
            'apps/api/secrets/.env': 'API=1\n',
            'apps/web/secrets/.env': 'WEB=1\n',
            'tools/agent/.claude/settings.local.json': '{}\n',
            'apps/new/.env': 'NEW=1\n',
        },
    });
    fs.chmodSync(path.join(s.main, 'apps/api/secrets/.env'), 0o600);
    fs.chmodSync(path.join(s.main, 'apps/web/secrets/.env'), 0o640);
    fs.chmodSync(path.join(s.main, 'apps/new/.env'), 0o600);
    const worktree = okPath(await runScenario(s, NO_INSTALL));
    assertCopied(s, worktree, 'apps/api/secrets/.env');
    assertRealFolder(worktree, 'apps/api/secrets');
    assertCopied(s, worktree, 'apps/web/secrets/.env');
    assertOwnLink(s, worktree, 'tools/agent/.claude/settings.local.json');
    assertRealFolder(worktree, 'tools/agent');
    assertRealFolder(worktree, 'tools/agent/.claude');
    assertCopied(s, worktree, 'apps/new/.env');
    assert.equal(fs.statSync(path.join(worktree, 'apps/new/.env')).mode & 0o777, 0o600);
    assertRealFolder(worktree, 'apps/new');
});

await test('K2: setting files are copied before the install stage runs in each project', async (t) => {
    const base = makeScenario(t, {
        ignore: '.npmrc\n.python-version\nnode_modules/\nseen.txt\n',
        tracked: {
            'package.json': '{"name":"root"}\n',
            'package-lock.json': NPM_LOCK,
            'packages/a/package.json': '{"name":"a"}\n',
            'packages/a/package-lock.json': NPM_LOCK,
        },
        ignored: {
            '.npmrc': 'registry=https://example.invalid/\n',
            '.python-version': '3.12\n',
            'packages/a/.npmrc': 'save-exact=true\n',
            'packages/a/.python-version': '3.11\n',
            // A nested project is installed automatically only when the main clone has its dependency folder.
            'node_modules/pkg/index.js': 'pkg\n',
            'packages/a/node_modules/pkg/index.js': 'pkg\n',
        },
    });
    const s = withStubNpm(t, base);
    const worktree = okPath(await runScenario(s, ['--suffix', 't']));
    for (const folder of ['', 'packages/a']) {
        const seen = fs.readFileSync(path.join(worktree, folder, 'seen.txt'), 'utf8');
        assert.deepEqual(seen.trim().split('\n'), ['.npmrc', '.python-version'], `${folder}\n${log(s)}`);
        assertCopied(s, worktree, path.posix.join(folder, '.npmrc'));
        assertCopied(s, worktree, path.posix.join(folder, '.python-version'));
    }
});

await test('K3: tool folders, local names and a double listing', async (t) => {
    const s = makeScenario(t, {
        ignore: [
            '.idea/workspace.xml',
            '.vscode/settings.json',
            '.cursor/mcp.json',
            '.claude/settings.local.json',
            '.local/',
            'local.settings.json',
            'config.local.yaml',
            'src/*',
            '',
        ].join('\n'),
        tracked: {
            '.idea/modules.xml': '<modules/>\n',
            '.vscode/extensions.json': '{}\n',
            '.cursor/rules.md': 'rules\n',
            '.claude/settings.json': '{}\n',
        },
        ignored: {
            '.idea/workspace.xml': '<workspace/>\n',
            '.vscode/settings.json': '{"a":1}\n',
            '.cursor/mcp.json': '{"b":2}\n',
            '.claude/settings.local.json': '{"c":3}\n',
            '.local/state.txt': 'state\n',
            'local.settings.json': '{"d":4}\n',
            'config.local.yaml': 'e: 5\n',
            'src/.idea/workspace.xml': '<inner/>\n',
        },
    });
    const worktree = okPath(await runScenario(s, NO_INSTALL));
    for (const rel of [
        '.idea/workspace.xml',
        '.vscode/settings.json',
        '.cursor/mcp.json',
        '.claude/settings.local.json',
    ]) {
        assertOwnLink(s, worktree, rel);
        assertRealFolder(worktree, path.posix.dirname(rel));
    }
    assertOwnLink(s, worktree, 'config.local.yaml');
    assertAbsent(worktree, '.local');
    assertAbsent(worktree, 'local.settings.json');
    assertAbsent(worktree, 'src');
    const line = notLinkedMessage(s) ?? '';
    assert.match(line, /\.local \(/u, log(s));
    assert.match(line, /local\.settings\.json \(/u, log(s));
    assert.equal(countOf(line, 'src'), 1, log(s));
    assert.equal(
        messages(s).some((message) => message.includes('src/.idea')),
        false,
        log(s)
    );
    assert.match(line, /src \(/u, log(s));
});

await test('P1: a collapsed top folder gets its copies inside a real folder and reports the rest', async (t) => {
    const s = makeScenario(t, {
        ignore: 'config/\n',
        ignored: { 'config/.env': 'C=1\n', 'config/c.local.yaml': 'c: 1\n' },
    });
    const worktree = okPath(await runScenario(s, NO_INSTALL));
    assertCopied(s, worktree, 'config/.env');
    assertRealFolder(worktree, 'config');
    assertAbsent(worktree, 'config/c.local.yaml');
    assert.match(notLinkedMessage(s) ?? '', /config\/c\.local\.yaml \(/u, log(s));
});

await test('Python src and flat layouts place nothing from caches and build metadata', async (t) => {
    const s = makeScenario(t, {
        ignore: '__pycache__/\n*.pyc\n*.egg-info/\n.pytest_cache/\n',
        tracked: {
            'pyproject.toml': '[project]\nname = "demo"\n',
            'src/pkg/__init__.py': '\n',
            'flat/__init__.py': '\n',
        },
        ignored: {
            'src/pkg/__pycache__/__init__.cpython-312.pyc': 'bytecode',
            'src/pkg.egg-info/PKG-INFO': 'info\n',
            'src/oldpkg/__pycache__/old.cpython-312.pyc': 'bytecode',
            'flat/__pycache__/__init__.cpython-312.pyc': 'bytecode',
            'flat/mod.pyc': 'bytecode',
            'flat.egg-info/PKG-INFO': 'info\n',
            '.pytest_cache/v/cache/nodeids': '[]\n',
        },
    });
    const worktree = okPath(await runScenario(s, NO_INSTALL));
    const python = linksBelow(worktree).filter(
        (rel) =>
            rel.includes('__pycache__') ||
            rel.includes('.egg-info') ||
            rel.includes('.pytest_cache') ||
            rel.endsWith('.pyc')
    );
    assert.deepEqual(python, [], log(s));
    for (const rel of [
        'src/pkg/__pycache__',
        'src/pkg.egg-info',
        'src/oldpkg/__pycache__',
        'flat/__pycache__',
        'flat.egg-info',
        '.pytest_cache',
    ]) {
        assertAbsent(worktree, rel);
    }
    assertAbsent(worktree, 'src/oldpkg');
    assertAbsent(worktree, 'flat/mod.pyc');
    assert.equal(log(s).includes('oldpkg'), false, log(s));
});

await test('junk and tool state are skipped; target only beside a build manifest', async (t) => {
    const s = makeScenario(t, {
        ignore: '.DS_Store\n*.swp\n*.log\n.terraform/\ntarget/\n',
        tracked: { 'Cargo.toml': '[package]\nname = "demo"\n', 'tools/README.md': 'tools\n' },
        ignored: {
            '.DS_Store': 'ds',
            'x.swp': 'swap',
            'debug.log': 'log\n',
            '.terraform/providers/p': 'provider',
            'target/debug/demo': 'binary',
            'tools/target/out.bin': 'out',
        },
    });
    const worktree = okPath(await runScenario(s, NO_INSTALL));
    for (const rel of ['.DS_Store', 'x.swp', 'debug.log', '.terraform', 'target', 'tools/target']) {
        assertAbsent(worktree, rel);
    }
    const line = notLinkedMessage(s) ?? '';
    assert.match(line, /tools\/target \(/u, log(s));
    for (const junk of ['.DS_Store', 'x.swp', 'debug.log', '.terraform', 'target/debug']) {
        assert.equal(line.includes(junk), false, `${junk}\n${log(s)}`);
    }
});

await test('a collapsed folder over the walk cap is warned about, left out and reported with a + size', async (t) => {
    const s = makeScenario(t, { ignore: 'big/\n' });
    fs.mkdirSync(path.join(s.main, 'big'));
    for (let index = 0; index <= 5000; index += 1) {
        fs.writeFileSync(path.join(s.main, 'big', `f${String(index)}.txt`), 'x');
    }
    const worktree = okPath(await runScenario(s, NO_INSTALL));
    assert.ok(
        messages(s).includes(
            'warn not expanded big: more than 5000 entries or deeper than 6 levels; nothing inside it was copied or linked'
        ),
        log(s)
    );
    assertAbsent(worktree, 'big');
    assert.match(notLinkedMessage(s) ?? '', /big \(\d+ (B|KB|MB)\+\)/u, log(s));
});

await test("this repository's own layout links AGENTS.md and docs.local and copies CLAUDE.local.md", async (t) => {
    const s = makeScenario(t, {
        ignore: 'AGENTS.md\ndocs.local/\nCLAUDE.local.md\n',
        ignored: { 'AGENTS.md': 'agents\n', 'docs.local/wiki/README.md': 'wiki\n', 'CLAUDE.local.md': 'local\n' },
    });
    const worktree = okPath(await runScenario(s, NO_INSTALL));
    assertOwnLink(s, worktree, 'AGENTS.md');
    assertOwnLink(s, worktree, 'docs.local');
    assertCopied(s, worktree, 'CLAUDE.local.md');
});
