#!/usr/bin/env node
// Imports ops/github/issues.v1.json as GitHub issues. Usage: node scripts/import-issues.mjs [--dry-run]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
const dry = process.argv.includes('--dry-run');
const { issues } = JSON.parse(readFileSync('ops/github/issues.v1.json', 'utf8'));
console.log(`importing ${issues.length} tasks${dry ? ' (dry run)' : ''}...`);
for (const it of issues) {
  const f = `ops/github/.tmp-issue-${it.id}.md`;
  writeFileSync(f, it.body);
  const args = ['issue', 'create', '--title', `[${it.id}] ${it.title}`, '--body-file', f,
    '--milestone', it.milestone, ...it.labels.flatMap((l) => ['--label', l])];
  if (dry) console.log('gh ' + args.slice(0, 4).join(' ') + ` ... (${it.milestone})`);
  else { try { execFileSync('gh', args, { stdio: ['pipe', 'pipe', 'inherit'] }); unlinkSync(f); } catch { console.error('FAILED: ' + it.id); } }
}
