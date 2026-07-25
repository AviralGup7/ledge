#!/usr/bin/env node
// D-01 ceiling + D-02 admission list. [CI]
// Audit P1-G8: admission is only real when all three artifacts exist and agree —
// (1) ops/ci/runtime-deps.json entry with non-empty removalPlan, (2) a live quarantine
// directory, (3) a dependency-cruiser quarantine rule mentioning node_modules/<dep>.
// Adding a dep to this JSON without the depcruise rule is now itself a violation.
import { readFileSync, existsSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const policy = JSON.parse(readFileSync('ops/ci/runtime-deps.json', 'utf8'));
const cruiseConfig = readFileSync('.dependency-cruiser.cjs', 'utf8');
const runtime = Object.keys(pkg.dependencies ?? {});
const allowed = new Map(policy.deps.map((d) => [d.name, d]));
const violations = [];

for (const dep of runtime) {
  const admission = allowed.get(dep);
  if (!admission) {
    violations.push(`"${dep}" is not on the D-02 admission list (ops/ci/runtime-deps.json)`);
    continue;
  }
  if (!admission.removalPlan?.trim())
    violations.push(`"${dep}": D-01 requires a non-empty removalPlan`);
  if (!admission.quarantine || !existsSync(admission.quarantine))
    violations.push(
      `"${dep}": quarantine dir "${admission.quarantine ?? '(none)'}" does not exist`,
    );
  const esc = dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`node_modules/${esc}`).test(cruiseConfig))
    violations.push(
      `"${dep}": no dependency-cruiser quarantine rule mentions node_modules/${dep} — admission without the rule is unenforced`,
    );
}
if (runtime.length > policy.maxRuntimeDeps)
  violations.push(`count ${runtime.length} > ${policy.maxRuntimeDeps}`);

if (violations.length) {
  console.error('DEP POLICY VIOLATION (D-01/D-02/D-03):\n' + violations.join('\n'));
  process.exit(1);
}
console.log(
  `dep-policy: ${runtime.length}/${policy.maxRuntimeDeps} runtime deps — every admission carries removalPlan + live quarantine + depcruise rule.`,
);
