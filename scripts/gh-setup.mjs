#!/usr/bin/env node
// One-time repo bootstrap: labels + milestones (+ branch protection with --apply).
// Requires `gh auth login`. Usage: node scripts/gh-setup.mjs [--dry-run] [--apply]
// Audit P1-G10/G14: IDEMPOTENT — labels upsert via --force; milestones skip existing titles
// (GitHub otherwise creates silent duplicates). --apply closes the advisory-CI window by
// actually setting branch protection instead of only printing the command.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const dry = process.argv.includes('--dry-run');
const apply = process.argv.includes('--apply');
const run = (args) => {
  console.log('gh ' + args.join(' '));
  if (!dry) execFileSync('gh', args, { stdio: ['pipe', 'inherit', 'inherit'] });
};
const captureJson = (args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8' }));

for (const l of JSON.parse(readFileSync('.github/labels.json', 'utf8'))) {
  run([
    'label',
    'create',
    l.name,
    '--color',
    l.color,
    ...(l.description ? ['--description', l.description] : []),
    '--force',
  ]);
}

const existingMilestones = dry
  ? new Set()
  : new Set(
      captureJson(['api', 'repos/{owner}/{repo}/milestones?state=all&per_page=100']).map(
        (m) => m.title,
      ),
    );
for (const m of JSON.parse(readFileSync('.github/milestones.json', 'utf8'))) {
  if (existingMilestones.has(m.title)) {
    console.log(`milestone exists, skipping: ${m.title}`);
    continue;
  }
  run([
    'api',
    'repos/{owner}/{repo}/milestones',
    '-f',
    `title=${m.title}`,
    '-f',
    `description=${m.description}`,
    '--method',
    'POST',
  ]);
}

const protectionArgs = [
  'api',
  'repos/{owner}/{repo}/branches/main/protection',
  '-X',
  'PUT',
  '-f',
  'required_status_checks[strict]=true',
  '-f',
  'required_status_checks[contexts][]=lint',
  '-f',
  'required_status_checks[contexts][]=test',
  '-f',
  'required_status_checks[contexts][]=build-and-guards',
  '-f',
  'required_status_checks[contexts][]=supply-chain',
  '-f',
  'required_pull_request_reviews[required_approving_review_count]=1',
  // NOTE: enforce_admins=false while the team is one person (hotfix law needs a compliant
  // expedited path). Constitution §11 requires flipping this to true at contributor #2.
  '-F',
  'enforce_admins=false',
  '-f',
  'allow_force_pushes=false',
  '-f',
  'allow_deletions=false',
  '-f',
  'required_linear_history=true',
];

if (apply) {
  console.log('\nApplying branch protection to main…');
  run(protectionArgs);
} else {
  console.log(
    '\nNEXT (once, after the first PR has produced check runs — or rerun this script with --apply):\n  gh ' +
      protectionArgs.join(' \\\n    ') +
      '\nProject board: create a GitHub Projects (v2) board with views: by Milestone, by epic:E* label, gate:G1/G2 filters.',
  );
}
