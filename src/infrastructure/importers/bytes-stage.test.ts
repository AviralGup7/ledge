// E5-T06 · Bytes-stage laws — the IDB shelf's contract (port-pinned): single
// pending slot, claim-on-read, name/size consistency, TTL residue, quota/store
// error mapping. fake-indexeddb keeps the lane honest; a stubbed-failure
// factory proves the error classes never become throws.
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import type { Now } from '@/shared-kernel/identity/index.js';
import { createImportBytesStage, IMPORT_STAGE_DB, IMPORT_STAGE_TTL_MS } from './bytes-stage.js';

const FUTURE = 1_785_024_000_000;

const makeRig = (start: number = FUTURE) => {
  let t = start;
  const now: Now = () => t;
  const stage = createImportBytesStage({ idb: new IDBFactory(), now });
  return { stage, advance: (ms: number) => (t += ms) };
};

const META = { name: 'tabs.txt', size: 4 };
const BYTES = new Uint8Array([116, 97, 98, 115]); // 'tabs'

describe('E5-T06 import bytes stage', () => {
  it('put then takeMatching returns the staged bytes exactly once (claim-on-read)', async () => {
    const { stage } = makeRig();
    expect(await stage.put({ ...META, bytes: BYTES })).toEqual({
      ok: true,
      value: { staged: true },
    });
    const taken = await stage.takeMatching(META);
    expect(taken.ok).toBe(true);
    if (!taken.ok || taken.value === undefined) return;
    expect(taken.value.name).toBe(META.name);
    expect([...taken.value.bytes]).toEqual([...BYTES]);
    // Claimed: a second take sees an empty shelf, never replays yesterday's bytes.
    const again = await stage.takeMatching(META);
    expect(again.ok && again.value === undefined).toBe(true);
  });

  it('single-slot law: the latest put is the only slot that can ever answer', async () => {
    const { stage } = makeRig();
    await stage.put({ name: 'first.txt', size: 1, bytes: new Uint8Array([1]) });
    await stage.put({ name: 'second.txt', size: 2, bytes: new Uint8Array([2, 2]) });
    // The second staging answers…
    const live = await stage.takeMatching({ name: 'second.txt', size: 2 });
    expect(live.ok && live.value !== undefined).toBe(true);
    // …and afterwards neither name can be served: one slot, claimed once.
    const goneFirst = await stage.takeMatching({ name: 'first.txt', size: 1 });
    const goneSecond = await stage.takeMatching({ name: 'second.txt', size: 2 });
    expect(goneFirst.ok && goneFirst.value === undefined).toBe(true);
    expect(goneSecond.ok && goneSecond.value === undefined).toBe(true);
  });

  it('mismatched fileMeta claims the slot but answers undefined (the lie detector)', async () => {
    const { stage } = makeRig();
    await stage.put({ ...META, bytes: BYTES });
    const wrong = await stage.takeMatching({ name: 'other.txt', size: META.size });
    expect(wrong.ok && wrong.value === undefined).toBe(true);
    const poisoned = await stage.takeMatching(META); // already consumed by the claim
    expect(poisoned.ok && poisoned.value === undefined).toBe(true);
  });

  it('TTL law: residue past the stage TTL answers undefined and sweeps count it', async () => {
    const { stage, advance } = makeRig();
    expect(IMPORT_STAGE_TTL_MS).toBe(900_000);
    await stage.put({ ...META, bytes: BYTES });
    advance(IMPORT_STAGE_TTL_MS + 1);
    const stale = await stage.takeMatching(META);
    expect(stale.ok && stale.value === undefined).toBe(true);
  });

  it('sweep drops only TTL-dead slots and reports honestly', async () => {
    const { stage, advance } = makeRig();
    expect(await stage.sweep()).toEqual({ ok: true, value: { swept: 0 } });
    await stage.put({ ...META, bytes: BYTES });
    expect(await stage.sweep()).toEqual({ ok: true, value: { swept: 0 } }); // still fresh
    advance(IMPORT_STAGE_TTL_MS + 1);
    expect(await stage.sweep()).toEqual({ ok: true, value: { swept: 1 } });
  });

  it('the shelf degrades to typed errors, never throws (failing factory)', async () => {
    const broken = {
      open: () => {
        throw new Error('idb unavailable');
      },
    } as unknown as IDBFactory;
    const stage = createImportBytesStage({ idb: broken, now: () => FUTURE });
    const r = await stage.put({ ...META, bytes: BYTES });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('E_CORRUPT_STORE');
    const take = await stage.takeMatching(META);
    expect(take.ok).toBe(false);
    if (!take.ok) expect(take.error.code).toBe('E_CORRUPT_STORE');
  });

  it('the db name is the published shelf contract (surfaces + SW compose the same one)', () => {
    expect(IMPORT_STAGE_DB).toBe('ledge-import-stage');
  });
});
