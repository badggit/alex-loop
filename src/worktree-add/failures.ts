import { showText } from './text.ts';

export type FailureClass =
    | 'authentication'
    | 'access-denied'
    | 'network'
    | 'lock-out-of-sync'
    | 'lock-changed'
    | 'wrong-version'
    | 'sandbox'
    | 'tool-missing'
    | 'timeout'
    | 'other';

export interface FailureInput {
    output: string;
    code: number;
    timedOut: boolean;
    lockChanged: boolean;
}

export interface FailureReport {
    manager: string;
    where: string;
    failure: FailureClass;
    keyLines: readonly string[];
    missing: readonly string[];
    command: string;
    logPath: string | undefined;
    logProblem: string | undefined;
    lifecycleStep: string | undefined;
    silent: boolean;
}

const WRONG_VERSION_PATTERNS = [/\bERR_PNPM_LOCKFILE_BREAKING_CHANGE\b/u, /lockfile[^\n]*breaking change/iu] as const;

// Corepack also prints these on info lines, so they rank below authentication, access-denied and sandbox.
const VERSION_MENTION_PATTERNS = [/\bpackageManager\b/u, /\bcorepack\b/iu] as const;

const AUTH_CODE_PATTERNS = [
    /\bE401\b/u,
    /\bENEEDAUTH\b/u,
    /\bERR_PNPM_FETCH_401\b/u,
    /\bYN0041\b/u,
    /\b401 Unauthori[sz]ed\b/iu,
    /\bUnauthori[sz]ed - 401\b/iu,
    /\b(?:HTTP(?:\/[\d.]+)?|status(?: code)?|GET|PUT|POST)[\s:]+401\b/iu,
] as const;

const AUTH_MESSAGE_PATTERNS = [
    /authenticat/iu,
    /unauthori[sz]ed/iu,
    /\btoken\b/iu,
    /\blog(?:ged)? ?in\b/iu,
    /credential/iu,
] as const;

const E403_PATTERN = /\bE403\b/u;

const ACCESS_DENIED_PATTERNS = [
    E403_PATTERN,
    /\bERR_PNPM_FETCH_403\b/u,
    /\b403 Forbidden\b/iu,
    /\bForbidden - 403\b/iu,
    /\b(?:HTTP(?:\/[\d.]+)?|status(?: code)?|GET|PUT|POST)[\s:]+403\b/iu,
] as const;

const SANDBOX_PATTERNS = [/\bEACCES\b/u, /\bEPERM\b/u, /\bEROFS\b/u] as const;

const LOCK_OUT_OF_SYNC_PATTERNS = [
    /\bEUSAGE\b/u,
    /\bERR_PNPM_OUTDATED_LOCKFILE\b/u,
    /Your lockfile needs to be updated/u,
    /\bYN0028\b/u,
    /The lockfile would have been modified/u,
    /needs to be updated/u,
] as const;

const NETWORK_PATTERNS = [
    /\bECONNREFUSED\b/u,
    /\bENOTFOUND\b/u,
    /\bE?TIMEDOUT\b/u,
    /\bESOCKETTIMEDOUT\b/u,
    /\bEAI_AGAIN\b/u,
    /\bECONNRESET\b/u,
    /\bEHOSTUNREACH\b/u,
    /\bENETUNREACH\b/u,
    /\bFETCH_ERROR\b/u,
    /network timeout at:/u,
    /socket hang up/iu,
    /\btimed out\b/iu,
    /Will retry/iu,
    /\bretrying\b/iu,
] as const;

const RETRY_PATTERNS = [/Will retry/iu, /\bretrying\b/iu, /\bETIMEDOUT\b/u, /\bECONNRESET\b/u] as const;

const NPM_CODE_LINE = /^npm (?:error|ERR!) code (\S+)/u;
const NPM_MESSAGE_LINE = /^npm (?:error|ERR!) (.+)$/u;
const UV_KEY_LINE = /^(?:error|hint):/u;
const NPM_SCRIPT_HEADER = /^> (\S+@\S+) (\S+)/u;
const PNPM_SCRIPT_LINE = /^(\S+) (preinstall|install|postinstall|prepare)\$/u;
const NODE_MODULES = 'node_modules/';
const TAIL_LINES = 5;

const CLASS_TEXT: Readonly<Record<FailureClass, string>> = {
    authentication: 'authentication failed',
    'access-denied': 'access denied',
    network: 'network unreachable',
    'lock-out-of-sync': 'lock file out of sync',
    'lock-changed': 'the install changed the lock file',
    'wrong-version': 'wrong manager version',
    sandbox: 'blocked by a sandbox',
    'tool-missing': 'tool missing',
    timeout: 'timed out',
    other: 'failed',
};

const NEXT_STEP: Readonly<Record<FailureClass, string>> = {
    authentication: 'log in to the registry or refresh the token',
    'access-denied': 'check the token, or a proxy or sandbox that blocks the registry',
    network: 'check the connection or VPN',
    'lock-out-of-sync': 'update the lock file in the branch',
    'lock-changed': 'use the manager version the project pins',
    'wrong-version': 'enable corepack or install the named version',
    sandbox: 'rerun outside the sandbox or with network and home access',
    'tool-missing': 'install the manager (or enable corepack)',
    timeout: 'give the install more time',
    other: 'see the key error lines and the log file',
};

const SILENT_TIMEOUT_HINT = 'no output at all, often a network that silently drops packets (VPN or proxy)';

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
    return patterns.some((pattern) => pattern.test(text));
}

function isAuthentication(output: string): boolean {
    if (matchesAny(output, AUTH_CODE_PATTERNS)) {
        return true;
    }
    return E403_PATTERN.test(output) && matchesAny(output, AUTH_MESSAGE_PATTERNS);
}

// A non-zero exit or a timeout with a changed lock file falls through, so a real error is never hidden as lock-changed.
export function classifyFailure(input: FailureInput): FailureClass {
    const { output, code, timedOut, lockChanged } = input;
    if (lockChanged && code === 0 && !timedOut) {
        return 'lock-changed';
    }
    if (matchesAny(output, WRONG_VERSION_PATTERNS)) {
        return 'wrong-version';
    }
    if (isAuthentication(output)) {
        return 'authentication';
    }
    if (matchesAny(output, ACCESS_DENIED_PATTERNS)) {
        return 'access-denied';
    }
    if (matchesAny(output, SANDBOX_PATTERNS)) {
        return 'sandbox';
    }
    if (matchesAny(output, VERSION_MENTION_PATTERNS)) {
        return 'wrong-version';
    }
    if (matchesAny(output, LOCK_OUT_OF_SYNC_PATTERNS)) {
        return 'lock-out-of-sync';
    }
    if (timedOut) {
        return matchesAny(output, RETRY_PATTERNS) ? 'network' : 'timeout';
    }
    if (matchesAny(output, NETWORK_PATTERNS)) {
        return 'network';
    }
    return 'other';
}

export function classText(failure: FailureClass): string {
    return CLASS_TEXT[failure];
}

function outputLines(output: string): string[] {
    return output
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

function npmKeyLine(lines: readonly string[]): string | undefined {
    const index = lines.findIndex((line) => NPM_CODE_LINE.test(line));
    if (index === -1) {
        return undefined;
    }
    const code = NPM_CODE_LINE.exec(lines[index] ?? '')?.[1] ?? '';
    const message = lines
        .slice(index + 1)
        .map((line) => NPM_MESSAGE_LINE.exec(line)?.[1])
        .find((text) => text !== undefined);
    return message === undefined ? `npm error code ${code}` : `npm error code ${code}: ${message}`;
}

// npm gives one joined code line, uv its error and hint lines, anything else its last 5 non-empty lines.
export function keyErrorLines(output: string): string[] {
    const lines = outputLines(output);
    const npm = npmKeyLine(lines);
    if (npm !== undefined) {
        return [npm];
    }
    const uv = lines.filter((line) => UV_KEY_LINE.test(line));
    if (uv.length > 0) {
        return uv.slice(-TAIL_LINES);
    }
    return lines.slice(-TAIL_LINES);
}

function pnpmPackageName(prefix: string): string {
    if (prefix === '.') {
        return 'the project';
    }
    const index = prefix.lastIndexOf(NODE_MODULES);
    return index === -1 ? prefix : prefix.slice(index + NODE_MODULES.length);
}

function lifecycleStepOf(line: string): string | undefined {
    const npm = NPM_SCRIPT_HEADER.exec(line);
    if (npm !== null) {
        return `${npm[2] ?? ''} of ${npm[1] ?? ''}`;
    }
    const pnpm = PNPM_SCRIPT_LINE.exec(line);
    if (pnpm !== null) {
        return `${pnpm[2] ?? ''} of ${pnpmPackageName(pnpm[1] ?? '')}`;
    }
    return undefined;
}

// The last npm script header or pnpm lifecycle script line, for example "postinstall of demo@1.0.0".
export function lastLifecycleStep(output: string): string | undefined {
    const lines = outputLines(output);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const step = lifecycleStepOf(lines[index] ?? '');
        if (step !== undefined) {
            return step;
        }
    }
    return undefined;
}

// silent is true when the last attempt printed nothing but whitespace.
export function nextStep(failure: FailureClass, silent: boolean): string {
    const step = NEXT_STEP[failure];
    return failure === 'timeout' && silent ? `${step}; ${SILENT_TIMEOUT_HINT}` : step;
}

function headline(report: FailureReport): string {
    const where = report.where === '' ? '' : ` in ${showText(report.where)}`;
    const keys = report.keyLines.length === 0 ? '' : ` (${report.keyLines.map((line) => showText(line)).join('; ')})`;
    return `cannot install dependencies with ${showText(report.manager)}${where}: ${classText(report.failure)}${keys}`;
}

function logLine(report: FailureReport): string | undefined {
    const manager = showText(report.manager);
    if (report.logPath !== undefined) {
        return `full ${manager} output: ${showText(report.logPath)}`;
    }
    if (report.logProblem !== undefined) {
        return `cannot save the ${manager} output: ${showText(report.logProblem)}`;
    }
    return undefined;
}

export function failureLines(report: FailureReport): string[] {
    const lines = [headline(report)];
    for (const folder of report.missing) {
        lines.push(`${showText(folder)} is left missing: code that needs it fails until it is installed`);
    }
    const step = nextStep(report.failure, report.silent);
    lines.push(`to install: ${showText(step)}, then run in the worktree: ${showText(report.command)}`);
    const log = logLine(report);
    if (log !== undefined) {
        lines.push(log);
    }
    if (report.failure === 'timeout' && report.lifecycleStep !== undefined) {
        lines.push(`last step seen: ${showText(report.lifecycleStep)}`);
    }
    return lines;
}
