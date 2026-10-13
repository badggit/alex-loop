import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';

// A fresh canonical folder under os.tmpdir(), removed when the test ends.
export function tempRoot(t: TestContext): string {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wta-test-')));
    t.after(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });
    return root;
}
