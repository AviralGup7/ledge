// E1-T09 · ADR-032 contract suite — StorageEnginePort laws, adapter-parametric.
// The identical suite runs against every storage adapter (today: Dexie; the ADR-013
// reconsider path may add another later). Adding an adapter = one thin binding file
// invoking describeStorageEngineContract with a factory. Suite lives per EES §8
// ("Contract (ports) — identical suite passes per adapter; PR-blocking").
//
// Skeleton law set (E2-T04 extends with migration laws):
//  L1 open idempotent; schema version integer stamped + asserted in meta (EES §2.9)
//  L2 all 15 EES §5 stores exist and round-trip typed CRUD
//  L3 unknown fields round-trip preserved (golden fixtures, forward tolerance)
//  L4 multi-store mutation failure mid-txn commits nothing (EES §5 global law 1)
//  L5 quota()/persist() never throw; unavailable API degrades to values (§5 law 6)
//  L6 use-before-open is a typed invariant breach, not a crash (conservative boot)
//  L7 typed abort envelope inside txn surfaces verbatim and commits nothing
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { STORE_NAMES, type StoreName } from '@/application/ports/storage-stores.catalog.js';
import type {
  StorageEnginePort,
  StorageKey,
  StoredRecord,
} from '@/application/ports/storage-engine.port.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';

interface GoldenCase {
  readonly id: string;
  readonly store: StoreName;
  readonly record: StoredRecord;
}

const GOLDEN: { readonly cases: readonly GoldenCase[] } = JSON.parse(
  readFileSync(
    new URL('../../fixtures/storage/unknown-field.golden.json', import.meta.url),
    'utf8',
  ),
) as { readonly cases: readonly GoldenCase[] };

const unwrap = <T>(r: Result<T, LedgeError>): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.value;
};

/** Primary key of a minimal contract record: the one declared field, or the compound tuple. */
const pkOf = (store: StoreName, rec: StoredRecord): StorageKey =>
  store === 'sessions'
    ? [String(rec['snapshotId']), Number(rec['partIndex'])]
    : (Object.values(rec)[0] as string | number);

/** Minimal valid record per store — primary-key fields only (§5 record column anchors). */
const MINIMAL_RECORDS: Readonly<Record<StoreName, StoredRecord>> = {
  events: { segmentId: 'seg-min', deviceId: 'dev-test', seqStart: 1 },
  intents: { intentId: 'int-min' },
  missions: { missionId: 'mis-min' },
  tabs: { ledgeTabId: 'tab-min' },
  sessions: { snapshotId: 'snp-min', partIndex: 0 },
  recently_closed: { entryId: 'rc-min' },
  memory_artifacts: { artifactId: 'art-min' },
  search_index: { token: 'tok-min' },
  dupe_index: { canonHash: 'dup-min' },
  settings: { key: 'set-min' },
  ai_jobs: { jobId: 'job-min' },
  logs: { slot: 1 },
  favicons: { domainHash: 'fav-min' },
  delta_ring: { ringId: 'rin-min' },
  meta: { key: 'met-min' },
};

export function describeStorageEngineContract(
  adapterLabel: string,
  makeEngine: () => StorageEnginePort,
): void {
  describe(`StorageEnginePort contract [${adapterLabel}]`, () => {
    it('L1: open is idempotent and stamps schema version 1 in meta', async () => {
      const engine = makeEngine();
      expect(unwrap(await engine.open())).toBeUndefined();
      expect(unwrap(await engine.open())).toBeUndefined(); // second open must not corrupt
      expect(unwrap(await engine.schemaVersion())).toBe(1);
      const metaVal = unwrap(
        await engine.txn(['meta'], 'readonly', (tx) => tx.table('meta').get('schemaV')),
      );
      expect((metaVal as { value: unknown } | undefined)?.value).toBe(1);
      await engine.close();
    });

    it('L2: all 15 EES §5 stores accept and return records under CRUD', async () => {
      const engine = makeEngine();
      unwrap(await engine.open());
      for (const store of STORE_NAMES) {
        const rec = MINIMAL_RECORDS[store];
        const pk = pkOf(store, rec);
        unwrap(await engine.txn([store], 'readwrite', (tx) => tx.table(store).put(rec)));
        const readBack = unwrap(
          await engine.txn([store], 'readonly', (tx) => tx.table(store).get(pk)),
        );
        expect(readBack, `${store} round-trip`).toEqual(rec);
        unwrap(await engine.txn([store], 'readwrite', (tx) => tx.table(store).delete(pk)));
        // meta legitimately retains the schemaV stamp written at open() (EES §2.9).
        const expectedCount = store === 'meta' ? 1 : 0;
        expect(
          unwrap(await engine.txn([store], 'readonly', (tx) => tx.table(store).count())),
          `${store} empty after delete`,
        ).toBe(expectedCount);
      }
      await engine.close();
    });

    it('L3: unknown fields round-trip preserved (golden fixtures, forward tolerance)', async () => {
      const engine = makeEngine();
      unwrap(await engine.open());
      expect(GOLDEN.cases.length).toBeGreaterThan(0);
      for (const c of GOLDEN.cases) {
        const pk = pkOf(c.store, c.record);
        const readBack = unwrap(
          await engine.txn([c.store], 'readwrite', async (tx) => {
            await tx.table(c.store).put(c.record);
            return tx.table(c.store).get(pk);
          }),
        );
        expect(readBack, `fixture ${c.id}`).toEqual(c.record);
      }
      await engine.close();
    });

    it('L4: a throw mid-txn spanning multiple stores commits nothing (§5 law 1)', async () => {
      const engine = makeEngine();
      unwrap(await engine.open());
      const r = await engine.txn(['missions', 'tabs'], 'readwrite', async (tx) => {
        await tx.table('missions').put({ missionId: 'mis-atomic' });
        await tx.table('tabs').put({ ledgeTabId: 'tab-atomic', missionId: 'mis-atomic' });
        throw new Error('simulated mid-txn failure');
      });
      expect(r.ok).toBe(false);
      const counts = unwrap(
        await engine.txn(['missions', 'tabs'], 'readonly', async (tx) => ({
          m: await tx.table('missions').get('mis-atomic'),
          t: await tx.table('tabs').get('tab-atomic'),
        })),
      );
      expect(counts.m).toBeUndefined();
      expect(counts.t).toBeUndefined();
      await engine.close();
    });

    it('L5: quota() and persist() never throw and degrade to values when API absent', async () => {
      const engine = makeEngine();
      unwrap(await engine.open());
      const q = unwrap(await engine.quota());
      expect(typeof q.apiAvailable).toBe('boolean');
      expect(typeof q.persisted).toBe('boolean');
      if (q.apiAvailable) {
        expect(
          q.pressureRatio === undefined || (q.pressureRatio >= 0 && q.pressureRatio <= 1),
        ).toBe(true);
      }
      const p = unwrap(await engine.persist());
      expect(typeof p).toBe('boolean');
      await engine.close();
    });

    it('L6: use before open() is a typed invariant breach, never a crash', async () => {
      const engine = makeEngine();
      const r = await engine.txn(['missions'], 'readonly', (tx) => tx.table('missions').count());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('E_CORRUPT_STORE'); // conservative boot law
      const v = await engine.schemaVersion();
      expect(v.ok).toBe(false);
    });

    it('L7: a thrown LedgeError aborts the txn and surfaces verbatim', async () => {
      const engine = makeEngine();
      unwrap(await engine.open());
      const typed: LedgeError = {
        code: 'E_QUOTA',
        retryable: true,
        messageKey: 'msg.error.quota',
        recoveryKey: 'msg.recover.quota',
        details: { probe: 'contract' },
      };
      const r = await engine.txn(['missions'], 'readwrite', async (tx) => {
        await tx.table('missions').put({ missionId: 'mis-doomed' });
        throw typed;
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('E_QUOTA');
        expect(r.error.details?.['probe']).toBe('contract');
      }
      expect(
        unwrap(await engine.txn(['missions'], 'readonly', (tx) => tx.table('missions').count())),
      ).toBe(0);
      await engine.close();
    });

    it('L8: byIndex reads only via declared indexes; undeclared index is a typed error', async () => {
      const engine = makeEngine();
      unwrap(await engine.open());
      const seed = [
        { missionId: 'm1', state: 'active', lastActiveAt: 10 },
        { missionId: 'm2', state: 'active', lastActiveAt: 20 },
        { missionId: 'm3', state: 'archived', lastActiveAt: 30 },
      ] as const;
      unwrap(
        await engine.txn(['missions'], 'readwrite', (tx) => tx.table('missions').putMany(seed)),
      );
      const actives = unwrap(
        await engine.txn(['missions'], 'readonly', (tx) =>
          tx.table('missions').byIndex({ kind: 'equals', name: 'state', value: 'active' }),
        ),
      );
      expect(actives.map((r) => r['missionId']).sort()).toEqual(['m1', 'm2']);
      const windowed = unwrap(
        await engine.txn(['missions'], 'readonly', (tx) =>
          tx.table('missions').byIndex({
            kind: 'between',
            name: '[state+lastActiveAt]',
            lower: ['active', Number.NEGATIVE_INFINITY],
            upper: ['active', Number.POSITIVE_INFINITY],
          }),
        ),
      );
      expect(windowed.map((r) => r['missionId'])).toEqual(['m1', 'm2']); // index-ordered
      const bad = await engine.txn(['missions'], 'readonly', (tx) =>
        tx.table('missions').byIndex({ kind: 'equals', name: 'notAnIndex', value: 'x' }),
      );
      expect(bad.ok).toBe(false);
      await engine.close();
    });
  });
}
