import { showText } from './text.ts';
import type { Unlinked } from './walk.ts';

export const REPORT_LIMIT = 10;

const KB = 1024;
const MB = KB * KB;
const GB = MB * KB;
const HINT = 'to share one with the main clone, run worktree-add --link PATH inside the worktree';

export function formatSize(bytes: number, partial = false): string {
    const mark = partial ? '+' : '';
    if (bytes < KB) {
        return `${String(bytes)} B${mark}`;
    }
    // The unit is chosen after rounding so a value just below a boundary reads as 1 of the next unit, not 1024.
    const kilobytes = Math.round(bytes / KB);
    if (kilobytes < KB) {
        return `${String(kilobytes)} KB${mark}`;
    }
    const megabytes = Math.round(bytes / MB);
    if (megabytes < KB) {
        return `${String(megabytes)} MB${mark}`;
    }
    return `${(bytes / GB).toFixed(1)} GB${mark}`;
}

function bySizeThenPath(left: Unlinked, right: Unlinked): number {
    if (left.bytes !== right.bytes) {
        return right.bytes - left.bytes;
    }
    if (left.rel === right.rel) {
        return 0;
    }
    return left.rel < right.rel ? -1 : 1;
}

export function notLinkedLine(entries: readonly Unlinked[]): string | undefined {
    if (entries.length === 0) {
        return;
    }
    const sorted = entries.toSorted(bySizeThenPath);
    const named = sorted
        .slice(0, REPORT_LIMIT)
        .map((entry) => `${showText(entry.rel)} (${formatSize(entry.bytes, entry.partial)})`)
        .join(', ');
    const rest = sorted.length - REPORT_LIMIT;
    const more = rest > 0 ? ` and ${String(rest)} more` : '';
    return `not linked: ${named}${more}; ${HINT}`;
}
