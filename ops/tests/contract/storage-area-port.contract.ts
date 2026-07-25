// E2-T07 · ADR-032 contract suite — StorageAreaPort laws, adapter-parametric.
// Identical suite runs against every StorageAreaPort binding (fake; reference
// Chrome in stable/beta lanes via storage-area-port.chrome.test.ts). Laws
// transcribe the EES §6 row:
//   A1 absent key → ok(null) — absence is data, never an error (both areas)
//   A2 set→get roundtrip passes values byte-exact (both areas)
//   A3 overwrite law — latest set wins (both areas)
//   A4 session area unavailable → typed E_CAPABILITY on both session ops;
//      local unaffected (Firefox parity — never a silent local fallback)
//   A5 raw rejection mapping: quota-shaped → E_QUOTA, else E_CAPABILITY_API
//   A6 area isolation — local writes are invisible to session and vice versa
//   A7 sessionGet hot-path budget probe (≤2ms/op class; full verification in
//      Chrome lanes) — the crash classification gates every boot on this read
import { describe, expect, it } from 'vitest';
import type { StorageAreaPort } from '@/application/ports/storage-area.port.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';

const unwrap = <T>(r: Result<T, LedgeError>): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.value;
};

export interface StorageAreaPortBinding {
  readonly makeAdapter: () => StorageAreaPort;
  /** Adapter variant with no session area (FF parity); null where impossible. */
  readonly makeSessionlessAdapter: (() => StorageAreaPort) | null;
  /** One-shot storage sabotage; null on real Chrome (cannot sabotage). */
  readonly sabotageStorage: ((cause: unknown) => void) | null;
}

const PERF_OPS = 500;
const SESSION_GET_BUDGET_MS = 50;

export function describeStorageAreaPortContract(
  name: string,
  binding: StorageAreaPortBinding,
): void {
  describe(`StorageAreaPort contract [${name}]`, () => {
    it('A1: absent keys resolve ok(null) in both areas', async () => {
      const port = binding.makeAdapter();
      expect(unwrap(await port.localGet('never-written'))).toBeNull();
      expect(unwrap(await port.sessionGet('never-written'))).toBeNull();
    });

    it('A2: set→get roundtrip is byte-exact in both areas', async () => {
      const port = binding.makeAdapter();
      const marker = {
        schemaV: 1,
        version: '0.7.0',
        nested: { reasons: ['install', 'update'], previous: null },
      };
      unwrap(await port.localSet('k.a2', marker));
      unwrap(await port.sessionSet('k.a2', marker));
      expect(unwrap(await port.localGet('k.a2'))).toEqual(marker);
      expect(unwrap(await port.sessionGet('k.a2'))).toEqual(marker);
    });

    it('A3: overwrite law — latest set wins in both areas', async () => {
      const port = binding.makeAdapter();
      unwrap(await port.localSet('k.a3', 'first'));
      unwrap(await port.localSet('k.a3', 'second'));
      unwrap(await port.sessionSet('k.a3', 1));
      unwrap(await port.sessionSet('k.a3', 2));
      expect(unwrap(await port.localGet('k.a3'))).toBe('second');
      expect(unwrap(await port.sessionGet('k.a3'))).toBe(2);
    });

    it('A4: sessionless browser → typed E_CAPABILITY on session ops; local unaffected', async () => {
      if (binding.makeSessionlessAdapter === null) return; // real Chrome always has session
      const port = binding.makeSessionlessAdapter();
      unwrap(await port.localSet('k.a4', 'fine'));
      expect(unwrap(await port.localGet('k.a4'))).toBe('fine');
      for (const r of [await port.sessionGet('k.a4'), await port.sessionSet('k.a4', 1)]) {
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe('E_CAPABILITY');
      }
    });

    it('A5: raw rejections map to E_QUOTA (quota-shaped) / E_CAPABILITY_API', async () => {
      if (binding.sabotageStorage === null) return; // real-chrome binding cannot sabotage
      const port = binding.makeAdapter();
      binding.sabotageStorage(new Error('QUOTA_BYTES quota exceeded'));
      const quota = await port.sessionSet('k.a5', 'x');
      expect(quota.ok).toBe(false);
      if (!quota.ok) expect(quota.error.code).toBe('E_QUOTA');
      binding.sabotageStorage(new Error('profile locked'));
      const other = await port.localGet('k.a5');
      expect(other.ok).toBe(false);
      if (!other.ok) expect(other.error.code).toBe('E_CAPABILITY_API');
    });

    it('A6: areas are isolated namespaces', async () => {
      const port = binding.makeAdapter();
      unwrap(await port.localSet('k.a6', 'local-only'));
      expect(unwrap(await port.sessionGet('k.a6'))).toBeNull();
      unwrap(await port.sessionSet('k.a6', 'session-only'));
      expect(unwrap(await port.localGet('k.a6'))).toBe('local-only');
    });

    it(`A7: sessionGet budget probe @${PERF_OPS} reads`, { timeout: 60_000 }, async () => {
      const port = binding.makeAdapter();
      unwrap(await port.sessionSet('k.a7', 'hot'));
      const t0 = performance.now();
      for (let i = 0; i < PERF_OPS; i += 1) unwrap(await port.sessionGet('k.a7'));
      const elapsed = performance.now() - t0;
      expect(elapsed).toBeLessThan(SESSION_GET_BUDGET_MS);
    });
  });
}
