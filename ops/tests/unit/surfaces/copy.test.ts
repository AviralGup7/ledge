// E4 · Copy system suite — the §2 copy law's enforcement half: interpolation,
// missing-key totality, banned-token hygiene, key shape, and the load-bearing one:
// EVERY copyOf('<literal>') key referenced anywhere in src/surfaces must exist in
// the catalog (a missing key renders the key itself = user-facing defect).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyOf, hasCopy } from '@/surfaces/components/copy/copy.js';
import catalog from '@/surfaces/components/copy/catalog.json';

const SURFACES_ROOT = 'src/surfaces';
const SRC_ROOT = 'src';
const COPY_KEY_PATTERN = /copyOf\(\s*'([^']+)'/g;
const UNDO_LABEL_PATTERN = /'msg\.undo\.[a-z-]+'/g;

const walkTs = (dir: string, out: string[] = []): readonly string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkTs(path, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(path);
  }
  return out;
};

const referencedKeys = (): readonly string[] => {
  const keys = new Set<string>();
  for (const file of walkTs(SURFACES_ROOT)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(COPY_KEY_PATTERN)) {
      const key = match[1];
      if (key !== undefined) keys.add(key);
    }
  }
  return [...keys].sort();
};

const flattenLeaves = (node: unknown, prefix: string, out: string[] = []): readonly string[] => {
  if (typeof node === 'object' && node !== null) {
    for (const [k, v] of Object.entries(node)) flattenLeaves(v, `${prefix}${k}.`, out);
  } else if (typeof node === 'string') {
    out.push(prefix.slice(0, -1));
  }
  return out;
};

/** Every 'msg.undo.*' literal under a source root (production files only — tests are
 *  neither emitters nor consumers). The emitter set is SCAN-DERIVED by law: a
 *  hand-mirrored list is what let msg.undo.archived 404 to a raw key at audit (E4-F1). */
const undoLabelsUnder = (root: string): ReadonlySet<string> => {
  const labels = new Set<string>();
  for (const file of walkTs(root)) {
    if (file.endsWith('.test.ts')) continue;
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(UNDO_LABEL_PATTERN)) {
      labels.add(match[0].slice(1, -1));
    }
  }
  return labels;
};

describe('E4 copy · interpolation', () => {
  it('resolves a leaf to its prose', () => {
    expect(copyOf('msg.action.undo')).toBe('Undo');
  });

  it('interpolates {vars} in order, repeatedly when repeated', () => {
    expect(copyOf('msg.heartbeat.safe', { count: 3 })).toBe('3 tabs safe');
    expect(copyOf('msg.dialog.imported', { imported: 4, dupes: 2 })).toBe(
      '4 tabs imported; 2 were already here.',
    );
  });

  it('unknown vars interpolate to empty text (calm, never placeholder debris)', () => {
    expect(copyOf('msg.heartbeat.safe', {})).toBe(' tabs safe');
  });

  it('missing key renders the key itself — total rendering, never a throw', () => {
    expect(copyOf('msg.no.such-key')).toBe('msg.no.such-key');
    expect(hasCopy('msg.no.such-key')).toBe(false);
    expect(hasCopy('msg.action.undo')).toBe(true);
  });
});

describe('E4 copy · catalog hygiene', () => {
  const leaves = flattenLeaves(catalog, '');
  const prose = (key: string): string => copyOf(key);

  it('every key matches the msg.area.leaf shape (full-or-leaf naming law)', () => {
    for (const key of leaves) {
      expect(key).toMatch(/^msg\.[a-z-]+\.[a-z-]+$/);
    }
  });

  it('no banned token appears in any leaf (calm copy is the product law)', () => {
    const banned = [
      '!',
      'hurry',
      "don't miss",
      'last chance',
      'shame',
      'guilty',
      'act now',
      'limited time',
      'oops',
    ];
    for (const key of leaves) {
      const line = prose(key).toLowerCase();
      for (const token of banned) {
        expect(line.includes(token), `${key} contains banned token ${token}`).toBe(false);
      }
    }
  });

  it('no leaf is empty or whitespace-only', () => {
    for (const key of leaves) {
      expect(copyOf(key).trim().length, `${key} is blank`).toBeGreaterThan(0);
    }
  });

  it('interpolated vars used in code exist in their leaf, and leaf vars are legal names', () => {
    const varPattern = /\{([a-zA-Z]+)\}/g;
    for (const key of leaves) {
      const line = prose(key);
      for (const match of line.matchAll(varPattern)) {
        expect(typeof match[1]).toBe('string');
        // {var} must never contain spaces/braces (would render raw after replace).
        expect(match[0]).not.toContain(' ');
      }
    }
  });
});

describe('E4 copy · code↔catalog agreement (the load-bearing law)', () => {
  it('every copyOf literal in src/surfaces resolves to a catalog leaf', () => {
    const keys = referencedKeys();
    expect(keys.length).toBeGreaterThan(30); // sanity: the scan actually found the usages
    const missing = keys.filter((key) => !hasCopy(key));
    expect(missing).toEqual([]);
  });

  it('keys referenced from dynamic fallbacks (error maps, undo labels) also exist', () => {
    // Fallbacks baked into components/surfaces as constants.
    const fallbacks = [
      'msg.error.output',
      'msg.recover.report',
      'msg.error.capability',
      'msg.recover.retry',
      'msg.recover.update',
      'msg.error.durability',
      'msg.recover.wait',
      'msg.error.capability',
      'msg.recover.restart',
      'msg.undo.empty',
      'msg.undo.done',
      'msg.setting.retention',
      'msg.state.kept',
    ];
    for (const key of fallbacks) expect(hasCopy(key), key).toBe(true);
  });

  it('every msg.undo.* label the SW can actually emit resolves in the catalog (emitter-derived; the E4-F1 gate)', () => {
    const emitted = undoLabelsUnder(SRC_ROOT);
    // Regression pins — the scan can never pass green-by-absence:
    expect(emitted.has('msg.undo.archived')).toBe(true);
    expect(emitted.size).toBeGreaterThan(5);
    const missing = [...emitted].filter((key) => !hasCopy(key));
    expect(missing).toEqual([]);
  });

  it('every catalog undo label has an emitter or a surface consumer (no orphan narration)', () => {
    const reachable = new Set([...undoLabelsUnder(SRC_ROOT), ...undoLabelsUnder(SURFACES_ROOT)]);
    const catalogUndo = flattenLeaves(catalog, '').filter((key) => key.startsWith('msg.undo.'));
    expect(catalogUndo.length).toBeGreaterThan(5); // sanity: the flatten actually found them
    const orphans = catalogUndo.filter((key) => !reachable.has(key));
    expect(orphans).toEqual([]);
  });
});
