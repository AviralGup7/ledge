// E2-T04 · ADR-034 migration chaos — interruption laws at every durability
// boundary of the pipeline. Kill-point realism note: fake-indexeddb cannot
// SIGKILL a JS callback; a THROW inside the upgrade callback drives Dexie down
// the identical abort path the platform takes on a crashed versionchange
// (abort() ⇒ automatic full restore), so KB1 models a partial-write power loss
// faithfully at the layer where atomicity is actually provided.
//   KB1 kill mid-versionchange (after a partial write) → pre-image restored
//        byte-for-byte; the truth engine (journal + checkpoint) unharmed;
//        a clean re-run converges to the golden image.
//   KB2 kill via violated post-condition (ADR-034 law 3: assert phase) → same
//        restoration law, violation primitives disclosed in details.
//   KB3 interrupted checkpoint→migrate sequence: a re-bound capability re-stamps
//        idempotently and the retried migration converges.
//   KB4 kill after commit (before/around post-verify) → re-migrate is a no-op
//        over an already-correct world.
//   KB5 two migrators racing one database → convergence, never corruption
//        (production sequencing is single-writer via boot; this bounds the
//        accidental case).
import { describe, expect, it } from 'vitest';
import { err, ledgeError } from '@/shared-kernel/result/index.js';
import { createJournal } from '@/infrastructure/journal/index.js';
import { INVARIANT_VIOLATION_NAME } from '@/infrastructure/storage/index.js';
import {
  KILL_ERROR_NAME,
  TEST_V2_MAP,
  envOf,
  goldenImage,
  imageOf,
  loadGolden,
  makeCrashMap,
  makeInvariantBreachMap,
  makeRunner,
  makeWorld,
  seedGoldenV1,
  unwrap,
  type MigrationWorld,
} from './testkit.js';

const GOLDEN_DEVICE = '01J0ZK9QW8DEVICEFIXTURE001';
const POISON_ROW_ID = '01POISONPARTIALWRITE0000000';

/** Shared arrange: golden v1 seeded + real journal append + real checkpoint row. */
const arrangeWorld = async (world: MigrationWorld) => {
  await seedGoldenV1(world);
  const journal = createJournal(world.engine);
  unwrap(
    await journal.append([envOf(1, GOLDEN_DEVICE), envOf(2, GOLDEN_DEVICE)], {
      idempotencyKey: 'chaos-arrange-1',
    }),
  );
  const stamped = unwrap(await journal.checkpoint());
  expect(stamped.stamped.length).toBe(1);
  return { journal, capability: async () => journal.checkpoint() };
};

const expectGoldenConvergence = async (runner: ReturnType<typeof makeRunner>) => {
  const actual = imageOf(unwrap(await runner.snapshot()));
  const expected = goldenImage(loadGolden('expected.v2'));
  for (const [store, rows] of Object.entries(expected)) {
    if (store === 'meta') continue;
    expect(actual[store], `${store} converged to golden`).toEqual(rows);
  }
  expect(actual['meta']).toContain(JSON.stringify({ key: 'schemaV', value: 2 }));
};

describe('E2-T04 migration chaos — kill-boundary laws', () => {
  it(
    'KB1: kill mid-versionchange restores the pre-image byte-for-byte; re-run converges',
    { timeout: 120_000 },
    async () => {
      const world = makeWorld();
      const { journal, capability } = await arrangeWorld(world);
      const preImage = imageOf(
        unwrap(await makeRunner(world, TEST_V2_MAP, capability).snapshot(1)),
      );

      // Power loss after a partial write inside the versionchange.
      const crashed = await makeRunner(world, makeCrashMap(), capability).migrate();
      expect(crashed.ok).toBe(false);
      if (!crashed.ok) {
        expect(crashed.error.code).toBe('E_MIGRATION');
        expect(crashed.error.details?.['raw']).toBe(KILL_ERROR_NAME);
      }

      // Restoration law: byte-identical pre-image, zero poison committed...
      const restored = imageOf(
        unwrap(await makeRunner(world, TEST_V2_MAP, capability).snapshot(1)),
      );
      expect(restored).toEqual(preImage);
      expect((restored['tabs'] ?? []).some((row) => row.includes(POISON_ROW_ID))).toBe(false);
      // ...the attempted versionchange evicted the engine's connection (platform
      // law); the v1 world was rolled back, so the engine REOPENS cleanly and the
      // journal still verifies on the same database...
      unwrap(await world.engine.open());
      const scanned = unwrap(await journal.scanTail());
      expect(scanned.status).toBe('ok');
      // ...and a clean re-run converges to exactly the golden expected image.
      const rerun = unwrap(await makeRunner(world, TEST_V2_MAP, capability).migrate());
      expect(rerun.kind).toBe('migrated');
      expect(rerun.checkpointed).toBe(true);
      await expectGoldenConvergence(makeRunner(world, TEST_V2_MAP, capability));
      await world.engine.close();
    },
  );

  it(
    'KB2: violated post-condition aborts with disclosed violation primitives',
    { timeout: 120_000 },
    async () => {
      const world = makeWorld();
      const { capability } = await arrangeWorld(world);
      const preImage = imageOf(
        unwrap(await makeRunner(world, TEST_V2_MAP, capability).snapshot(1)),
      );

      const refused = await makeRunner(world, makeInvariantBreachMap(), capability).migrate();
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.error.code).toBe('E_MIGRATION');
        expect(refused.error.details?.['raw']).toBe(INVARIANT_VIOLATION_NAME);
        expect(refused.error.details?.['store']).toBe('preferences');
        expect(refused.error.details?.['want']).toBe(99);
        expect(refused.error.details?.['got']).toBe(1);
      }
      const restored = imageOf(
        unwrap(await makeRunner(world, TEST_V2_MAP, capability).snapshot(1)),
      );
      expect(restored).toEqual(preImage);

      // The breached attempt evicted the engine connection without migrating —
      // reopen the (restored, v1) world before the retry's checkpoint law runs.
      unwrap(await world.engine.open());
      const rerun = unwrap(await makeRunner(world, TEST_V2_MAP, capability).migrate());
      expect(rerun.kind).toBe('migrated');
      await expectGoldenConvergence(makeRunner(world, TEST_V2_MAP, capability));
      await world.engine.close();
    },
  );

  it(
    'KB3: checkpoint then process death before migrate — retried sequence converges',
    { timeout: 120_000 },
    async () => {
      const world = makeWorld();
      // Phase 1: checkpoint stamped, then the "process" dies before migrate
      // starts (handles dropped; the durable checkpoint row is what survives).
      await seedGoldenV1(world);
      const journal = createJournal(world.engine);
      unwrap(await journal.append([envOf(1, GOLDEN_DEVICE)], { idempotencyKey: 'kb3-arrange' }));
      const firstStamp = unwrap(await journal.checkpoint());
      await world.engine.close();

      // Phase 2: a fresh boot re-binds engine + journal + capability and migrates.
      const world2 = { ...world, engine: world.engine };
      const reopened = await world.engine.open();
      expect(reopened.ok).toBe(true);
      const journal2 = createJournal(world.engine);
      const restamped = unwrap(await journal2.checkpoint());
      // Idempotent re-stamp law: interrupted-then-retried yields the same stamp.
      expect(restamped).toEqual(firstStamp);
      const rerun = unwrap(
        await makeRunner(world2, TEST_V2_MAP, async () => journal2.checkpoint()).migrate(),
      );
      expect(rerun.kind).toBe('migrated');
      await expectGoldenConvergence(
        makeRunner(world2, TEST_V2_MAP, async () => journal2.checkpoint()),
      );
      await world.engine.close();
    },
  );

  it(
    'KB4: kill after commit — re-migrate over the committed world is a no-op',
    { timeout: 120_000 },
    async () => {
      const world = makeWorld();
      const { capability } = await arrangeWorld(world);
      const first = unwrap(await makeRunner(world, TEST_V2_MAP, capability).migrate());
      expect(first.kind).toBe('migrated');
      // "Process dies" here — before any post-migration housekeeping could run.
      // The migrated database is v2 territory: a v1 engine can never open it
      // (foreign-version law). The retry therefore goes runner-only, with a
      // poison capability proving the no-op path returns BEFORE law 1 is engaged.
      await world.engine.close();
      let capabilityTouched = false;
      const poisonCapability = async () => {
        capabilityTouched = true;
        return err(ledgeError('E_MIGRATION', { raw: 'must-not-run' }));
      };
      const again = unwrap(await makeRunner(world, TEST_V2_MAP, poisonCapability).migrate());
      expect(again.kind).toBe('no-op');
      expect(again.checkpointed).toBe(false);
      expect(capabilityTouched).toBe(false);
      await expectGoldenConvergence(makeRunner(world, TEST_V2_MAP, capability));
    },
  );

  it(
    'KB5: two migrators racing one database converge — never corrupt',
    { timeout: 120_000 },
    async () => {
      const world = makeWorld();
      const { capability } = await arrangeWorld(world);
      const a = makeRunner(world, TEST_V2_MAP, capability);
      const b = makeRunner(world, TEST_V2_MAP, capability);
      const [ra, rb] = await Promise.all([a.migrate(), b.migrate()]);
      // Bounded behaviour under a race: at least one call wins the versionchange;
      // a loser may take a typed platform error (its handle was evicted mid-flight)
      // — but every call RESOLVES (no throw escapes) and the world afterwards is
      // exactly the golden one. Production sequencing is single-writer (boot owns
      // migrate); this test bounds the accidental double-fire only. The definitive
      // law is the next line: a fresh migrate over the raced world is an idempotent
      // no-op.
      const oks = [ra, rb].filter((r) => r.ok).length;
      expect(oks).toBeGreaterThanOrEqual(1);
      for (const r of [ra, rb]) {
        if (!r.ok) expect(['E_MIGRATION', 'E_CORRUPT_STORE']).toContain(r.error.code);
      }
      const settle = unwrap(await a.migrate());
      expect(settle.kind).toBe('no-op');
      await expectGoldenConvergence(makeRunner(world, TEST_V2_MAP, capability));
      await world.engine.close();
    },
  );
});
