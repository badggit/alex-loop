import type { Ecosystem, Project } from './discover.ts';
import { JS_DEPS, UV_VENV } from './paths.ts';

export interface AssignedProject extends Project {
    depRels: readonly string[];
    // Python environments inside the uv project other than its root .venv: never installed, linked like an orphan.
    linkOnly: readonly string[];
    auto: boolean;
}

export interface Assignment {
    projects: readonly AssignedProject[];
    orphans: readonly string[];
}

function splitRel(rel: string): { parent: string; name: string } {
    const slash = rel.lastIndexOf('/');
    return slash === -1 ? { parent: '', name: rel } : { parent: rel.slice(0, slash), name: rel.slice(slash + 1) };
}

export function isAtOrAbove(dir: string, folder: string): boolean {
    return dir === '' || folder === dir || folder.startsWith(`${dir}/`);
}

// The nearest owner is the project with the longest folder among those at or above the given folder.
function nearestOwner(projects: readonly Project[], ecosystem: Ecosystem, folder: string): number | undefined {
    let best: number | undefined;
    for (const [index, project] of projects.entries()) {
        if (project.ecosystem !== ecosystem || !isAtOrAbove(project.dir, folder)) {
            continue;
        }
        const current = best === undefined ? undefined : projects[best];
        if (current === undefined || project.dir.length > current.dir.length) {
            best = index;
        }
    }
    return best;
}

// Answers whether FOLDER, relative to the worktree, is a workspace member of PROJECT.
export type WorkspaceCheck = (_project: Project, _folder: string) => boolean;

// Assigns each main-clone dependency folder to the project that owns it; everything else is Python by convention.
// A node_modules below a JS project but not in its own folder is the project's only when that folder is one of its
// workspace members, since a single install there never makes it.
export function assignDependencies(
    projects: readonly Project[],
    depRels: readonly string[],
    isMember: WorkspaceCheck
): Assignment {
    const installs: string[][] = projects.map(() => []);
    const links: string[][] = projects.map(() => []);
    const orphans: string[] = [];
    for (const rel of depRels) {
        const { parent, name } = splitRel(rel);
        const ecosystem: Ecosystem = name === JS_DEPS ? 'js' : 'uv';
        const owner = nearestOwner(projects, ecosystem, parent);
        const project = owner === undefined ? undefined : projects[owner];
        if (
            owner === undefined ||
            project === undefined ||
            (ecosystem === 'js' && parent !== project.dir && !isMember(project, parent))
        ) {
            orphans.push(rel);
            continue;
        }
        const installed = ecosystem === 'js' || (name === UV_VENV && parent === project.dir);
        (installed ? installs : links)[owner]?.push(rel);
    }
    const assigned = projects.map((project, index): AssignedProject => {
        const ownDeps = installs[index] ?? [];
        const ownLinks = links[index] ?? [];
        return {
            ...project,
            depRels: ownDeps,
            linkOnly: ownLinks,
            auto: project.dir === '' || ownDeps.length > 0 || ownLinks.length > 0,
        };
    });
    return { projects: assigned, orphans };
}
