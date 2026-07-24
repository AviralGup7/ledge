#!/usr/bin/env node
// §7 culture: gzip budgets per entry (ops/ci/budgets.json). Tighten-only. [CI]
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
const budgets = JSON.parse(readFileSync('ops/ci/budgets.json', 'utf8')).entries;
const roots = ['.output/chrome-mv3'];
const files = [];
(function walk(d) { for (const e of readdirSync(d)) { const p = join(d, e); statSync(p).isDirectory() ? walk(p) : /\.(js|mjs|html)$/.test(e) && files.push(p); } })(roots[0]);
let fail = false;
for (const b of budgets) {
  const re = new RegExp(b.glob, 'i');
  const hits = files.filter((f) => re.test(f));
  if (!hits.length) { console.warn(`budget "${b.name}": no matching files yet (scaffold) — skipped`); continue; }
  let usedKB = 0;
  for (const f of hits) usedKB += gzipSync(readFileSync(f)).length / 1024;
  const ok = usedKB <= b.maxGzipKB;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${b.name}: ${usedKB.toFixed(1)}KB gzip / ${b.maxGzipKB}KB`);
  fail ||= !ok;
}
process.exit(fail ? 1 : 0);
