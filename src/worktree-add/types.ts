export type Env = Readonly<Record<string, string | undefined>>;

export interface CommandRequest {
    file: string;
    args: readonly string[];
    cwd?: string;
}

// code is 128+N when the child was killed by signal N and 127 when spawning failed.
export interface CommandResult {
    code: number;
    stdout: string;
    stderr: string;
    spawnError?: string;
}

export interface CommandRunner {
    run(_request: CommandRequest): Promise<CommandResult>;
    terminateAll(): Promise<void>;
}

export interface Logger {
    info(_message: string): void;
    warn(_message: string): void;
    error(_message: string): void;
}

export interface TempRegistry {
    add(_path: string): void;
    remove(_path: string): void;
    removeAll(): void;
}

export interface Deps {
    runner: CommandRunner;
    log: Logger;
    temps: TempRegistry;
    platform: NodeJS.Platform;
    pid: number;
}

// Canonical absolute top levels; main equals current when mainFound is false.
export interface RepoLayout {
    current: string;
    main: string;
    mainFound: boolean;
    linked: boolean;
}

export interface WorktreeTarget {
    suffix: string;
    name: string;
    branch: string;
    parent: string;
    parentMissing: boolean;
    path: string;
}

export interface WorktreeEntry {
    path: string;
    branch: string | undefined;
    bare: boolean;
    detached: boolean;
    locked: boolean;
    prunable: boolean;
}

export interface RegisteredWorktree {
    path: string;
    branch: string | undefined;
    bare: boolean;
    detached: boolean;
    locked: boolean;
    missing: boolean;
}

export interface TargetFacts {
    target: string;
    branch: string;
    targetIsMain: boolean;
    targetState: 'absent' | 'symlink' | 'present' | 'unreadable';
    registered: RegisteredWorktree | undefined;
    holder: string | undefined;
    localBranch: boolean;
    remoteMatches: readonly string[];
}

export type Decision =
    | { kind: 'reuse' }
    | { kind: 'checkout' }
    | { kind: 'track'; remote: string }
    | { kind: 'create' }
    | { kind: 'refuse'; reason: string };

export interface StartPoint {
    sha: string;
    label: string;
}

export type ApplyStep =
    | { kind: 'reuse' }
    | { kind: 'checkout' }
    | { kind: 'track'; remote: string }
    | { kind: 'create'; start: StartPoint };

export interface GateRequest {
    main: string;
    worktree: string;
    rel: string;
}

export type GateResult = { kind: 'available' } | { kind: 'unavailable'; reason: string };

export interface CloneGate {
    check(_deps: Deps, _request: GateRequest): Promise<GateResult>;
}

export type CopyOutcome = 'copied' | 'failed';

export type CloneOutcome =
    { kind: 'cloned' } | { kind: 'unavailable'; reason: string } | { kind: 'failed'; reason: string };

export interface EntryTransfer {
    copyEntry(_rel: string): Promise<CopyOutcome>;
    cloneDependency(_rel: string): Promise<CloneOutcome>;
}

export type Outcome =
    | { kind: 'ok'; path: string }
    | { kind: 'refused'; reason: string }
    | { kind: 'usage'; message: string }
    | { kind: 'help' };
