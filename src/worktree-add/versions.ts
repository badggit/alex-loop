import { showText } from './text.ts';
import type { Deps } from './types.ts';

const MIN_NODE_MAJOR = 22;
const MIN_GIT_MAJOR = 2;
const MIN_GIT_MINOR = 29;
const NODE_VERSION = /^v?(\d+)\.\d+/u;
const GIT_VERSION = /^git version (\d+)\.(\d+)/u;
const GIT_PREFIX = 'git version ';

export function nodeVersionProblem(version: string): string | undefined {
    const match = NODE_VERSION.exec(version);
    const major = match?.[1] === undefined ? Number.NaN : Number(match[1]);
    return major >= MIN_NODE_MAJOR
        ? undefined
        : `Node ${String(MIN_NODE_MAJOR)} or newer is required, found ${showText(version)}`;
}

// The version word after "git version", or the whole first line when git printed something else.
function shownGitVersion(line: string): string {
    if (!line.startsWith(GIT_PREFIX)) {
        return showText(line);
    }
    const [word = ''] = line.slice(GIT_PREFIX.length).split(' ', 1);
    return showText(word);
}

export function gitVersionProblem(versionOutput: string): string | undefined {
    const [line = ''] = versionOutput.trim().split('\n', 1);
    const match = GIT_VERSION.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
        const major = Number(match[1]);
        const minor = Number(match[2]);
        if (major > MIN_GIT_MAJOR || (major === MIN_GIT_MAJOR && minor >= MIN_GIT_MINOR)) {
            return;
        }
    }
    return `git ${String(MIN_GIT_MAJOR)}.${String(MIN_GIT_MINOR)} or newer is required, found ${shownGitVersion(line)}`;
}

export async function checkGitVersion(deps: Deps, cwd: string): Promise<string | undefined> {
    const result = await deps.runner.run({ file: 'git', args: ['-C', cwd, '--version'] });
    if (result.spawnError !== undefined) {
        return 'git is required but was not found';
    }
    if (result.code !== 0) {
        const [line = ''] = result.stderr.trim().split('\n', 1);
        const detail = line.length > 0 ? line : `git exited with code ${String(result.code)}`;
        return `cannot run git --version: ${showText(detail)}`;
    }
    return gitVersionProblem(result.stdout);
}
