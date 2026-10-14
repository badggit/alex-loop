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
