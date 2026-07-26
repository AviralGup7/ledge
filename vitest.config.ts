// Test lanes (Constitution §13 T-02/T-03). Audit P0-5: --project unit/property referenced
// projects no config defined; this file is the missing definition.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const resolveFromRoot = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

// E1-T09 fix: string aliases left ".js"-suffixed specifiers (the src ESM convention)
// pointing at literal .js files that don't exist — vite's .js→.ts fallback does not
// apply after alias replacement. Regex aliases strip the suffix so vite's normal
// extension resolution finds the .ts source (tsc resolves both forms under bundler mode).
const LAYERS = [
  'shared-kernel',
  'domain',
  'application',
  'infrastructure',
  'surfaces',
  'roots',
] as const;

const layerAliases = LAYERS.flatMap((layer) => [
  {
    find: new RegExp(`^@/${layer}/(.*)\\.js$`),
    replacement: `${resolveFromRoot(`./src/${layer}`)}/$1`,
  },
  { find: new RegExp(`^@/${layer}$`), replacement: resolveFromRoot(`./src/${layer}`) },
  {
    find: new RegExp(`^@/${layer}/(.*)$`),
    replacement: `${resolveFromRoot(`./src/${layer}`)}/$1`,
  },
]);

const aliases = [
  ...layerAliases,
  {
    find: /^@\/testing\/(.*)\.js$/,
    replacement: `${resolveFromRoot('./ops/tests')}/$1`,
  },
  { find: /^@\/testing$/, replacement: resolveFromRoot('./ops/tests') },
  { find: /^@\/testing\/(.*)$/, replacement: `${resolveFromRoot('./ops/tests')}/$1` },
];

// Projects do not inherit root resolve in vitest 3 — each project carries its own copy.
const projectResolve = { alias: aliases };

export default defineConfig({
  test: {
    // E1-T08+: real suites exist. Empty suite = red gate (never green-by-absence again).
    passWithNoTests: false,
    globals: true, // matches tsconfig "types": ["vitest/globals"]
    coverage: {
      // T-02 floors activate with the first suites (E1-T08); provider wired now so the
      // ratchet is a one-line change, not a plumbing project.
      provider: 'v8',
      reporter: ['text', 'json-summary'],
    },
    projects: [
      {
        resolve: projectResolve,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'ops/tests/unit/**/*.test.ts'],
          // Property suites are their own lane (FC_NUM_RUNS setup); never double-run here.
          // Chaos suites are their own lane (E2-T09; EES §8 gate naming) — `pnpm test:chaos`.
          exclude: ['**/*.property.test.ts', '**/*.chaos.test.ts'],
        },
      },
      {
        resolve: projectResolve,
        test: {
          // E2-T09 · EES §8 chaos lane: kill-point matrix suites, the ops harness
          // (driver + corrupted-journal seeds + fault injection + G1 evidence).
          // Runs in ci:all (PR) and as the nightly 'chaos-harness' job (release gate).
          name: 'chaos',
          include: ['src/**/*.chaos.test.ts', 'ops/tests/chaos/**/*.test.ts'],
        },
      },
      {
        resolve: projectResolve,
        test: {
          name: 'property',
          include: ['src/**/*.property.test.ts', 'ops/tests/property/**/*.test.ts'],
          setupFiles: ['ops/tests/property/setup.ts'],
          // T-03: seed counts are driven by FC_NUM_RUNS (PR 1000 / nightly 10000), configured in workflows.
        },
      },
      {
        resolve: projectResolve,
        test: {
          // E1-T09 · ADR-032/EES §8: port contract suites — identical laws per adapter, PR-blocking.
          name: 'contract',
          include: ['ops/tests/contract/**/*.test.ts'],
        },
      },
      {
        resolve: projectResolve,
        test: {
          // E1-T11 · EES §8 security lane: boundary-validator fuzz, injection firewall proofs.
          name: 'security',
          include: ['ops/tests/security/**/*.test.ts'],
          setupFiles: ['ops/tests/property/setup.ts'], // fuzz volume follows FC_NUM_RUNS too
        },
      },
      {
        resolve: projectResolve,
        test: {
          // E7-T02 · EES §8 perf lane (nightly + release-gating, never PR): budget
          // gates §7.1, baseline regression compare (R-10), scaling law. Forks pool +
          // serialized files keep wall-clock honest; --expose-gc separates peak from
          // steady-state memory rows.
          name: 'perf',
          include: ['ops/tests/perf/**/*.test.ts'],
          pool: 'forks',
          poolOptions: {
            forks: {
              singleFork: true,
              execArgv: ['--expose-gc'],
            },
          },
          fileParallelism: false,
        },
      },
      {
        resolve: projectResolve,
        test: {
          // E6-T01 · real-restart e2e lane (roadmap E6-T01 completion evidence:
          // "real-restart e2e; exact catalog copy"; EES §6 e2e line: puppeteer-class,
          // load-unpacked, PR-blocking smoke + full nightly). DECLARED LONG-RUNNING:
          // every scenario is a full Chromium boot ⇒ SIGKILL ⇒ relaunch cycle, so
          // the 240s timeout supersedes the 60s single-test house law for this lane.
          // Never rides default `pnpm test` (unit project-scoped by law) nor ci:all
          // today — CI wiring (PR smoke + nightly job) is the EES lane's own row.
          name: 'e2e',
          include: ['ops/tests/e2e/**/*.test.ts'],
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          fileParallelism: false,
          testTimeout: 240_000,
          hookTimeout: 240_000,
        },
      },
    ],
  },
});
