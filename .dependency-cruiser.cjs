// Import law (Blueprint §4 / Constitution §3). Violations are merge-blockers [CI].
// Audit P0-3: this file was renamed .js -> .cjs — "type":"module" made the old .js unloadable,
// which silently disabled the entire import constitution. Do not rename back.
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'A-06',
      from: {},
      to: { circular: true },
    },
    {
      name: 'domain-is-an-island',
      severity: 'error',
      comment: 'A-01 domain imports only shared-kernel',
      from: { path: '^src/domain' },
      to: { path: '^src/(?!shared-kernel)(?!domain).+' },
    },
    {
      name: 'kernel-imports-nothing',
      severity: 'error',
      comment: 'shared-kernel is zero-dep',
      from: { path: '^src/shared-kernel' },
      to: { path: '^src/(?!shared-kernel).+' },
    },
    {
      name: 'application-never-touches-infrastructure',
      severity: 'error',
      comment: 'Application consumes ports, never adapters',
      from: { path: '^src/application' },
      to: { path: '^src/infrastructure' },
    },
    {
      name: 'surfaces-are-authority-free',
      severity: 'error',
      comment: 'A-05: surfaces only see application contracts/hub',
      from: { path: '^src/surfaces' },
      to: { pathNot: '^src/(application/(contracts|hub)|surfaces/components)|^node_modules' },
    },
    {
      // Audit P1-G3 / probe P6 — ADR-005 single-writer: only the command plane
      // (application + roots + the journal/storage/recovery/projections family itself)
      // may import the durable write path. Adapters, AI, importers, sync, diagnostics,
      // surfaces, domain and kernel must go through application ports.
      name: 'writer-concentration',
      severity: 'error',
      comment:
        'ADR-005 single writer (durable-write family: journal/storage/recovery/projections/intents/snapshots — snapshots per docs/adr-notes/ADR-005b-T08-snapshots-durable-family.md)',
      from: {
        pathNot:
          '^src/(application|roots|infrastructure/(journal|storage|recovery|projections|intents|snapshots))',
      },
      to: { path: '^src/infrastructure/(journal|storage)' },
    },
    // REMOVED (audit remediation, validated empirically 2026-07-24):
    //  * 'no-chrome-outside-adapters' (dependencyTypes:core) — never fired; ambient `chrome` has no
    //    import statement to graph. A-02 is enforced in ESLint (scoped no-restricted-globals).
    //  * 'not-to-unresolvable' — dependency-cruiser's cruise-time schema rejects `unresolvable`
    //    inside forbidden.to (despite --validate accepting it). Phantom imports like
    //    `import 'chrome'` are instead caught fail-closed by typecheck + the bundle build
    //    (rollup cannot resolve 'chrome'; TS cannot type it under verbatimModuleSyntax).
    // Do not re-add either without a depcruise version bump + a probe proving it fires.
    {
      name: 'storage-quarantined',
      severity: 'error',
      comment: 'D-03/A-03 Dexie lives only in infrastructure/storage',
      from: { path: '^src/(?!infrastructure/storage).+' },
      // Layout-proof: matches both npm (node_modules/dexie/...) and pnpm
      // (node_modules/.pnpm/dexie@x/node_modules/dexie/...) real paths (audit remediation #17).
      to: { path: '(^|/)node_modules/dexie(/|$)' },
    },
    {
      name: 'ai-cannot-mutate',
      severity: 'error',
      comment: 'A-04 / ADR-041 — the constitutional wall',
      from: { path: '^src/infrastructure/ai' },
      to: {
        path: '^src/(infrastructure/chrome|infrastructure/journal|surfaces|roots)|^src/application/ports/(tabs|windows|tab-groups)',
      },
    },
    {
      name: 'importers-exporters-via-application-only',
      severity: 'error',
      from: { path: '^src/infrastructure/(importers|exporters)' },
      to: { path: '^src/infrastructure/(journal|storage)' },
    },
    {
      // ADR-025 (E1-T12): entrypoints are the only importers of composition roots —
      // roots are the terminus of the graph, never a library (root-internal *.test.ts
      // files boot their own root with stub adapters and are exempt).
      name: 'roots-are-terminus',
      severity: 'error',
      comment: 'ADR-025 only entrypoints compose roots',
      from: { pathNot: '^entrypoints|^src/roots/.+\\.test\\.ts$' },
      to: { path: '^src/roots' },
    },
    {
      name: 'entrypoints-only-compose-roots',
      severity: 'error',
      from: { path: '^entrypoints' },
      to: { pathNot: '^src/roots|^node_modules|\\.css|\\.html?$' },
    },
    {
      name: 'egress-is-forbidden',
      severity: 'error',
      comment: 'A-10 belt to eslint suspenders: no net libs anywhere in src',
      from: { path: '^src' },
      to: { path: '(^|/)node_modules/(undici|axios|node-fetch|got|ky)(/|$)' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { extensions: ['.ts', '.js', '.json'] },
  },
};
