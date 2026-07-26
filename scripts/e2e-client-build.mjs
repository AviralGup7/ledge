#!/usr/bin/env node
// E6-T01 · real-restart e2e lane — bundles the page-side wire client
// (ops/tests/e2e/client-entry.ts → ops/tests/e2e/client.js).
//
// esbuild is a TRANSITIVE dependency in this repo (via vitest/wxt), so its bin
// is not linked into node_modules/.bin under pnpm's strict layout and it must
// not become a direct devDependency for one test script. This builder resolves
// the API entry of the esbuild package pinned in the pnpm virtual store
// (store contents are lockfile-frozen) and invokes buildSync directly —
// platform-packaging (the @esbuild/<os>-<arch> binary) stays esbuild's concern.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const STORE = join('node_modules', '.pnpm');
const ENTRY = 'ops/tests/e2e/client-entry.ts';
const OUTPUT = 'ops/tests/e2e/client.js';

const fail = (message) => {
  console.error(`E2E-CLIENT-BUILD FAIL: ${message}`);
  process.exit(1);
};

const candidates = existsSync(STORE)
  ? readdirSync(STORE)
      .filter((d) => /^esbuild@\d/.test(d))
      .sort()
  : [];
if (candidates.length === 0) fail(`no esbuild package in ${STORE} — run pnpm install first`);
const resolved = candidates[candidates.length - 1];
const apiPath = join(STORE, resolved, 'node_modules', 'esbuild', 'lib', 'main.js');
if (!existsSync(apiPath)) fail(`esbuild API entry missing at ${apiPath}`);
console.log(`esbuild: ${resolved} (pnpm store, lockfile-pinned)`);

const esbuild = await import(pathToFileURL(apiPath).href);
const result = esbuild.buildSync({
  entryPoints: [ENTRY],
  bundle: true,
  // IIFE: injected via CDP Runtime.evaluate (MV3 extension-page CSP forbids
  // inline <script> tags; evaluate is the sanctioned privileged channel).
  format: 'iife',
  platform: 'browser',
  tsconfig: 'tsconfig.json',
  outfile: OUTPUT,
  logLevel: 'warning',
});
if (result.errors.length > 0) fail(`${result.errors.length} build error(s)`);
if (!existsSync(OUTPUT)) fail(`${OUTPUT} not written`);
console.log(`e2e client: ${ENTRY} → ${OUTPUT} ✓`);
