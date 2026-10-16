import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { assignDependencies, type WorkspaceCheck } from '../../src/worktree-add/assign.ts';
import { isWorkspaceMember, type Project, type WorkspaceSpecs } from '../../src/worktree-add/discover.ts';

import { tempRoot } from './support/tmp.ts';

const ROOT_JS: Project = { dir: '', ecosystem: 'js', lockNames: ['package-lock.json'] };
const DEMO_JS: Project = { dir: 'examples/demo', ecosystem: 'js', lockNames: ['pnpm-lock.yaml'] };
const API_UV: Project = { dir: 'services/api', ecosystem: 'uv', lockNames: ['uv.lock'] };
const NO_WORKSPACE: WorkspaceCheck = () => false;
const PACKAGES_WORKSPACE: WorkspaceCheck = (project, folder) => project.dir === '' && folder.startsWith('packages/');

await test('a root JS project owns node_modules folders below it and a folderless project is not auto', () => {
    const assignment = assignDependencies(
        [ROOT_JS, DEMO_JS],
        ['node_modules', 'packages/a/node_modules'],
        PACKAGES_WORKSPACE
    );
    assert.deepEqual(assignment, {
        projects: [
            { ...ROOT_JS, depRels: ['node_modules', 'packages/a/node_modules'], linkOnly: [], auto: true },
            { ...DEMO_JS, depRels: [], linkOnly: [], auto: false },
        ],
        orphans: [],
    });
});

await test('a nested JS project takes its own node_modules ahead of the root', () => {
    const assignment = assignDependencies(
        [ROOT_JS, DEMO_JS],
        ['node_modules', 'examples/demo/node_modules'],
        NO_WORKSPACE
    );
    assert.deepEqual(
        assignment.projects.map((project) => [project.dir, project.depRels, project.auto]),
        [
            ['', ['node_modules'], true],
            ['examples/demo', ['examples/demo/node_modules'], true],
        ]
    );
});

await test('a uv project installs only its own .venv and reports every other environment', () => {
    const assignment = assignDependencies(
        [API_UV],
        ['services/api/.venv', 'services/api/venv', 'services/api/tools/.venv'],
        NO_WORKSPACE
    );
    assert.deepEqual(assignment, {
        projects: [
            {
                ...API_UV,
                depRels: ['services/api/.venv'],
                linkOnly: ['services/api/venv', 'services/api/tools/.venv'],
                auto: true,
            },
        ],
        orphans: [],
    });
});

await test('a uv project with only report-only environments is still auto', () => {
    const assignment = assignDependencies([API_UV], ['services/api/venv'], NO_WORKSPACE);
    assert.deepEqual(assignment.projects[0], {
        ...API_UV,
        depRels: [],
        linkOnly: ['services/api/venv'],
        auto: true,
    });
});

await test('folders without an owner of their ecosystem are orphans', () => {
    const assignment = assignDependencies(
        [ROOT_JS, API_UV],
        ['.venv', 'node_modules', 'services/api/.venv'],
        NO_WORKSPACE
    );
    assert.deepEqual(assignment.orphans, ['.venv']);

    const noJs = assignDependencies([API_UV], ['web/node_modules', 'services/api/node_modules'], NO_WORKSPACE);
    assert.deepEqual(noJs.orphans, ['web/node_modules', 'services/api/node_modules']);
    assert.deepEqual(noJs.projects, [{ ...API_UV, depRels: [], linkOnly: [], auto: false }]);
});

await test('a JS project does not own node_modules in a sibling folder with a shared prefix', () => {
    const assignment = assignDependencies([DEMO_JS], ['examples/demo-two/node_modules'], NO_WORKSPACE);
    assert.deepEqual(assignment.orphans, ['examples/demo-two/node_modules']);
    assert.equal(assignment.projects[0]?.auto, false);
});

await test('a root JS project with no folders is still auto', () => {
    assert.deepEqual(assignDependencies([ROOT_JS], [], NO_WORKSPACE), {
        projects: [{ ...ROOT_JS, depRels: [], linkOnly: [], auto: true }],
        orphans: [],
    });
});

await test('a root uv project is auto and owns the root .venv', () => {
    const rootUv: Project = { dir: '', ecosystem: 'uv', lockNames: ['uv.lock'] };
    assert.deepEqual(assignDependencies([rootUv], ['.venv'], NO_WORKSPACE), {
        projects: [{ ...rootUv, depRels: ['.venv'], linkOnly: [], auto: true }],
        orphans: [],
    });
});

await test('empty inputs give an empty assignment', () => {
    assert.deepEqual(assignDependencies([], [], NO_WORKSPACE), { projects: [], orphans: [] });
});

await test('a nested node_modules outside the workspace of the root is an orphan', () => {
    const assignment = assignDependencies(
        [ROOT_JS],
        ['node_modules', 'packages/a/node_modules', 'tools/x/node_modules'],
        PACKAGES_WORKSPACE
    );
    assert.deepEqual(assignment, {
        projects: [{ ...ROOT_JS, depRels: ['node_modules', 'packages/a/node_modules'], linkOnly: [], auto: true }],
        orphans: ['tools/x/node_modules'],
    });
    const plain = assignDependencies([ROOT_JS], ['node_modules', 'packages/a/node_modules'], NO_WORKSPACE);
    assert.deepEqual(plain.projects[0]?.depRels, ['node_modules']);
    assert.deepEqual(plain.orphans, ['packages/a/node_modules']);
});

await test('the workspace check is asked only about nested node_modules folders', () => {
    const asked: string[] = [];
    const check: WorkspaceCheck = (project, folder) => {
        asked.push(`${project.dir}|${folder}`);
        return true;
    };
    assignDependencies(
        [ROOT_JS, DEMO_JS, API_UV],
        ['node_modules', 'examples/demo/node_modules', 'examples/demo/lib/node_modules', 'services/api/tools/.venv'],
        check
    );
    assert.deepEqual(asked, ['examples/demo|examples/demo/lib']);
});

function writeFiles(root: string, files: Readonly<Record<string, string>>): void {
    for (const [rel, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), text);
    }
}

await test('workspace members come from package.json workspaces in both forms and from pnpm-workspace.yaml', (t) => {
    const root = tempRoot(t);
    writeFiles(root, {
        'package.json': '{"workspaces":["packages/*","libs/**","!packages/skip"]}\n',
        'web/package.json': '{"workspaces":{"packages":["apps/site"]}}\n',
        'pn/package.json': '{"name":"pn"}\n',
        'pn/pnpm-workspace.yaml': "packages:\n  - 'mods/*'\n",
    });
    const rootJs: Project = { dir: '', ecosystem: 'js', lockNames: ['package-lock.json'] };
    const web: Project = { dir: 'web', ecosystem: 'js', lockNames: ['yarn.lock'] };
    const pn: Project = { dir: 'pn', ecosystem: 'js', lockNames: ['pnpm-lock.yaml'] };
    const bare: Project = { dir: 'bare', ecosystem: 'js', lockNames: ['package-lock.json'] };
    const cases: readonly (readonly [Project, string, boolean])[] = [
        [rootJs, 'packages/a', true],
        [rootJs, 'packages/a/b', false],
        [rootJs, 'packages/skip', false],
        [rootJs, 'libs/x/y', true],
        [rootJs, 'tools', false],
        [web, 'web/apps/site', true],
        [web, 'web/apps/other', false],
        [pn, 'pn/mods/m', true],
        [pn, 'pn/other', false],
        [bare, 'bare/sub', false],
    ];
    for (const [project, folder, expected] of cases) {
        assert.equal(isWorkspaceMember(root, project, folder), expected, `${project.dir}|${folder}`);
    }
});

await test('a shared specs map reads the workspace manifests of a project once', (t) => {
    const root = tempRoot(t);
    writeFiles(root, { 'package.json': '{"workspaces":["packages/*"]}\n' });
    const project: Project = { dir: '', ecosystem: 'js', lockNames: ['package-lock.json'] };
    const specs: WorkspaceSpecs = new Map();
    assert.equal(isWorkspaceMember(root, project, 'packages/a', specs), true);
    fs.rmSync(path.join(root, 'package.json'));
    assert.equal(isWorkspaceMember(root, project, 'packages/b', specs), true);
    assert.equal(isWorkspaceMember(root, project, 'packages/b'), false);
});
