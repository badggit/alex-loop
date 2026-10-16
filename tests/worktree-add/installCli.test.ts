import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { SANDBOX_NETWORK_VARIABLE } from '../../src/worktree-add/installStage.ts';
import type { Env } from '../../src/worktree-add/types.ts';

import { commitFile, makeRepo, testEnv } from './support/git.ts';
import { isolatedBin, withPath } from './support/stubManagers.ts';
import { tempRoot } from './support/tmp.ts';
import { realToolPath, writeStubTool } from './support/tools.ts';

interface CliResult {
    code: number | null;
    stdout: string;
    stderr: string;
}

interface Fixture {
    root: string;
    env: Env;
    main: string;
}

const CLI = path.resolve(import.meta.dirname, '../../src/worktree-add/cli.ts');
const LINUX_ONLY = process.platform === 'linux' ? false : 'macOS pins /bin/cp';
const LOG_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z (info|warn|error) (.*)$/u;
const NPM_LOCK = '{"lockfileVersion":3}\n';
const VERSION_LINE = 'case "$1" in --version) echo 10.9.0; exit 0;; esac';
const NPM_OK_STUB = `${VERSION_LINE}\nmkdir -p node_modules/from-stub\necho "added 1 package"\nexit 0`;
const NPM_E401_STUB = [
    VERSION_LINE,
    'echo "npm error code E401" >&2',
    'echo "npm error Unable to authenticate, your authentication token seems to be invalid." >&2',
    'exit 1',
].join('\n');
const E401_HEADLINE =
    'cannot install dependencies with npm: authentication failed ' +
    '(npm error code E401: Unable to authenticate, your authentication token seems to be invalid.)';

function definedEnv(env: Env): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) {
        if (value !== undefined) {
            result[name] = value;
        }
    }
    return result;
}

function runCli(env: Env, args: readonly string[], cwd: string): Promise<CliResult> {
    const child = spawn(process.execPath, [CLI, ...args], {
        cwd,
        env: definedEnv(env),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
    });
    return new Promise<CliResult>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => {
            resolve({ code, stdout, stderr });
        });
    });
}

// A main clone app with a tracked npm project and an ignored node_modules present; the PATH holds only the base
// tools and NPM_BODY as npm, and the sandbox switch is cleared so the stage always tries the install.
function makeFixture(t: TestContext, npmBody: string): Fixture {
    const root = tempRoot(t);
    const bin = isolatedBin(root);
    writeStubTool(bin, 'npm', npmBody);
    const env: Env = { ...withPath(testEnv(root), bin), [SANDBOX_NETWORK_VARIABLE]: undefined };
    const { main } = makeRepo(root, env);
    commitFile(env, main, '.gitignore', 'node_modules/\n');
    commitFile(env, main, 'package.json', '{"name":"demo"}\n');
    commitFile(env, main, 'package-lock.json', NPM_LOCK);
    fs.mkdirSync(path.join(main, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(main, 'node_modules', 'pkg', 'index.js'), 'pkg\n');
    return { root, env, main };
}

// The real cp is replaced by one that rejects every clone, so a fallback node_modules is always an own link.
function rejectClones(f: Fixture): void {
    const bin = path.join(f.root, 'bin');
    const realCp = realToolPath('cp', f.env);
    fs.rmSync(path.join(bin, 'cp'));
    writeStubTool(
        bin,
        'cp',
        [
            'for a do',
            '    case "$a" in --reflink=always) echo "failed to clone" >&2; exit 1 ;; esac',
            'done',
            `exec '${realCp}' "$@"`,
        ].join('\n')
    );
}

function messages(stderr: string): string[] {
    return stderr
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => {
            const match = LOG_LINE.exec(line);
            return match === null ? `unformatted: ${line}` : `${match[1] ?? ''} ${match[2] ?? ''}`;
        });
}

await test('a failing npm install exits 0 with the path on stdout and the warning group on stderr', async (t) => {
    const f = makeFixture(t, NPM_E401_STUB);
    const result = await runCli(f.env, ['--suffix', 'inst-1'], f.main);
    const worktree = path.join(f.root, 'app-inst-1');
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `${worktree}\n`);
    const shown = messages(result.stderr);
    const at = shown.indexOf(`warn ${E401_HEADLINE}`);
    assert.notEqual(at, -1, result.stderr);
    assert.deepEqual(shown.slice(at + 1, at + 3), [
        'warn node_modules is left missing: code that needs it fails until it is installed',
        'warn to install: log in to the registry or refresh the token, then run in the worktree: npm ci',
    ]);
    assert.match(shown[at + 3] ?? '', /^warn full npm output: \S+$/u);
    assert.equal(shown.filter((line) => line.startsWith('warn ')).length, 4, result.stderr);
    assert.equal(fs.lstatSync(path.join(worktree, 'node_modules'), { throwIfNoEntry: false }), undefined);
});

await test('a succeeding npm install keeps stdout to the path alone', async (t) => {
    const f = makeFixture(t, NPM_OK_STUB);
    const result = await runCli(f.env, ['--suffix', 'inst-2'], f.main);
    const worktree = path.join(f.root, 'app-inst-2');
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `${worktree}\n`);
    assert.deepEqual(fs.readdirSync(path.join(worktree, 'node_modules')), ['from-stub']);
    assert.equal(result.stderr.includes('added 1 package'), false, result.stderr);
});

await test('--no-install prints the path and leaves node_modules as an own link', { skip: LINUX_ONLY }, async (t) => {
    const f = makeFixture(t, NPM_OK_STUB);
    rejectClones(f);
    const result = await runCli(f.env, ['--suffix', 'inst-3', '--no-install'], f.main);
    const worktree = path.join(f.root, 'app-inst-3');
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `${worktree}\n`);
    const modules = path.join(worktree, 'node_modules');
    assert.ok(fs.lstatSync(modules).isSymbolicLink(), result.stderr);
    assert.equal(fs.readlinkSync(modules), path.join(f.main, 'node_modules'));
});
