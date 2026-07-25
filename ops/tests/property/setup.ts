// Property-lane global config (T-03): seed volume is driven by FC_NUM_RUNS.
// Default 500 local; PR workflow sets 1000; nightly sets 10000. fast-check does not read
// env vars itself — without this file the workflows shouted into the void and every lane
// silently ran fast-check's built-in default of 100. One console line makes the applied
// volume visible in CI logs forever.
import * as fc from 'fast-check';

const DEFAULT_RUNS = 500;
const fromEnv = Number(process.env['FC_NUM_RUNS'] ?? DEFAULT_RUNS);
const numRuns = Number.isSafeInteger(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_RUNS;

fc.configureGlobal({ numRuns });
console.info(`fast-check: numRuns=${numRuns} (FC_NUM_RUNS)`);
