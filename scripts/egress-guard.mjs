#!/usr/bin/env node
// A-10 egress guard: scans build output for URLs not in ops/ci/egress-allowlist.json. [CI]
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
const root = process.argv[2] ?? '.output/chrome-mv3';
const allow = JSON.parse(readFileSync('ops/ci/egress-allowlist.json', 'utf8')).allowed
  .map((a) => new RegExp(a.pattern));
const TEXT = new Set(['.js', '.html', '.css', '.json', '.map']);
const violations = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (TEXT.has(extname(p))) {
      const text = readFileSync(p, 'utf8');
      for (const m of text.matchAll(/https?:\/\/[^\s"'`)\]\\<>]+/g)) {
        const url = m[0];
        if (!allow.some((re) => re.test(url))) violations.push(`${p}: ${url.slice(0, 120)}`);
      }
    }
  }
})(root);
if (violations.length) {
  console.error('EGRESS VIOLATION (A-10). Offending URLs:\n' + violations.join('\n'));
  process.exit(1);
}
console.log('egress-guard: allowlist intact (empty egress table holds).');
