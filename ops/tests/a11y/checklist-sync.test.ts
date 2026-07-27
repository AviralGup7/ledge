// E7-T03 · checklist↔suite sync — the zero-defect program stays honest: the
// checklist cites only executable anchors that exist on disk, covers every
// §7.4 clause per surface, and the F1 diet ruling holds (no a11y engine deps).
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CHECKLIST_PATH = 'docs/accessibility-checklist.md';

const requiredClauses = [
  'keyboard',
  'live region',
  'zoom',
  'reduce-motion',
  '44px',
  'prefers-contrast',
  'forced-colors',
  'calm copy',
  'focus-visible',
  'tabindex',
] as const;

const requiredSurfaces = ['guardian', 'overlay', 'quiet-page'] as const;

const requiredManualRows = ['M-ZOOM', 'M-CONTRAST', 'M-SR'] as const;

describe('E7-T03 a11y · checklist sync (doc ↔ suite ↔ diet)', () => {
  it('the checklist exists and covers every §7.4 clause + every surface', () => {
    expect(existsSync(CHECKLIST_PATH)).toBe(true);
    const doc = readFileSync(CHECKLIST_PATH, 'utf8').toLowerCase();
    for (const clause of requiredClauses) {
      expect(doc, `clause missing: ${clause}`).toContain(clause.toLowerCase());
    }
    for (const surface of requiredSurfaces) {
      expect(doc, `surface missing: ${surface}`).toContain(surface);
    }
  });

  it('every test path the checklist cites exists on disk', () => {
    const doc = readFileSync(CHECKLIST_PATH, 'utf8');
    const cited = [...doc.matchAll(/ops\/tests\/[a-z0-9\-/_]+\.test\.ts/g)].map((m) => m[0]);
    expect(cited.length).toBeGreaterThan(0);
    for (const path of new Set(cited)) {
      expect(existsSync(path), `cited anchor missing: ${path}`).toBe(true);
    }
  });

  it('every manual protocol row is present (what code cannot prove)', () => {
    const doc = readFileSync(CHECKLIST_PATH, 'utf8');
    for (const row of requiredManualRows) {
      expect(doc).toContain(row);
    }
  });

  it('F1 diet ruling: no a11y/DOM-shim engine joins the dependency set', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      readonly dependencies?: Record<string, string>;
      readonly devDependencies?: Record<string, string>;
    };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const banned of ['axe-core', 'pa11y', 'jsdom', 'happy-dom', 'domino']) {
      expect(all, `${banned} must never join the toolchain (dependency diet)`).not.toHaveProperty(
        banned,
      );
    }
  });
});
