#!/usr/bin/env node
// D-01 ceiling + admission list. [CI] (Quarantine enforced by dependency-cruiser.)
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const policy = JSON.parse(readFileSync('ops/ci/runtime-deps.json', 'utf8'));
const runtime = Object.keys(pkg.dependencies ?? {});
const allowed = new Set(policy.deps.map((d) => d.name));
const violations = runtime.filter((d) => !allowed.has(d));
if (runtime.length > policy.maxRuntimeDeps) violations.push(`count ${runtime.length} > ${policy.maxRuntimeDeps}`);
if (violations.length) {
  console.error('DEP POLICY VIOLATION (D-01/D-02):\n' + violations.join('\n'));
  process.exit(1);
}
console.log(`dep-policy: ${runtime.length}/${policy.maxRuntimeDeps} runtime deps, all admitted with removal plans.`);
