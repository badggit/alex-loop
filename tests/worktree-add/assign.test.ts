import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assignDependencies } from '../../src/worktree-add/assign.ts';
import type { Project } from '../../src/worktree-add/discover.ts';

const ROOT_JS: Project = { dir: '', ecosystem: 'js', lockNames: ['package-lock.json'] };
const DEMO_JS: Project = { dir: 'examples/demo', ecosystem: 'js', lockNames: ['pnpm-lock.yaml'] };
const API_UV: Project = { dir: 'services/api', ecosystem: 'uv', lockNames: ['uv.lock'] };

await test('a root JS project owns node_modules folders below it and a folderless project is not auto', () => {
    const assignment = assignDependencies([ROOT_JS, DEMO_JS], ['node_modules', 'packages/a/node_modules']);
    assert.deepEqual(assignment, {
        projects: [
            { ...ROOT_JS, depRels: ['node_modules', 'packages/a/node_modules'], reportOnly: [], auto: true },
            { ...DEMO_JS, depRels: [], reportOnly: [], auto: false },
        ],
        orphans: [],
    });
});

await test('a nested JS project takes its own node_modules ahead of the root', () => {
    const assignment = assignDependencies([ROOT_JS, DEMO_JS], ['node_modules', 'examples/demo/node_modules']);
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
        ['services/api/.venv', 'services/api/venv', 'services/api/tools/.venv']
    );
    assert.deepEqual(assignment, {
        projects: [
            {
                ...API_UV,
                depRels: ['services/api/.venv'],
                reportOnly: ['services/api/venv', 'services/api/tools/.venv'],
                auto: true,
            },
        ],
        orphans: [],
    });
});

await test('a uv project with only report-only environments is still auto', () => {
    const assignment = assignDependencies([API_UV], ['services/api/venv']);
    assert.deepEqual(assignment.projects[0], {
        ...API_UV,
        depRels: [],
        reportOnly: ['services/api/venv'],
        auto: true,
    });
});

await test('folders without an owner of their ecosystem are orphans', () => {
    const assignment = assignDependencies([ROOT_JS, API_UV], ['.venv', 'node_modules', 'services/api/.venv']);
    assert.deepEqual(assignment.orphans, ['.venv']);

    const noJs = assignDependencies([API_UV], ['web/node_modules', 'services/api/node_modules']);
    assert.deepEqual(noJs.orphans, ['web/node_modules', 'services/api/node_modules']);
    assert.deepEqual(noJs.projects, [{ ...API_UV, depRels: [], reportOnly: [], auto: false }]);
});

await test('a JS project does not own node_modules in a sibling folder with a shared prefix', () => {
    const assignment = assignDependencies([DEMO_JS], ['examples/demo-two/node_modules']);
    assert.deepEqual(assignment.orphans, ['examples/demo-two/node_modules']);
    assert.equal(assignment.projects[0]?.auto, false);
});

await test('a root JS project with no folders is still auto', () => {
    assert.deepEqual(assignDependencies([ROOT_JS], []), {
        projects: [{ ...ROOT_JS, depRels: [], reportOnly: [], auto: true }],
        orphans: [],
    });
});

await test('a root uv project is auto and owns the root .venv', () => {
    const rootUv: Project = { dir: '', ecosystem: 'uv', lockNames: ['uv.lock'] };
    assert.deepEqual(assignDependencies([rootUv], ['.venv']), {
        projects: [{ ...rootUv, depRels: ['.venv'], reportOnly: [], auto: true }],
        orphans: [],
    });
});

await test('empty inputs give an empty assignment', () => {
    assert.deepEqual(assignDependencies([], []), { projects: [], orphans: [] });
});
