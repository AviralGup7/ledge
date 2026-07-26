// E5-T05 · Adapter laws — the ImporterPort two-phase contract, probed through one
// onetab fixture for dupe arithmetic and dedicated fixtures per guard. Laws under
// test: both byte guards, transport union, hint override/invalid, zero-record,
// majority E_PARSE_REJECTS, deadline guard, modelSummary shape, canon stamping,
// dedupe skip vs import-anyway (dupes count stable — "reported" vs "imported"
// are different questions), plan hygiene (zero-tab missions dropped, the dupe
// marker itself never escapes), batchId := previewId identity, stash eviction
// (TTL + cap), unknown/stale commit legality, and the fetchRejects seam.
import { describe, expect, it } from 'vitest';
import { CANON_RULES_V1, canonicalize } from '@/shared-kernel/canon/index.js';
import { createIdGenerator, type IdGenerator, type Now } from '@/shared-kernel/identity/index.js';
import {
  createImportersAdapter,
  PREVIEW_STASH_CAP,
  PREVIEW_TTL_MS,
  type ImportersAdapter,
} from './importers.adapter.js';
import { IMPORT_MAX_BYTES, REJECT_FATAL_MIN_RECORDS } from './model.js';

const FUTURE = 1_785_024_000_000;

/** Deterministic ids derive the instant (monotone ULIDs); `now` is a knob per test. */
const makeIds = (base: number): IdGenerator =>
  createIdGenerator({
    now: () => base,
    randomBytes: (n: number) => new Uint8Array(n).fill(7),
  });

interface Rig {
  readonly adapter: ImportersAdapter;
  readonly advance: (ms: number) => void;
}

const makeRig = (start: number = FUTURE): Rig => {
  let t = start;
  const now: Now = () => t;
  const adapter = createImportersAdapter({ ids: makeIds(start), now });
  return { adapter, advance: (ms) => (t += ms) };
};

/** One group, two canon-equal tabs (tracker-param dupe) plus one distinct tab. */
const DUPE_TEXT = [
  'https://example.com/report/dup-4242?utm_source=newsletter | First copy',
  'https://example.com/report/dup-4242 | Second copy',
  'https://example.org/notes/solo-11 | Solo distinct',
].join('\n');

const previewOk = async (adapter: ImportersAdapter, text: string = DUPE_TEXT) => {
  const res = await adapter.preview({
    fileMeta: { name: 'fixture.txt', size: text.length },
    bytesRef: { kind: 'text', text },
  });
  if (!res.ok) throw new Error(`preview unexpectedly failed: ${res.error.code}`);
  return res.value;
};

const previewWith = async (
  rig: Rig,
  input: { readonly text: string; readonly size?: number; readonly hint?: string },
) =>
  rig.adapter.preview({
    fileMeta: { name: 'fixture.txt', size: input.size ?? input.text.length },
    ...(input.hint !== undefined ? { parserHint: input.hint } : {}),
    bytesRef: { kind: 'text', text: input.text },
  });

const onetabLine = (n: number): string => `https://example.com/row-${String(n)} | Row ${String(n)}`;

describe('E5-T05 adapter laws', () => {
  it('detects the onetab grammar and stamps the model shape (summary is a shape key)', async () => {
    const rig = makeRig();
    const model = await previewOk(rig.adapter);
    expect(model.parserId).toBe('onetab');
    expect(model.missions).toBe(1);
    expect(model.tabs).toBe(3);
    expect(model.dupesHint).toBe(1); // tracker-param dupe collapses on canon form
    expect(model.rejects).toBe(0);
    expect(model.modelSummary).toMatch(/^onetab:m\d+:t\d+:r\d+:d\d+$/);
    expect(model.modelSummary.endsWith(':d1')).toBe(true);
  });

  it('decodes every transport-union member to the same model', async () => {
    const rig = makeRig();
    const asString = await previewOk(rig.adapter);
    const asBytes = await rig.adapter.preview({
      fileMeta: { name: 'f.txt', size: DUPE_TEXT.length },
      bytesRef: { kind: 'bytes', bytes: new TextEncoder().encode(DUPE_TEXT) },
    });
    const asText = await previewOk(rig.adapter);
    expect(asBytes.ok && asBytes.value.tabs).toBe(3);
    expect(asText.tabs).toBe(asString.tabs);
    // Three previews in one stash — the cap-2 sweep already evicted the eldest.
    const stale = await rig.adapter.commit({ previewId: asString.previewId, dedupeMode: 'skip' });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.details?.['reason']).toBe('preview-unknown');
    const live = await rig.adapter.commit({ previewId: asText.previewId, dedupeMode: 'skip' });
    expect(live.ok).toBe(true);
  });

  it('refuses anything outside the transport union as E_FORMAT_UNKNOWN import-bytes', async () => {
    const rig = makeRig();
    for (const bad of [null, undefined, 42, { kind: 'blob', ref: 'x' }, { kind: 'text' }]) {
      const res = await rig.adapter.preview({
        fileMeta: { name: 'f.txt', size: 1 },
        bytesRef: bad,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('E_FORMAT_UNKNOWN');
        expect(res.error.details?.['what']).toBe('import-bytes');
      }
    }
  });

  it('refuses oversized files on fileMeta.size before touching bytes', async () => {
    const rig = makeRig();
    const res = await rig.adapter.preview({
      fileMeta: { name: 'huge.txt', size: IMPORT_MAX_BYTES + 1 },
      bytesRef: { kind: 'text', text: 'x' },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('E_FILE_GUARD');
      expect(res.error.details?.['cap']).toBe(String(IMPORT_MAX_BYTES));
    }
  });

  it('refuses oversized payloads that lie about fileMeta.size (decoded-bytes guard)', async () => {
    const rig = makeRig();
    const fibbing = `https://example.com/a${'x'.repeat(IMPORT_MAX_BYTES)} | Padded`;
    const res = await rig.adapter.preview({
      fileMeta: { name: 'fib.txt', size: 1 },
      bytesRef: { kind: 'text', text: fibbing },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('E_FILE_GUARD');
  });

  it('honors a valid parserHint and refuses an invalid one with the hint echoed', async () => {
    const rig = makeRig();
    const html = '<DL><p><DT><A HREF="https://example.com/x">x</A></DL>';
    const forced = await previewWith(rig, { text: html, hint: 'netscape' });
    expect(forced.ok && forced.value.parserId).toBe('netscape');

    const bogus = await previewWith(rig, { text: DUPE_TEXT, hint: 'not-a-parser' });
    expect(bogus.ok).toBe(false);
    if (!bogus.ok) {
      expect(bogus.error.code).toBe('E_FORMAT_UNKNOWN');
      expect(bogus.error.details?.['what']).toBe('parser-hint');
      expect(bogus.error.details?.['hint']).toBe('not-a-parser');
    }
  });

  it('maps an undetectable file to E_FORMAT_UNKNOWN import-detect', async () => {
    const rig = makeRig();
    const res = await previewWith(rig, { text: 'lorem ipsum dolor sit amet\nnot a bookmark file' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('E_FORMAT_UNKNOWN');
      expect(res.error.details?.['what']).toBe('import-detect');
    }
  });

  it('maps structurally-invalid JSON to E_FORMAT_UNKNOWN import-json (it is NOT the format)', async () => {
    const rig = makeRig();
    const res = await previewWith(rig, { text: '[{"windows": [broken json' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('E_FORMAT_UNKNOWN');
      expect(res.error.details?.['what']).toBe('import-json');
    }
  });

  it('imports an empty SessionBuddy array as an honest zero (not a parse failure)', async () => {
    // A well-formed export with nothing in it previews as zero — refusing it
    // would lie about a legal file. (A whitespace-only blob instead fails
    // detection as import-detect, covered above.)
    const rig = makeRig();
    const res = await previewWith(rig, { text: '[]' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.parserId).toBe('sessionbuddy');
      expect(res.value.tabs).toBe(0);
      expect(res.value.modelSummary).toBe('sessionbuddy:m0:t0:r0:d0');
    }
  });

  it('E_PARSE_REJECTS trips only past the record floor with majority rejects', async () => {
    const rig = makeRig();
    // Under the floor: 15 records, 14 rejects — every record is refused EXCEPT
    // the http anchor line detection needs. Preview survives with a census.
    const small = [
      onetabLine(0),
      ...Array.from({ length: REJECT_FATAL_MIN_RECORDS - 2 }, (_, i) =>
        onetabLine(1 + i).replace('https://', 'javascript:'),
      ),
    ].join('\n');
    const survived = await previewWith(rig, { text: small });
    expect(survived.ok).toBe(true);
    if (survived.ok) expect(survived.value.rejects).toBe(REJECT_FATAL_MIN_RECORDS - 2);

    // Over: floor rejects + 3 good rows → majority → the whole file is refused.
    // (One good row sits first so detection can anchor on the head.)
    const rows = [
      onetabLine(200),
      ...Array.from({ length: REJECT_FATAL_MIN_RECORDS }, (_, i) =>
        onetabLine(100 + i).replace('https://', 'javascript:'),
      ),
      onetabLine(201),
      onetabLine(202),
    ];
    const refused = await previewWith(rig, { text: rows.join('\n') });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe('E_PARSE_REJECTS');
      expect(refused.error.details?.['records']).toBe(String(REJECT_FATAL_MIN_RECORDS + 3));
      expect(refused.error.details?.['rejects']).toBe(String(REJECT_FATAL_MIN_RECORDS));
    }
  });

  it('stop-the-line: a breached parse deadline maps to E_FILE_GUARD parse-time', async () => {
    // The injected clock is honest until the deadline is minted, then jumps past
    // it — the parser's 2000-record probe sees the breach and halts the parse.
    const t = FUTURE;
    let calls = 0;
    const jumpy: Now = () => {
      calls += 1;
      return calls === 1 ? t : t + 3_600_000;
    };
    const adapter = createImportersAdapter({ ids: makeIds(FUTURE), now: jumpy });
    const big = Array.from({ length: 2_001 }, (_, i) => onetabLine(i)).join('\n');
    const res = await adapter.preview({
      fileMeta: { name: 'big.txt', size: big.length },
      bytesRef: { kind: 'text', text: big },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('E_FILE_GUARD');
      expect(res.error.details?.['what']).toBe('parse-time');
    }
    void t; // the clock's base instant (readability anchor)
  });

  it('stamps canon fields at preview; commit echoes them with the rules version', async () => {
    const rig = makeRig();
    const model = await previewOk(rig.adapter);
    const committed = await rig.adapter.commit({ previewId: model.previewId, dedupeMode: 'skip' });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.value.canonRulesV).toBe(CANON_RULES_V1.version);
    expect(committed.value.source).toBe('onetab');
    const urls = committed.value.missions.flatMap((m) => m.tabs);
    for (const tab of urls) {
      expect(tab.urlCanon).toBe(canonicalize(tab.url).canonForm);
      expect(tab.domain.length).toBeGreaterThan(0);
      expect(tab).not.toHaveProperty('dupe'); // stamping material never escapes the family
    }
  });

  it('dedupe skip drops later canon-equal tabs; import-anyway keeps them; the count is stable', async () => {
    const rig = makeRig();
    const model = await previewOk(rig.adapter);

    const skipped = await rig.adapter.commit({ previewId: model.previewId, dedupeMode: 'skip' });
    expect(skipped.ok).toBe(true);
    if (!skipped.ok) return;
    expect(skipped.value.dupes).toBe(1); // reported regardless of mode
    expect(skipped.value.missions.flatMap((m) => m.tabs)).toHaveLength(2);
    const kept = skipped.value.missions.flatMap((m) => m.tabs).map((t) => t.url);
    expect(kept).toContain('https://example.com/report/dup-4242?utm_source=newsletter'); // first wins

    const anyway = await rig.adapter.commit({
      previewId: model.previewId,
      dedupeMode: 'import-anyway',
    });
    expect(anyway.ok).toBe(true);
    if (!anyway.ok) return;
    expect(anyway.value.dupes).toBe(1);
    expect(anyway.value.missions.flatMap((m) => m.tabs)).toHaveLength(3);
  });

  it('batchId := previewId — a double commit replays the same idempotency key', async () => {
    const rig = makeRig();
    const model = await previewOk(rig.adapter);
    const first = await rig.adapter.commit({ previewId: model.previewId, dedupeMode: 'skip' });
    const second = await rig.adapter.commit({ previewId: model.previewId, dedupeMode: 'skip' });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.batchId).toBe(model.previewId);
      expect(second.value.batchId).toBe(first.value.batchId);
    }
  });

  it('a skip-mode commit that empties a mission drops the mission, not the file', async () => {
    const rig = makeRig();
    const onlyDupes = [
      'https://example.com/a?utm_source=x | one',
      'https://example.com/a | two',
    ].join('\n');
    const model = await previewOk(rig.adapter, onlyDupes);
    const committed = await rig.adapter.commit({ previewId: model.previewId, dedupeMode: 'skip' });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.value.missions).toHaveLength(1);
    expect(committed.value.missions[0]?.tabs).toHaveLength(1);
    expect(committed.value.dupes).toBe(1);
  });

  it('commit of an unknown previewId is E_DOMAIN_LEGALITY preview-unknown', async () => {
    const rig = makeRig();
    const res = await rig.adapter.commit({ previewId: 'nope', dedupeMode: 'skip' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('E_DOMAIN_LEGALITY');
      expect(res.error.details?.['reason']).toBe('preview-unknown');
    }
  });

  it('a preview older than its TTL commits as preview-stale and is dropped', async () => {
    const rig = makeRig();
    const model = await previewOk(rig.adapter);
    expect(PREVIEW_TTL_MS).toBe(3_600_000);
    rig.advance(PREVIEW_TTL_MS + 1);
    const res = await rig.adapter.commit({ previewId: model.previewId, dedupeMode: 'skip' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.details?.['reason']).toBe('preview-stale');
    // Already dropped: a second attempt is plain unknown.
    const again = await rig.adapter.commit({ previewId: model.previewId, dedupeMode: 'skip' });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.details?.['reason']).toBe('preview-unknown');
  });

  it('the stash cap evicts the eldest preview first (insertion order, sweep after insert)', async () => {
    const rig = makeRig();
    expect(PREVIEW_STASH_CAP).toBe(2);
    const first = await previewOk(rig.adapter);
    rig.advance(1);
    const second = await previewOk(rig.adapter);
    rig.advance(1);
    const third = await previewOk(rig.adapter);
    const oldest = await rig.adapter.commit({ previewId: first.previewId, dedupeMode: 'skip' });
    expect(oldest.ok).toBe(false);
    if (!oldest.ok) expect(oldest.error.details?.['reason']).toBe('preview-unknown');
    for (const livePreview of [second, third]) {
      const live = await rig.adapter.commit({
        previewId: livePreview.previewId,
        dedupeMode: 'skip',
      });
      expect(live.ok).toBe(true);
    }
  });

  it('fetchRejects returns the quarantined rows for the roadmap "rejects file" UI seam', async () => {
    const rig = makeRig();
    const withRejects = `${DUPE_TEXT}\njavascript:alert(1) | Injected`;
    const model = await previewOk(rig.adapter, withRejects);
    const rows = rig.adapter.fetchRejects(model.previewId);
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.reason).toBe('scheme-quarantine');
    expect(rows?.[0]?.excerpt.length ?? Number.MAX_SAFE_INTEGER).toBeLessThanOrEqual(80);
    expect(rig.adapter.fetchRejects('never-previewed')).toBeUndefined();
  });
});
