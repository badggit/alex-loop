import type { CommandResult } from './types.ts';

const FIRST_PRINTABLE = 0x20;
const DELETE = 0x7f;

function isControlCharacter(character: string): boolean {
    const code = character.codePointAt(0) ?? 0;
    return code < FIRST_PRINTABLE || code === DELETE;
}

// A line break or another control character is unsafe to log and to write as one line.
export function hasControlCharacter(value: string): boolean {
    for (const character of value) {
        if (isControlCharacter(character)) {
            return true;
        }
    }
    return false;
}

// For paths and names inside log messages: every control character becomes ?, nothing else changes.
export function showText(value: string): string {
    let shown = '';
    for (const character of value) {
        shown += isControlCharacter(character) ? '?' : character;
    }
    return shown;
}

// The first stderr line of a failed git command, or its spawn error or exit code when stderr is empty.
export function failureLine(result: CommandResult): string {
    if (result.spawnError !== undefined) {
        return result.spawnError;
    }
    const [first = ''] = result.stderr.trim().split('\n', 1);
    return first.length > 0 ? first : `git exited with code ${String(result.code)}`;
}

// Never throws: a thrown value whose conversion to text throws is shown as an unknown error.
export function messageOf(error: unknown): string {
    try {
        return showText(error instanceof Error ? error.message : String(error));
    } catch {
        return 'unknown error';
    }
}
