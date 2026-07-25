// E2-T04 · ADR-034 golden fixture suite (EES §5 law 5: "N-1→N fixture suite").
// The runner's two fixture-driven completion criteria live here:
//   F1  golden N-1→N: pre-state from ops/fixtures/migrations/v1-to-v2/state.v1
//       migrates to EXACTLY ops/.../expected.v2 — whole-image byte equality,
//       with a REAL journal checkpoint capability riding the pre-migration law.
//   F2  the unknown-field round-trip law holds THROUGH a migration (fixtures
//       carry future fields at record/nested/array depth — nothing is dropped
//       or re-shaped by the pure transform).
//   F3  purity law: the same fixture migrated twice in two isolated worlds
//       yields byte-identical images (no wall-clock, no entropy in steps).
import { describe, expect, it } from 'vitest';
import { ok } from '@/shared-kernel/result/index.js';
import { createJournal } from '@/infrastructure/journal/index.js';
import type { CheckpointCapability } from '@/infrastructure/storage/index.js';
import type { MigrationRecord } from '@/infrastructure/storage/index.js';
import {
  TEST_V2_MAP,
  envOf,
  goldenImage,
  imageOf,
  loadGolden,
  makeRunner,
  makeWorld,
  seedGoldenV1,
  unwrap,
} from './testkit.js';

const GOLDEN_DEVICE = '01J0ZK9QW8DEVICEFIXTURE001';

/** Meta rows with the version integer excluded — schemaV is the ONE row a migration lawfully replaces. */
const metaMinusSchemaRow = (
  image: Readonly<Record<string, readonly MigrationRecord[]>>,
): readonly string[] =>
  (image['meta'] ?? [])
    .filter((r) => r['key'] !== 'schemaV')
    .map((r) => JSON.stringify(r))
    .sort();

describe('E2-T04 migration runner — golden fixtures', () => {
  it(
    'F1: N-1→N golden — pre-state migrates to the expected byte image exactly',
    { timeout: 120_000 },
    async () => {
      const world = makeWorld();
      await seedGoldenV1(world);

      // Real pre-migration law: journal over the same physical database, a real
      // append, and the runner's checkpoint capability bound to journal.checkpoint().
      const journal = createJournal(world.engine);
      const batch = [envOf(1, GOLDEN_DEVICE), envOf(2, GOLDEN_DEVICE), envOf(3, GOLDEN_DEVICE)];
      unwrap(await journal.append(batch, { idempotencyKey: 'fixture-batch-1' }));
      const stamped = unwrap(await journal.checkpoint());
      expect(stamped.stamped.length).toBe(1);
      const capability: CheckpointCapability = async () => journal.checkpoint();
      const runner = makeRunner(world, TEST_V2_MAP, capability);

      const preImage = unwrap(await runner.snapshot(1));
      const report = unwrap(await runner.migrate());
      expect(report).toEqual({
        kind: 'migrated',
        fromVersion: 1,
        toVersion: 2,
        stepsApplied: [2],
        checkpointed: true,
      });

      // Whole-image law: post-migration bytes === expected.v2.golden for every
      // golden store, PLUS the truth-engine rows the golden file doesn't list
      // (journal events, heads, idem keys, checkpoint stamps) must survive
      // unmodified — asserted against the live pre-image, not by hand-copied JSON.
      const postImage = unwrap(await runner.snapshot());
      const expected = goldenImage(loadGolden('expected.v2'));
      const actual = imageOf(postImage);
      for (const [store, rows] of Object.entries(expected)) {
        if (store === 'meta') continue; // meta gains live rows below; asserted separately
        expect(actual[store], `store ${store} must equal the expected.v2 golden image`).toEqual(
          rows,
        );
      }
      // Golden meta rows are a subset (live rows added legitimately around them).
      const postMeta = new Set(actual['meta'] ?? []);
      for (const row of expected['meta'] ?? []) {
        expect(postMeta.has(row), `meta must contain golden row ${row}`).toBe(true);
      }
      // Truth-engine survival: journal rows (events, heads, idem keys) are
      // byte-identical after the migration; meta likewise, minus the version
      // integer, which is the one row a migration exists to replace.
      const pre = imageOf(preImage);
      expect(actual['events']).toEqual(pre['events']);
      expect(metaMinusSchemaRow(postImage)).toEqual(metaMinusSchemaRow(preImage));
      await world.engine.close();
    },
  );

  it(
    'F2: unknown fields at every depth round-trip through the migration',
    { timeout: 120_000 },
    async () => {
      const world = makeWorld();
      await seedGoldenV1(world);
      await world.engine.close();
      const runner = makeRunner(world, TEST_V2_MAP, async () => ok({}));
      unwrap(await runner.migrate());
      const post = unwrap(await runner.snapshot());

      const mission = (post['missions'] ?? []).find(
        (r) => r['missionId'] === '01J0ZK9QW8MISSIONFUTUREV9A',
      );
      expect(mission?.['futureFieldV9']).toEqual({
        aiNarrative: 'kept verbatim though this build cannot read it',
        confidence: 0.87,
        tags: ['alpha', 'beta'],
      });
      expect(mission?.['syncVectorV2']).toEqual([3, 1, 4, 1, 5, 9]);
      expect(mission?.['optionalNullV3']).toBeNull();
      expect(mission?.['toggleV4']).toBe(true);

      const tabs = post['tabs'] ?? [];
      const tabV7 = tabs.find((r) => r['ledgeTabId'] === '01J0ZK9QW8TABFUTUREV70001');
      expect(tabV7?.['futureFlagV7']).toBe(true);
      expect(tabV7?.['futureMetaV6']).toEqual({ score: 42 });
      // ...and the transform's ONLY addition: the derived touched marker.
      expect(tabV7?.['lastTouchedAt']).toBe(1785006000000);
      const tabV5 = tabs.find((r) => r['ledgeTabId'] === '01J0ZK9QW8TABAAAAAAAAAAAAA1');
      expect(tabV5?.['futureListV5']).toEqual(['x', { y: 2 }]);
      expect(tabV5?.['missionId']).toBeNull();
    },
  );

  it(
    'F3: purity — the same fixture migrated in two isolated worlds yields identical bytes',
    { timeout: 120_000 },
    async () => {
      const run = async () => {
        const world = makeWorld();
        await seedGoldenV1(world);
        await world.engine.close();
        const runner = makeRunner(world, TEST_V2_MAP, async () => ok({}));
        unwrap(await runner.migrate());
        return imageOf(unwrap(await runner.snapshot()));
      };
      const a = await run();
      const b = await run();
      expect(a).toEqual(b);
    },
  );
});
