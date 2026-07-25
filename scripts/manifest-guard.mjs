#!/usr/bin/env node
// ADR-022 integrity guard (audit P1-G5): the built manifest is a trust artifact.
// Diffs .output/chrome-mv3/manifest.json against the signed baseline
// ops/ci/manifest-baseline.json. Any drift requires an ADR + baseline update
// in the same PR — it cannot ride along unnoticed. [CI]
import { readFileSync, existsSync } from 'node:fs';

const OUT = '.output/chrome-mv3/manifest.json';
const BASE = 'ops/ci/manifest-baseline.json';
if (!existsSync(OUT)) {
  console.error(`manifest-guard: ${OUT} missing — run \`pnpm build\` first.`);
  process.exit(1);
}
const built = JSON.parse(readFileSync(OUT, 'utf8'));
const baseline = JSON.parse(readFileSync(BASE, 'utf8'));
const problems = [];
const norm = (v) => (v === undefined ? null : v);
const sameSet = (a = [], b = []) => a.length === b.length && a.every((x) => b.includes(x));

for (const field of ['permissions', 'optional_permissions']) {
  const want = baseline[field] ?? [];
  const got = built[field] ?? [];
  if (!sameSet(got, want))
    problems.push(`${field}: built ${JSON.stringify(got)} != baseline ${JSON.stringify(want)}`);
}
for (const field of ['host_permissions', 'externally_connectable', 'minimum_chrome_version']) {
  const got = norm(built[field]);
  const want = baseline[field];
  if (JSON.stringify(got) !== JSON.stringify(want))
    problems.push(`${field}: built ${JSON.stringify(got)} != baseline ${JSON.stringify(want)}`);
}
const cspBuilt = built.content_security_policy?.extension_pages ?? null;
const cspWant = baseline['content_security_policy.extension_pages'];
if (cspBuilt !== cspWant)
  problems.push(
    `content_security_policy.extension_pages: built ${JSON.stringify(cspBuilt)} != baseline ${JSON.stringify(cspWant)}`,
  );

if (problems.length) {
  console.error(
    'MANIFEST GUARD VIOLATION (ADR-022). Guarded fields drifted:\n' +
      problems.map((p) => '  - ' + p).join('\n') +
      '\n→ Revert, or land an ADR and update ops/ci/manifest-baseline.json in the same PR.',
  );
  process.exit(1);
}
console.log(
  'manifest-guard: ADR-022 baseline holds (permissions locked, CSP locked, host-permission surface absent).',
);
