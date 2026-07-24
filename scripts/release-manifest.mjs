#!/usr/bin/env node
// EES §8 release manifest: every release records gates, sizes, deps, audit snapshot. [GATE]
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const manifest = {
  version: pkg.version, tag: process.env.GITHUB_REF_NAME ?? 'local',
  createdAt: new Date().toISOString(),
  runtimeDependencies: Object.keys(pkg.dependencies ?? {}),
  commit: execSync('git rev-parse HEAD').toString().trim(),
  gates: { respect: 'PR workflows (lint/test/build-and-guards/supply-chain) — see Actions runs for this SHA' },
};
writeFileSync('ops/release-manifest.json', JSON.stringify(manifest, null, 2));
console.log('wrote ops/release-manifest.json');
