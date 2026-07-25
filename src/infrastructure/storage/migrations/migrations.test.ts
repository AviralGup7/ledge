// E2-T04 · ADR-034 migration runner — unit law suite.
//  U1  map validation: gaps / non-unit steps / destructive (null) declarations are
//      programmer bugs — TypeError at construction, never a runtime Result.
//  U2  production map (v1-only) on a fresh world → fresh-install, stamped, engine-openable.
//  U3  fresh-install through the synthetic v2 chain: steps run over empty state,
//      checkpoint capability is NOT consulted (law 1 guards bytes that exist).
//  U4  re-migrate at target → no-op, nothing written, capability untouched.
//  U5  database ahead of the map → E_MIGRATION ahead-of-map (never silently opened).
//  U6  advancing with no checkpoint capability → E_MIGRATION refusal (wiring defect
//      cannot masquerade as a migration), zero bytes changed.
//  U7  checkpoint refusal surfaces VERBATIM (E_JOURNAL_INTEGRITY identity preserved) —
//      conservative law: never migrate over suspect bytes.
//  U8  failure class carries the export-offer recovery copy (ADR-034 calm-error law).
//  U9  ADR-034 budget: spec-sized migration finishes well under 5s.
import { describe, expect, it } from 'vitest';
import { err, ledgeError, ok } from '@/shared-kernel/result/index.js';
import {
  createMigrationRunner,
  PRODUCTION_VERSION_MAP,
  META_SCHEMA_KEY,
} from '@/infrastructure/storage/index.js';
import type { MigrationStep } from '@/infrastructure/storage/index.js';
import { SCHEMA_V1 } from '../schema/schema.v1.js';
import {
  KILL_ERROR_NAME,
  TEST_V2_MAP,
  loadGolden,
  makeCrashMap,
  makeRunner,
  makeWorld,
  seedGoldenV1,
  unwrap,
} from './testkit.js';

const META_KEY = META_SCHEMA_KEY;
const AHEAD_VERSION = 9;
// Heavy-session scale for the ADR-034 <5s law. The CI harness runs on
// fake-indexeddb, which is strictly SLOWER than production Chrome IDB, so a
// pass here is the conservative bound (the law measures "typical" production).
const PERF_ROWS = 1000;
const PERF_BUDGET_MS = 5000;
const PERF_TAB_PREFIX = '01PERFTAB00000000000000';

describe('E2-T04 migration runner — unit laws', () => {
  it('U1: malformed version maps are construction-time TypeErrors', () => {
    const gap: MigrationStep = { from: 1, to: 3, stores: { x: 'id' } };
    expect(() =>
      createMigrationRunner({
        ...makeWorld().runnerDeps,
        versionMap: { baseVersion: 1, baseStores: SCHEMA_V1, steps: [gap] },
      }),
    ).toThrow(TypeError);
    const destructive = {
      from: 1,
      to: 2,
      stores: { tabs: null as unknown as string },
    };
    expect(() =>
      createMigrationRunner({
        ...makeWorld().runnerDeps,
        versionMap: { baseVersion: 1, baseStores: SCHEMA_V1, steps: [destructive] },
      }),
    ).toThrow(/additive/);
    // A well-formed map constructs fine.
    expect(() =>
      createMigrationRunner({ ...makeWorld().runnerDeps, versionMap: PRODUCTION_VERSION_MAP }),
    ).not.toThrow();
  });

  it('U2: production map on a fresh world stamps v1 and leaves an engine-openable database', async () => {
    const world = makeWorld();
    const runner = createMigrationRunner({
      ...world.runnerDeps,
      versionMap: PRODUCTION_VERSION_MAP,
    });
    const report = unwrap(await runner.migrate());
    expect(report.kind).toBe('fresh-install');
    expect(report.fromVersion).toBe(0);
    expect(report.toVersion).toBe(1);
    expect(report.stepsApplied).toEqual([]);
    expect(report.checkpointed).toBe(false);
    // The strongest possible assertion: the production engine accepts the runner's world.
    const opened = await world.engine.open();
    expect(opened.ok).toBe(true);
  });

  it('U3: fresh-install through the v2 chain applies steps without consulting the checkpoint', async () => {
    const world = makeWorld();
    let checkpointCalls = 0;
    const runner = makeRunner(world, TEST_V2_MAP, async () => {
      checkpointCalls += 1;
      return ok({});
    });
    const report = unwrap(await runner.migrate());
    expect(report.kind).toBe('fresh-install');
    expect(report.toVersion).toBe(2);
    expect(report.stepsApplied).toEqual([2]);
    expect(report.checkpointed).toBe(false);
    expect(checkpointCalls).toBe(0);
    const image = unwrap(await runner.snapshot());
    expect(image['preferences']).toEqual([{ key: 'uiScale', value: 1 }]);
    const meta = image['meta'] ?? [];
    expect(meta).toContainEqual({ key: META_KEY, value: 2 });
  });

  it('U4: re-migrate at target is a no-op (idempotence law, checkpoint untouched)', async () => {
    const world = makeWorld();
    await seedGoldenV1(world);
    await world.engine.close();
    let checkpointCalls = 0;
    const capability = async () => {
      checkpointCalls += 1;
      return ok({});
    };
    const runner = makeRunner(world, TEST_V2_MAP, capability);
    unwrap(await runner.migrate());
    expect(checkpointCalls).toBe(1);
    const again = unwrap(await runner.migrate());
    expect(again.kind).toBe('no-op');
    expect(again.stepsApplied).toEqual([]);
    expect(checkpointCalls).toBe(1);
  });

  it('U5: a database ahead of the map is never silently opened', async () => {
    const world = makeWorld();
    unwrap(await world.engine.open());
    const stamped = await world.engine.txn(['meta'], 'readwrite', async (tx) => {
      await tx.table('meta').put({ key: META_KEY, value: AHEAD_VERSION });
    });
    unwrap(stamped);
    await world.engine.close();
    const runner = createMigrationRunner({
      ...world.runnerDeps,
      versionMap: PRODUCTION_VERSION_MAP,
    });
    const result = await runner.migrate();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('E_MIGRATION');
      expect(result.error.details?.['raw']).toBe('ahead-of-map');
    }
  });

  it('U6: advancing without a checkpoint capability is a wiring-defect refusal, zero bytes changed', async () => {
    const world = makeWorld();
    await seedGoldenV1(world);
    const runner = makeRunner(world, TEST_V2_MAP);
    const result = await runner.migrate();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('E_MIGRATION');
      expect(result.error.details?.['raw']).toBe('checkpoint-capability-absent');
    }
    // The world is exactly as it was: the v1 engine still opens and serves its rows.
    unwrap(await world.engine.open());
    const count = unwrap(
      await world.engine.txn(['tabs'], 'readonly', (tx) => tx.table('tabs').count()),
    );
    expect(count).toBe((loadGolden('state.v1').stores['tabs'] ?? []).length);
  });

  it('U7: checkpoint refusal surfaces verbatim — migration never runs over suspect bytes', async () => {
    const world = makeWorld();
    await seedGoldenV1(world);
    const refusal = async () =>
      err(ledgeError('E_JOURNAL_INTEGRITY', { raw: 'segment-crc-mismatch', segmentId: 'seg-x' }));
    const runner = makeRunner(world, TEST_V2_MAP, refusal);
    const result = await runner.migrate();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('E_JOURNAL_INTEGRITY');
      expect(result.error.details?.['segmentId']).toBe('seg-x');
    }
    unwrap(await world.engine.open());
    expect(unwrap(await world.engine.schemaVersion())).toBe(1);
  });

  it('U8: migration failures carry the calm export-offer recovery copy (ADR-034)', async () => {
    const world = makeWorld();
    await seedGoldenV1(world);
    const runner = makeRunner(world, makeCrashMap(), async () => ok({}));
    const result = await runner.migrate();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('E_MIGRATION');
      expect(result.error.details?.['raw']).toBe(KILL_ERROR_NAME);
      expect(result.error.recoveryKey).toBe('msg.recover.export');
      expect(result.error.messageKey).toBe('msg.error.migration');
    }
  });

  it(
    'U9: ADR-034 budget — spec-sized migration finishes well under 5s',
    { timeout: 120_000 },
    async () => {
      const world = makeWorld();
      unwrap(await world.engine.open());
      const rows = Array.from({ length: PERF_ROWS }, (_, n) => ({
        ledgeTabId: `${PERF_TAB_PREFIX}${String(n).padStart(4, '0')}`,
        missionId: '01J0ZK9QW8MISSIONFUTUREV9A',
        state: 'live',
        lastActiveAt: 1785000000000 + n,
      }));
      unwrap(
        await world.engine.txn(['missions', 'tabs'], 'readwrite', async (tx) => {
          await tx.table('missions').put({ missionId: '01J0ZK9QW8MISSIONFUTUREV9A' });
          await tx.table('tabs').putMany(rows);
        }),
      );
      await world.engine.close();
      const runner = makeRunner(world, TEST_V2_MAP, async () => ok({}));
      const started = Date.now();
      const report = unwrap(await runner.migrate());
      const elapsed = Date.now() - started;
      expect(report.kind).toBe('migrated');
      expect(elapsed).toBeLessThan(PERF_BUDGET_MS);
      expect(unwrap(await runner.snapshot())['tabs']?.length).toBe(PERF_ROWS);
    },
  );
});
