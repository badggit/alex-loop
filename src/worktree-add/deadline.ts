export const INSTALL_PHASE_MS = 450_000;
export const MIN_START_MS = 5000;

export interface Deadline {
    readonly phaseEndMs: number;
    remainingMs(): number;
    shareMs(_projectsLeft: number): number;
}

// shareMs splits the time left evenly, counting at least one project so a zero count never divides by zero.
export function createDeadline(startedMs: number, phaseMs: number, nowMs: () => number): Deadline {
    const phaseEndMs = startedMs + phaseMs;
    const remainingMs = (): number => Math.max(0, phaseEndMs - nowMs());
    return {
        phaseEndMs,
        remainingMs,
        shareMs: (projectsLeft) => Math.floor(remainingMs() / Math.max(1, projectsLeft)),
    };
}
