#!/usr/bin/env node
// E1-T08 completion gate: no unmapped errors. [CI]
// Verifies the closed triangle: every declared E_* code has an ERROR_MAP entry,
// every entry's keys exist in the copy catalog, and no msg.error/msg.recover copy
// is orphaned (copy that nothing can raise is drift).
import { readFileSync } from 'node:fs';

const codesSrc = readFileSync('src/shared-kernel/result/error-codes.catalog.ts', 'utf8');
const mapSrc = readFileSync('src/shared-kernel/result/error.catalog.ts', 'utf8');
const catalog = JSON.parse(readFileSync('src/surfaces/components/copy/catalog.json', 'utf8'));

const codes = [...codesSrc.matchAll(/'(E_[A-Z_]+)'/g)].map((m) => m[1]);
const mappedCodes = new Set([...mapSrc.matchAll(/^\s{2}(E_[A-Z_]+):/gm)].map((m) => m[1]));
const mappedKeys = [...mapSrc.matchAll(/'(msg\.(error|recover)\.[a-z-]+)'/g)].map((m) => m[1]);

const flat = (o, p = []) =>
  Object.entries(o).flatMap(([k, v]) =>
    typeof v === 'string' ? [p.concat(k).join('.')] : flat(v, p.concat(k)),
  );
const catalogKeys = new Set(flat(catalog));

const problems = [];
for (const code of codes)
  if (!mappedCodes.has(code)) problems.push(`${code}: declared but not mapped in error.catalog.ts`);
for (const code of mappedCodes)
  if (!codes.includes(code))
    problems.push(`${code}: mapped but not declared in error-codes.catalog.ts`);
for (const key of new Set(mappedKeys))
  if (!catalogKeys.has(key))
    problems.push(`${key}: referenced by ERROR_MAP but missing from copy catalog`);
for (const key of catalogKeys) {
  if ((key.startsWith('msg.error.') || key.startsWith('msg.recover.')) && !mappedKeys.includes(key))
    problems.push(`${key}: present in copy catalog but no error maps to it (orphan copy)`);
}

if (problems.length) {
  console.error('ERROR MAP LINT (EES §3.2):\n' + problems.join('\n'));
  process.exit(1);
}
console.log(
  `error-map-lint: ${codes.length} codes fully mapped; no unmapped or orphaned error copy.`,
);
