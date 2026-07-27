// E3-T07 · ADR-032 contract suite — OffscreenPort laws, adapter-parametric.
//   O1 absent initially ⇒ hasDocument ok(false)
//   O2 ensure spawns exactly once with table reasons + justification
//   O3 ensure-when-present is adoption ({spawned:false}), never a second create
//   O4 single-document race: create rejects "Only a single..." + doc present ⇒ ok adoption
//   O5 close-when-absent is ok (race-tolerant, kill-tolerant)
//   O6 close-when-present closes; hasDocument flips false
//   O7 close kill-race: close rejects but the doc is already gone ⇒ ok (browser kill wins)
//   O8 capability report: apiPresent + versioned reason table + drift log lives here
//   O9 capability-class rejection (api sabotage) ⇒ err E_CAPABILITY_API
//  O10 reason-enum drift: spawn rejection naming a table reason ⇒ err carries
//      spawnClass + reasonDrift fields AND the capability report logs the drift
import { beforeEach, describe, expect, it } from 'vitest';
import type { OffscreenPort } from '@/application/ports/offscreen.port.js';
import { OFFSCREEN_REASON_TABLE } from '@/infrastructure/chrome/offscreen.adapter.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';

const unwrap = <T>(r: Result<T, LedgeError>): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.value;
};

const unwrapErr = <T>(r: Result<T, LedgeError>): LedgeError => {
  if (r.ok) throw new Error('expected err');
  return r.error;
};

export interface OffscreenPortBinding {
  readonly makeAdapter: () => OffscreenPort;
  /** One-shot sabotage scoped to the NEXT api call. */
  readonly sabotageNext: ((cause: unknown) => void) | null;
  /** One-shot sabotage scoped to the NEXT createDocument call (race windows). */
  readonly sabotageCreateNext: ((cause: unknown) => void) | null;
  /** One-shot sabotage scoped to the NEXT closeDocument call (kill races). */
  readonly sabotageCloseNext: ((cause: unknown) => void) | null;
  /** Browser-kill simulation (absent with no close call); null on lanes that cannot. */
  readonly killDocument: (() => void) | null;
  /** Last createDocument parameters observed (null on lanes that cannot inspect). */
  readonly lastCreate:
    | (() => { readonly reasons: readonly string[]; readonly justification: string } | undefined)
    | null;
}

const SINGLE_DOCUMENT_ERROR = 'Only a single offscreen document may be created.';
const CLOSE_OF_ABSENT_ERROR = 'No current offscreen document.';

export function describeOffscreenPortContract(name: string, binding: OffscreenPortBinding): void {
  describe(`OffscreenPort contract [${name}]`, () => {
    // Browser state is shared across the suite (one document max): every law
    // starts from guaranteed absence — close-when-absent is itself ok (O5).
    beforeEach(async () => {
      await binding.makeAdapter().closeDocument();
    });
    it('O1: absent initially ⇒ hasDocument ok(false)', async () => {
      expect(unwrap(await binding.makeAdapter().hasDocument())).toBe(false);
    });

    it('O2: ensure spawns exactly once; reasons come from the versioned table', async () => {
      const adapter = binding.makeAdapter();
      const handle = unwrap(await adapter.ensureDocument({ spawnClass: 'ai-jobs' }));
      expect(handle.spawned).toBe(true);
      expect(typeof handle.ensuredAt).toBe('number');
      expect(unwrap(await adapter.hasDocument())).toBe(true);
      if (binding.lastCreate !== null) {
        const create = binding.lastCreate();
        expect(create).toBeDefined();
        expect([...(create?.reasons ?? [])]).toEqual([...OFFSCREEN_REASON_TABLE['ai-jobs']]);
        expect((create?.justification ?? '').length).toBeGreaterThan(0);
      }
    });

    it('O3: ensure-when-present is adoption, never a second create', async () => {
      const adapter = binding.makeAdapter();
      unwrap(await adapter.ensureDocument({ spawnClass: 'ai-jobs' }));
      const again = unwrap(await adapter.ensureDocument({ spawnClass: 'export-render' }));
      expect(again.spawned).toBe(false);
    });

    it('O4: single-document race rejection while present ⇒ ok adoption', async () => {
      if (binding.sabotageCreateNext === null) return;
      const adapter = binding.makeAdapter();
      // The race: hasDocument reads false → a sibling wins → createDocument
      // rejects single-doc (in chrome that error class means a document EXISTS)
      // → the adoption read observes it ⇒ ok({spawned:false}), never an error.
      binding.sabotageCreateNext(new Error(SINGLE_DOCUMENT_ERROR));
      const handle = unwrap(await adapter.ensureDocument({ spawnClass: 'ai-jobs' }));
      expect(handle.spawned).toBe(false);
      expect(unwrap(await adapter.hasDocument())).toBe(true);
    });

    it('O5: close-when-absent is ok', async () => {
      expect(unwrap(await binding.makeAdapter().closeDocument())).toEqual({});
    });

    it('O6: close-when-present closes; presence flips', async () => {
      const adapter = binding.makeAdapter();
      unwrap(await adapter.ensureDocument({ spawnClass: 'index-build' }));
      expect(unwrap(await adapter.closeDocument())).toEqual({});
      expect(unwrap(await adapter.hasDocument())).toBe(false);
    });

    it('O7: close kill-race (close rejects BUT the doc is already gone) ⇒ ok', async () => {
      if (binding.sabotageCloseNext === null) return;
      const adapter = binding.makeAdapter();
      unwrap(await adapter.ensureDocument({ spawnClass: 'ai-jobs' }));
      // Browser kills mid-close: the presence read says alive, then the kill wins
      // — closeDocument rejects close-of-absent (that rejection class means the
      // document is already gone) and the second presence read confirms ⇒ ok.
      binding.sabotageCloseNext(new Error(CLOSE_OF_ABSENT_ERROR));
      const r = await adapter.closeDocument();
      expect(r.ok).toBe(true);
      expect(unwrap(await adapter.hasDocument())).toBe(false);
    });

    it('O8: capability report carries apiPresent, the versioned table, and drift log', () => {
      const cap = unwrap(binding.makeAdapter().capability());
      expect(cap.apiPresent).toBe(true);
      expect(cap.reasonTable).toBe(OFFSCREEN_REASON_TABLE);
      expect(Array.isArray(cap.reasonDrift)).toBe(true);
    });

    it('O9: capability-class rejection ⇒ E_CAPABILITY_API', async () => {
      if (binding.sabotageNext === null) return;
      const adapter = binding.makeAdapter();
      binding.sabotageNext(new Error('unknown host error'));
      const e = unwrapErr(await adapter.hasDocument());
      expect(e.code).toBe('E_CAPABILITY_API');
    });

    it('O10: reason-enum drift rejection ⇒ fields on the error + capability drift log', async () => {
      if (binding.sabotageCreateNext === null) return;
      const adapter = binding.makeAdapter();
      // Drift rejections come from createDocument's argument validation — the
      // create leg fails with a drift-shaped message on an absent document.
      binding.sabotageCreateNext(new Error("Invalid value for argument['reasons'] 'WORKERS'"));
      const e = unwrapErr(await adapter.ensureDocument({ spawnClass: 'ai-jobs' }));
      expect(e.code).toBe('E_CAPABILITY_API');
      expect(e.details?.['spawnClass']).toBe('ai-jobs');
      expect(e.details?.['reasonDrift']).toBe('WORKERS');
      const cap = unwrap(adapter.capability());
      expect(cap.reasonDrift).toContain('WORKERS');
    });
  });
}
