#!/usr/bin/env node
// §7 culture: gzip budgets per entry (ops/ci/budgets.json). Tighten-only (ADR-029). [CI]
// Audit P1-G15 ratchet:
//   required:true  + zero matching files  -> FAIL (entrypoint renamed? budget would silently die)
//   required:false + files now matching   -> FAIL (flip required to true in the shipping PR)
//   required:false + zero matches         -> warn-skip (entry not shipped yet)
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const budgets = JSON.parse(readFileSync('ops/ci/budgets.json', 'utf8')).entries;
const OUT = '.output/chrome-mv3';
if (!existsSync(OUT)) {
  console.error(`bundle-check: ${OUT} missing — run \`pnpm build\` first.`);
  process.exit(1);
}
const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|mjs|html)$/.test(e)) files.push(p);
  }
})(OUT);

let fail = false;
for (const b of budgets) {
  const re = new RegExp(b.glob, 'i');
  const hits = files.filter((f) => re.test(f));
  if (!hits.length) {
    if (b.required) {
      console.error(
        `FAIL ${b.name}: required budget matched zero files — entrypoint renamed or entry removed?`,
      );
      fail = true;
    } else {
      console.warn(`budget "${b.name}": no matching files yet (entry not shipped) — skipped`);
    }
    continue;
  }
  if (!b.required) {
    console.error(
      `FAIL ${b.name}: files match but budget is required:false — flip it to true in ops/ci/budgets.json (same PR).`,
    );
    fail = true;
    continue;
  }
  let usedKB = 0;
  for (const f of hits) usedKB += gzipSync(readFileSync(f)).length / 1024;
  const ok = usedKB <= b.maxGzipKB;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${b.name}: ${usedKB.toFixed(1)}KB gzip / ${b.maxGzipKB}KB`);
  fail ||= !ok;
}
process.exit(fail ? 1 : 0);
