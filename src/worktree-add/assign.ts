import type { Ecosystem, Project } from './discover.ts';

export interface AssignedProject extends Project {
    depRels: readonly string[];
    reportOnly: readonly string[];
    auto: boolean;
}

export interface Assignment {
    projects: readonly AssignedProject[];
    orphans: readonly string[];
}

const JS_DEPS = 'node_modules';
const UV_VENV = '.venv';

function splitRel(rel: string): { parent: string; name: string } {
    const slash = rel.lastIndexOf('/');
    return slash === -1 ? { parent: '', name: rel } : { parent: rel.slice(0, slash), name: rel.slice(slash + 1) };
}

function isAtOrAbove(dir: string, folder: string): boolean {
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

// Assigns each main-clone dependency folder to the project that owns it; everything else is Python by convention.
export function assignDependencies(projects: readonly Project[], depRels: readonly string[]): Assignment {
    const installs: string[][] = projects.map(() => []);
    const reports: string[][] = projects.map(() => []);
    const orphans: string[] = [];
    for (const rel of depRels) {
        const { parent, name } = splitRel(rel);
        const ecosystem: Ecosystem = name === JS_DEPS ? 'js' : 'uv';
        const owner = nearestOwner(projects, ecosystem, parent);
        if (owner === undefined) {
            orphans.push(rel);
            continue;
        }
        const ownerDir = projects[owner]?.dir;
        const installed = ecosystem === 'js' || (name === UV_VENV && parent === ownerDir);
        (installed ? installs : reports)[owner]?.push(rel);
    }
    const assigned = projects.map((project, index): AssignedProject => {
        const ownDeps = installs[index] ?? [];
        const ownReports = reports[index] ?? [];
        return {
            ...project,
            depRels: ownDeps,
            reportOnly: ownReports,
            auto: project.dir === '' || ownDeps.length > 0 || ownReports.length > 0,
        };
    });
    return { projects: assigned, orphans };
}
