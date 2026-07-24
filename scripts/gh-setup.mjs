#!/usr/bin/env node
// One-time repo setup: labels + milestones + branch protection guidance. Requires `gh auth login`.
// Usage: node scripts/gh-setup.mjs [--dry-run]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const dry = process.argv.includes('--dry-run');
const run = (args, input) => { console.log('gh ' + args.join(' ')); if (!dry) execFileSync('gh', args, { input, stdio: ['pipe', 'inherit', 'inherit'] }); };
for (const l of JSON.parse(readFileSync('.github/labels.json', 'utf8'))) {
  run(['label', 'create', l.name, '--color', l.color, ...(l.description ? ['--description', l.description] : []), '--force']);
}
for (const m of JSON.parse(readFileSync('.github/milestones.json', 'utf8'))) {
  run(['api', 'repos/{owner}/{repo}/milestones', '-f', `title=${m.title}`, '-f', `description=${m.description}`, '--method', 'POST']);
}
// Branch protection (gh api): required checks must exist after first PR run; command printed for after that.
console.log(`
NEXT (manual, once checks exist):
  gh api repos/{owner}/{repo}/branches/main/protection -X PUT \\
    -f 'required_status_checks[strict]=true' \\
    -f 'required_status_checks[contexts][]=lint' -f 'required_status_checks[contexts][]=test' \\
    -f 'required_status_checks[contexts][]=build-and-guards' -f 'required_status_checks[contexts][]=supply-chain' \\
    -f 'required_pull_request_reviews[required_approving_review_count]=1' \\
    -F 'enforce_admins=false' -f 'allow_force_pushes=false' -f 'allow_deletions=false' -f 'required_linear_history=true'
Project board: create a GitHub Projects (v2) board with views: by Milestone, by epic:E* label, gate:G1/G2 filters.
`);
