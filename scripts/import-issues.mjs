#!/usr/bin/env node
// Imports ops/github/issues.v1.json as GitHub issues. Usage: node scripts/import-issues.mjs [--dry-run]
// Audit P1-G13: IDEMPOTENT — tasks whose [Exx-Txx] id already exists (open or closed) are
// skipped, never duplicated. Failures are collected and exit non-zero; temp files live in
// the OS temp dir and are always cleaned up.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dry = process.argv.includes('--dry-run');
const { issues } = JSON.parse(readFileSync('ops/github/issues.v1.json', 'utf8'));

let existing = new Set();
if (!dry) {
  const titles = JSON.parse(
    execFileSync('gh', ['issue', 'list', '--state', 'all', '--limit', '1000', '--json', 'title'], {
      encoding: 'utf8',
    }),
  );
  existing = new Set(titles.map((t) => /^\[(E\d-T\d+)\]/.exec(t.title)?.[1]).filter(Boolean));
}

const workdir = mkdtempSync(join(tmpdir(), 'ledge-import-'));
const failures = [];
let planned = 0;
let skipped = 0;
console.log(
  `importing ${issues.length} tasks${dry ? ' (dry run)' : ''} — ${existing.size} already on the tracker...`,
);
for (const it of issues) {
  if (existing.has(it.id)) {
    skipped++;
    continue;
  }
  planned++;
  const f = join(workdir, `${it.id}.md`);
  writeFileSync(f, it.body);
  const args = [
    'issue',
    'create',
    '--title',
    `[${it.id}] ${it.title}`,
    '--body-file',
    f,
    '--milestone',
    it.milestone,
    ...it.labels.flatMap((l) => ['--label', l]),
  ];
  if (dry) {
    console.log('gh ' + args.slice(0, 4).join(' ') + ` ... (${it.milestone})`);
  } else {
    try {
      execFileSync('gh', args, { stdio: ['pipe', 'pipe', 'inherit'] });
      rmSync(f, { force: true });
    } catch (e) {
      failures.push(`${it.id}: ${String(e.message ?? e).split('\n')[0]}`);
    }
  }
}
rmSync(workdir, { recursive: true, force: true });
console.log(
  `done: ${planned} ${dry ? 'planned' : 'created'}, ${skipped} skipped (existing), ${failures.length} failed.`,
);
if (failures.length) {
  console.error('FAILED TASKS:\n' + failures.join('\n'));
  process.exit(1);
}
