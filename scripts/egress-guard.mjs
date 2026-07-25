#!/usr/bin/env node
// A-10 egress guard: scans build output for URLs not in ops/ci/egress-allowlist.json. [CI]
// Audit P1-G4 hardening: covers wss:// and ftp:// schemes (not only https?://) and quoted
// protocol-relative URLs ("//host.tld/path") — and fails closed with a clear message when
// the build output is missing.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const root = process.argv[2] ?? '.output/chrome-mv3';
const allow = JSON.parse(readFileSync('ops/ci/egress-allowlist.json', 'utf8')).allowed.map(
  (a) => new RegExp(a.pattern),
);
const TEXT = new Set(['.js', '.html', '.css', '.json', '.map']);
const SCHEME_URL = /(?:https?|wss|ftp):\/\/[^\s"'`)\]\\<>]+/g;
const PROTOCOL_RELATIVE = /["'`]\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}[^\s"'`)\]\\<>]*["'`]/gi;

if (!existsSync(root)) {
  console.error(`egress-guard: ${root} missing — run \`pnpm build\` first.`);
  process.exit(1);
}
const violations = [];
const collect = (p, url) => {
  if (!allow.some((re) => re.test(url))) violations.push(`${p}: ${url.slice(0, 120)}`);
};
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (TEXT.has(extname(p))) {
      const text = readFileSync(p, 'utf8');
      for (const m of text.matchAll(SCHEME_URL)) collect(p, m[0]);
      for (const m of text.matchAll(PROTOCOL_RELATIVE)) collect(p, m[0].slice(1, -1));
    }
  }
})(root);

if (violations.length) {
  console.error('EGRESS VIOLATION (A-10). Offending URLs:\n' + violations.join('\n'));
  process.exit(1);
}
console.log(
  'egress-guard: allowlist intact (empty egress table holds) — scanned http(s), wss, ftp, protocol-relative.',
);
