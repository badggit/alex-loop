import { hasControlCharacter, showText } from './text.ts';

export type ParsedArgs =
    | { kind: 'ok'; suffix: string; parent: string | undefined; install: boolean }
    | { kind: 'help' }
    | { kind: 'usage'; message: string };

type ValueOption = '--suffix' | '--parent';

const NO_INSTALL = '--no-install';

const MAX_SUFFIX = 100;
const SUFFIX_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;

function isValueOption(arg: string): arg is ValueOption {
    return arg === '--suffix' || arg === '--parent';
}

// The character rule alone still allows names git refuses as refs, so those endings and ".." are refused here too.
function suffixProblem(suffix: string): string | undefined {
    const shown = showText(suffix);
    if (suffix.length === 0 || suffix.length > MAX_SUFFIX) {
        return `the suffix must be 1 to ${String(MAX_SUFFIX)} characters long: ${shown}`;
    }
    if (!SUFFIX_PATTERN.test(suffix)) {
        return `the suffix must start with a-z or 0-9 and contain only a-z, 0-9, ".", "_" or "-": ${shown}`;
    }
    if (suffix.includes('..') || suffix.endsWith('.') || suffix.endsWith('.lock')) {
        return `the suffix must not contain ".." or end in "." or ".lock": ${shown}`;
    }
    return;
}

// A leading ~ or ~/ becomes home; every other ~ form (~user) is refused instead of guessed.
function expandParent(value: string, home: string): { ok: true; parent: string } | { ok: false; message: string } {
    if (value.length === 0) {
        return { ok: false, message: 'the --parent value must not be empty' };
    }
    if (hasControlCharacter(value)) {
        return { ok: false, message: `the parent folder contains a control character: ${showText(value)}` };
    }
    if (value === '~' || value === '~/') {
        return { ok: true, parent: home };
    }
    // Joined as text without normalizing, so a later ".." is resolved physically.
    if (value.startsWith('~/')) {
        return { ok: true, parent: `${home}/${value.slice(2)}` };
    }
    if (value.startsWith('~')) {
        return { ok: false, message: `only ~ and ~/ are expanded: ${showText(value)}` };
    }
    return { ok: true, parent: value };
}

function usage(message: string): ParsedArgs {
    return { kind: 'usage', message };
}

export function parseArgs(argv: readonly string[], home: string): ParsedArgs {
    if (argv.includes('--help')) {
        return { kind: 'help' };
    }
    const values: Partial<Record<ValueOption, string>> = {};
    let install = true;
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index] ?? '';
        if (arg === NO_INSTALL) {
            if (!install) {
                return usage(`${NO_INSTALL} can be given only once`);
            }
            install = false;
            continue;
        }
        if (!isValueOption(arg)) {
            return usage(
                arg.startsWith('-') ? `unknown option: ${showText(arg)}` : `unexpected argument: ${showText(arg)}`
            );
        }
        if (values[arg] !== undefined) {
            return usage(`${arg} can be given only once`);
        }
        const value = argv[index + 1];
        if (value === undefined) {
            return usage(`missing value for ${arg}`);
        }
        if (value.startsWith('--')) {
            return usage(`missing value for ${arg}: got the option ${showText(value)}`);
        }
        values[arg] = value;
        index += 1;
    }
    const suffix = values['--suffix'];
    if (suffix === undefined) {
        return usage('--suffix SUFFIX is required');
    }
    const problem = suffixProblem(suffix);
    if (problem !== undefined) {
        return usage(problem);
    }
    const parentValue = values['--parent'];
    if (parentValue === undefined) {
        return { kind: 'ok', suffix, parent: undefined, install };
    }
    const expanded = expandParent(parentValue, home);
    return expanded.ok ? { kind: 'ok', suffix, parent: expanded.parent, install } : usage(expanded.message);
}

export function usageText(): string {
    return [
        'Usage: worktree-add.mjs --suffix SUFFIX [--parent DIR] [--no-install]',
        '',
        'Creates or reuses the sibling git worktree MAIN-SUFFIX on the branch SUFFIX and prints its absolute path.',
        '',
        `  --suffix SUFFIX  1 to ${String(MAX_SUFFIX)} characters: a-z or 0-9 first, then a-z, 0-9, ".", "_" or "-"`,
        "  --parent DIR     folder for the worktree (default: the main clone's parent folder);",
        '                   a leading ~ or ~/ is expanded to the home folder, other ~ forms are refused',
        '  --no-install     skip the dependency installs; dependency folders are cloned or linked instead',
        '  --help           show this help',
        '',
        'Exit codes: 0 success (the path on stdout), 1 refusal or error, 2 wrong arguments.',
        '',
    ].join('\n');
}
