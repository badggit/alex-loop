import { stderrLogger } from './log.ts';
import { nodeVersionProblem } from './versions.ts';

// The dynamic import keeps every other module from running before the version check; esbuild inlines it.
const problem = nodeVersionProblem(process.versions.node);
if (problem === undefined) {
    const { main } = await import('./main.ts');
    await main();
} else {
    stderrLogger().error(problem);
    process.exitCode = 1;
}
