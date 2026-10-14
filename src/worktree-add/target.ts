import path from 'node:path';

import { canonicalLoose, lstatOrUndefined } from './paths.ts';
import { hasControlCharacter, showText } from './text.ts';
import type { WorktreeTarget } from './types.ts';

export type TargetResult = { ok: true; target: WorktreeTarget } | { ok: false; code: 1 | 2; message: string };

// Kept unnormalized so canonicalLoose resolves ".." physically, the way mkdir would, not as text.
function joinedRaw(cwd: string, parentArg: string): string {
    return path.isAbsolute(parentArg) ? parentArg : `${cwd}/${parentArg}`;
}

// A relative parent comes from the caller's directory; nothing is created, and a non-directory parent is code 2.
export function deriveTarget(suffix: string, parentArg: string | undefined, cwd: string, main: string): TargetResult {
    const mainName = path.basename(main);
    if (hasControlCharacter(mainName)) {
        return {
            ok: false,
            code: 1,
            message: `the main folder name contains a control character: ${showText(main)}`,
        };
    }
    const parent = canonicalLoose(parentArg === undefined ? path.dirname(main) : joinedRaw(cwd, parentArg));
    const stats = lstatOrUndefined(parent);
    if (stats !== undefined && !stats.isDirectory()) {
        return {
            ok: false,
            code: 2,
            message: `the parent folder exists but is not a directory: ${showText(parent)}`,
        };
    }
    const name = `${mainName}-${suffix}`;
    return {
        ok: true,
        target: {
            suffix,
            name,
            branch: suffix,
            parent,
            parentMissing: stats === undefined,
            path: path.join(parent, name),
        },
    };
}
