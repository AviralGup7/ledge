// E7-T04 · regression seed corpus census — the constitution T-01 covenant made
// executable: every registry row is well-formed, vocabulary-frozen, and its
// regression proof exists on disk. The corpus stays grafted, never graveyarded.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SEEDS_DOC = 'seeds/README.md';

const CLASSES = [
  'projection-divergence',
  'durability-fixture',
  'corpus-integrity',
  'ui-shell',
  'copy-parity',
  'domain-parity',
  'field-report',
] as const;

const FOUND_BY = [
  'property-fuzz',
  'unit-suite',
  'a11y-suite',
  'harness',
  'audit',
  'chaos',
  'field-report',
] as const;

interface SeedRow {
  readonly seed: string;
  readonly klass: string;
  readonly foundBy: string;
  readonly symptom: string;
  readonly proofs: readonly string[];
  readonly fix: string;
  readonly grafted: string;
}

/** Parse the registry table (pipes may carry spaces; paths may be · separated). */
const registryRows = (doc: string): readonly SeedRow[] => {
  const rows: SeedRow[] = [];
  for (const line of doc.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('| SEED-')) continue;
    const cells = t
      .split('|')
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    const [seed, klass, foundBy, symptom, proofs, fix, grafted] = cells;
    if (
      seed === undefined ||
      klass === undefined ||
      foundBy === undefined ||
      symptom === undefined ||
      proofs === undefined ||
      fix === undefined ||
      grafted === undefined
    ) {
      throw new Error(`malformed seed row (need 7 cells): ${t}`);
    }
    rows.push({
      seed,
      klass,
      foundBy,
      symptom,
      proofs: proofs
        .split('·')
        .map((p) => p.trim().replaceAll('`', ''))
        .filter((p) => p.length > 0),
      fix,
      grafted,
    });
  }
  return rows;
};

describe('E7-T04 · regression seed corpus census', () => {
  const doc = readFileSync(SEEDS_DOC, 'utf8');
  const rows = registryRows(doc);

  it('the corpus is non-empty and ids are unique + ascending (never reused)', () => {
    expect(rows.length).toBeGreaterThan(0);
    const ids = rows.map((r) => r.seed);
    expect(new Set(ids).size).toBe(ids.length);
    const numbers = ids.map((id) => {
      const m = /^SEED-(\d{4})$/.exec(id)?.[1];
      expect(m, `bad seed id shape: ${id}`).toBeDefined();
      return Number(m);
    });
    for (let i = 1; i < numbers.length; i += 1) {
      const prev = numbers[i - 1];
      const cur = numbers[i];
      expect(prev).toBeDefined();
      expect(cur).toBeDefined();
      if (prev !== undefined && cur !== undefined) {
        expect(cur, `seed ids must ascend: ${ids.join(', ')}`).toBeGreaterThan(prev);
      }
    }
  });

  it('every row carries vocabulary-frozen class + founder and says it is grafted', () => {
    for (const row of rows) {
      expect(CLASSES, `${row.seed}: unknown class ${row.klass}`).toContain(row.klass);
      expect(FOUND_BY, `${row.seed}: unknown founder ${row.foundBy}`).toContain(row.foundBy);
      expect(row.symptom.trim().length, `${row.seed}: symptom is empty`).toBeGreaterThan(0);
      expect(row.grafted, `${row.seed}: only grafted seeds may live on main`).toBe('yes');
    }
  });

  it('every regression proof path exists on disk (grafted, never graveyarded)', () => {
    for (const row of rows) {
      expect(row.proofs.length, `${row.seed}: no proof linked`).toBeGreaterThan(0);
      for (const proof of row.proofs) {
        expect(proof, `${row.seed}: proof must be a test path`).toMatch(/\.test\.ts$/);
        expect(existsSync(proof), `${row.seed}: missing proof ${proof}`).toBe(true);
      }
    }
  });

  it('every fix reference is commit-hash shaped (no placeholders)', () => {
    for (const row of rows) {
      expect(row.fix, `${row.seed}: bad fix ref ${row.fix}`).toMatch(/^[0-9a-f]{7,40}$/);
    }
  });

  it('the discipline paragraphs exist (seed-first → fix → graft → curate)', () => {
    for (const step of ['Seed first', 'Fix', 'Graft', 'Curate']) {
      expect(doc.toLowerCase()).toContain(step.toLowerCase());
    }
    expect(doc).toContain('failing test first');
  });
});
