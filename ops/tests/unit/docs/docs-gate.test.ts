// E7-T05 · docs-set gate — the milestone docs gate made executable: the set
// exists, each Blueprint §9 failure row has a playbook, cited repo paths stay
// real (witnesses never rot), README script claims match package.json, and the
// threat model keeps every §7.5 gate named.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const PKG = JSON.parse(readFileSync('package.json', 'utf8')) as {
  readonly scripts?: Record<string, string>;
};
const SCRIPT_NAMES = new Set(Object.keys(PKG.scripts ?? {}));

/** Repo-relative backticked paths (files or dirs). */
const PATH_RE = /`((?:src|ops|docs|seeds|assets|entrypoints)\/[A-Za-z0-9\-._/]+?)`/g;

const citedPaths = (doc: string): readonly string[] =>
  [...doc.matchAll(PATH_RE)].map((m) => m[1]).filter((p): p is string => p !== undefined);

/** Paths that must exist from a doc body (dirs allowed; globs allowed). */
const assertCitedPathsExist = (docPath: string): void => {
  const doc = readFileSync(docPath, 'utf8');
  for (const cited of new Set(citedPaths(doc))) {
    if (cited.includes('*')) continue; // illustrative glob, not a path
    const trimmed = cited.endsWith('/') ? cited.slice(0, -1) : cited;
    expect(existsSync(trimmed), `${docPath} cites missing path: ${cited}`).toBe(true);
  }
};

const BLUEPRINT_9_ROWS = [
  'journal',
  'intents',
  'storage',
  'projections',
  'chrome-adapters',
  'offscreen',
  'ai-providers',
  'search',
  'importers',
  'exporters',
  'messaging-hub',
  'sync',
  'diagnostics',
] as const;

const DOCS_SET = [
  'docs/degradation-matrix.md',
  'docs/threat-model.md',
  'docs/runbooks/index.md',
  'README.md',
] as const;

describe('E7-T05 docs gate · set completeness', () => {
  it('the docs set exists', () => {
    for (const path of DOCS_SET) {
      expect(existsSync(path), `missing: ${path}`).toBe(true);
    }
  });

  it('every Blueprint §9 row has its own playbook file (+ recovery link)', () => {
    for (const row of BLUEPRINT_9_ROWS) {
      const file = `docs/runbooks/${row}.md`;
      expect(existsSync(file), `runbook missing for §9 row ${row}`).toBe(true);
    }
    // Recovery's playbook predates this set — the index must link it.
    const index = readFileSync('docs/runbooks/index.md', 'utf8');
    expect(index).toContain('recovery-runbook-v0.md');
    expect(existsSync('docs/recovery-runbook-v0.md')).toBe(true);
  });

  it('runbook files are real pages (arc sections), not stubs', () => {
    for (const row of BLUEPRINT_9_ROWS) {
      const body = readFileSync(`docs/runbooks/${row}.md`, 'utf8');
      const lines = body.split('\n').filter((l) => l.trim().length > 0).length;
      expect(lines, `${row}: thin page`).toBeGreaterThanOrEqual(15);
      expect(body, `${row}: missing drill arm`).toContain('Drill');
    }
  });

  it('the runbook index names every §9 row', () => {
    const index = readFileSync('docs/runbooks/index.md', 'utf8');
    for (const row of BLUEPRINT_9_ROWS) {
      expect(index, `index missing row ${row}`).toContain(`[${row}.md](${row}.md)`);
    }
  });
});

describe('E7-T05 docs gate · citations never rot', () => {
  const CENSUS_SET = [
    'docs/degradation-matrix.md',
    'docs/threat-model.md',
    'docs/runbooks/index.md',
    'docs/accessibility-checklist.md',
    'seeds/README.md',
    ...BLUEPRINT_9_ROWS.map((r) => `docs/runbooks/${r}.md`),
  ] as const;

  for (const docPath of CENSUS_SET) {
    it(`${docPath}: every cited repo path exists`, () => {
      assertCitedPathsExist(docPath);
    });
  }
});

describe('E7-T05 docs gate · degradation matrix posture', () => {
  const matrix = readFileSync('docs/degradation-matrix.md', 'utf8');

  it('the matrix covers the failure tiers (engine/application/platform/import-export) and hosts D-rows with witnesses', () => {
    for (const tier of [
      'Engine tier',
      'Application tier',
      'Platform tier',
      'Import / export tier',
    ]) {
      expect(matrix, `tier missing: ${tier}`).toContain(tier);
    }
    const rows = matrix.split('\n').filter((line) => line.startsWith('| D'));
    expect(rows.length).toBeGreaterThanOrEqual(20);
    for (const row of rows) {
      const hasPath =
        citedPaths(row).filter((p) => !p.includes('*')).length > 0 ||
        row.includes('Tier-') ||
        row.includes('EPIC');
      expect(hasPath, `matrix row missing witness or future-marker: ${row.slice(0, 60)}`).toBe(
        true,
      );
    }
  });
});

describe('E7-T05 docs gate · threat model keeps the §7.5 gate census', () => {
  const threat = readFileSync('docs/threat-model.md', 'utf8');

  it('every §7.5 gate family is named', () => {
    for (const gate of [
      'manifest',
      'egress',
      'CSP',
      'boundary-validator fuzz',
      'dependency audit',
      'redaction',
      'purge',
      'incognito',
    ]) {
      expect(threat.toLowerCase(), `gate family missing: ${gate}`).toContain(gate.toLowerCase());
    }
  });

  it('every backticked pnpm script gate in the model exists in package.json', () => {
    const claims = [...threat.matchAll(/`pnpm (?:run )?([a-z:-]+)`/g)].map((m) => m[1]);
    expect(claims.length).toBeGreaterThan(0);
    for (const claim of new Set(claims)) {
      expect(SCRIPT_NAMES, `threat model cites missing script: pnpm ${claim}`).toContain(claim);
    }
  });
});

describe('E7-T05 docs gate · README onboarding law', () => {
  const readme = readFileSync('README.md', 'utf8');

  it('every `pnpm <script>` claim in README exists in package.json', () => {
    const claims = [...readme.matchAll(/pnpm (?:run )?([a-z][a-z:-]*)/g)]
      .map((m) => m[1])
      .filter((name): name is string => name !== undefined)
      // prose verbs following pnpm in code fences that are not script names
      .filter((name) => !['install', 'prepare'].includes(name));
    expect(claims.length).toBeGreaterThan(0);
    for (const claim of new Set(claims)) {
      expect(
        SCRIPT_NAMES,
        `README cites missing script: pnpm ${claim} (onboarding must stay runnable)`,
      ).toContain(claim);
    }
  });

  it('every node scripts/*.mjs claim exists on disk', () => {
    const claims = [...readme.matchAll(/node (scripts\/[a-z0-9\-._]+\.mjs)/g)].map((m) => m[1]);
    for (const claim of new Set(claims)) {
      expect(claim).toBeDefined();
      expect(existsSync(claim ?? ''), `README cites missing script: ${claim}`).toBe(true);
    }
  });

  it('the documents map links the ops docs set', () => {
    for (const path of [
      'docs/degradation-matrix.md',
      'docs/threat-model.md',
      'docs/runbooks/',
      'docs/accessibility-checklist.md',
      'seeds/README.md',
      'ops/fixtures/FIXTURES.md',
    ]) {
      expect(readme, `documents map missing: ${path}`).toContain(path);
    }
  });
});
