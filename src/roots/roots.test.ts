// E1-T12 · composition-root law tests (EES §9.16 AC: "contexts boot with stub adapters").
// Every context composes against injected seams — no chrome, no IDB, no platform entropy.
import { describe, expect, it } from 'vitest';
import { CONTRACT_V, computeContractHash } from '@/application/contracts/index.js';
import type { MessageEnvelope, ValidationOutcome } from '@/application/contracts/index.js';
import type { QuotaStatus } from '@/application/ports/storage-engine.port.js';
import { DEV_A, makeEnv, uniqueKey } from '@/infrastructure/journal/core/testkit.js';
import { createMemoryStorageEngine } from '@/infrastructure/storage/memory/memory-engine.js';
import { isDeviceId, isId } from '@/shared-kernel/identity/index.js';
import { err, ledgeError, ok } from '@/shared-kernel/result/index.js';
import { composeBackgroundGraph } from './bg-root.js';
import { composeWorkroomGraph } from './offscreen-root.js';
import { composeQuietPageGraph } from './page-root.js';

const BAD_DEVICE_ID_BYTES = (): Uint8Array => {
  throw new Error('entropy dead');
};

/** Pressure fixture for the §5 law 6 suite (well under the 80% posture line). */
const PRESSURE_TENTH = 0.1;

describe('bg-root — background graph (ADR-025)', () => {
  it('boots with a stub storage adapter and provisions install identity', async () => {
    const graph = composeBackgroundGraph({ storage: createMemoryStorageEngine() });
    const boot = await graph.boot;
    expect(boot.ok).toBe(true);
    if (boot.ok) expect(isDeviceId(boot.value.deviceId)).toBe(true);
  });

  it('identity survives recomposition over the same engine (restart-proof)', async () => {
    const engine = createMemoryStorageEngine();
    const first = composeBackgroundGraph({ storage: engine });
    const firstBoot = await first.boot;
    expect(firstBoot.ok).toBe(true);
    await engine.close();

    const second = composeBackgroundGraph({ storage: engine });
    const secondBoot = await second.boot;
    expect(secondBoot.ok).toBe(true);
    if (firstBoot.ok && secondBoot.ok) {
      expect(secondBoot.value.deviceId).toBe(firstBoot.value.deviceId);
    }
  });

  it('journal written by one compose survives into the next (append → recompose → read)', async () => {
    const engine = createMemoryStorageEngine();
    const first = composeBackgroundGraph({ storage: engine });
    expect((await first.boot).ok).toBe(true);
    const appended = await first.journal.append([makeEnv(1, 1), makeEnv(2, 2)], {
      idempotencyKey: uniqueKey(),
    });
    expect(appended.ok).toBe(true);
    await engine.close();

    const second = composeBackgroundGraph({ storage: engine });
    expect((await second.boot).ok).toBe(true);
    const read = await second.journal.readRange({ deviceId: DEV_A, fromSeq: 0 });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.events.map((e) => e.seq)).toEqual([1, 2]);
      expect(read.value.durableThrough).toBe(2);
    }
  });

  it('entropy failure at first run halts boot as E_CAPABILITY_ENTROPY (fatal, EES §2.1)', async () => {
    const graph = composeBackgroundGraph({
      storage: createMemoryStorageEngine(),
      randomBytes: BAD_DEVICE_ID_BYTES,
    });
    const boot = await graph.boot;
    expect(boot.ok).toBe(false);
    if (!boot.ok) expect(boot.error.code).toBe('E_CAPABILITY_ENTROPY');
  });

  it('a corrupt deviceId row is an integrity failure, never silently re-minted', async () => {
    const engine = createMemoryStorageEngine();
    const first = composeBackgroundGraph({ storage: engine });
    expect((await first.boot).ok).toBe(true);
    const tampered = await engine.txn(['meta'], 'readwrite', async (tx) => {
      await tx.table<{ key: string; value: unknown }>('meta').put({
        key: 'deviceId',
        value: 'not-a-device-id',
      });
      return true;
    });
    expect(tampered.ok).toBe(true);
    await engine.close();

    const second = composeBackgroundGraph({ storage: engine });
    const boot = await second.boot;
    expect(boot.ok).toBe(false);
    if (!boot.ok) expect(boot.error.code).toBe('E_CORRUPT_STORE');
  });
});

describe('bg-root — §5 law 6 boot storage law (E2-T04)', () => {
  const withStorageMgr = (
    base: ReturnType<typeof createMemoryStorageEngine>,
    quota: QuotaStatus,
    persistAnswer?: boolean,
  ) => ({
    ...base,
    quota: () => Promise.resolve(ok<QuotaStatus>(quota)),
    ...(persistAnswer !== undefined ? { persist: () => Promise.resolve(ok(persistAnswer)) } : {}),
  });

  it('an unavailable storage API degrades to explicit report fields (never fatal)', async () => {
    const graph = composeBackgroundGraph({ storage: createMemoryStorageEngine() });
    const boot = await graph.boot;
    expect(boot.ok).toBe(true);
    if (boot.ok) {
      expect(boot.value.storageLaw).toEqual({
        apiAvailable: false,
        persisted: false,
        requested: false,
        granted: false,
      });
    }
  });

  it('requests persistence when the bucket is not yet durable, surfacing the pressure ratio', async () => {
    const engine = withStorageMgr(
      createMemoryStorageEngine(),
      {
        apiAvailable: true,
        persisted: false,
        usageBytes: 100,
        quotaBytes: 1000,
        pressureRatio: PRESSURE_TENTH,
      },
      true,
    );
    const graph = composeBackgroundGraph({ storage: engine });
    const boot = await graph.boot;
    expect(boot.ok).toBe(true);
    if (boot.ok) {
      expect(boot.value.storageLaw.requested).toBe(true);
      expect(boot.value.storageLaw.granted).toBe(true);
      expect(boot.value.storageLaw.pressureRatio).toBe(PRESSURE_TENTH);
    }
  });

  it('never re-asks when the bucket is already persisted', async () => {
    let persistCalls = 0;
    const base = createMemoryStorageEngine();
    const engine = {
      ...base,
      quota: () => Promise.resolve(ok<QuotaStatus>({ apiAvailable: true, persisted: true })),
      persist: () => {
        persistCalls += 1;
        return Promise.resolve(ok(true));
      },
    };
    const boot = await composeBackgroundGraph({ storage: engine }).boot;
    expect(boot.ok).toBe(true);
    if (boot.ok) {
      expect(boot.value.storageLaw.requested).toBe(false);
      expect(boot.value.storageLaw.granted).toBe(true);
    }
    expect(persistCalls).toBe(0);
  });

  it('a denied persistence request is a valid answer, not a boot failure', async () => {
    const engine = withStorageMgr(
      createMemoryStorageEngine(),
      { apiAvailable: true, persisted: false },
      false,
    );
    const boot = await composeBackgroundGraph({ storage: engine }).boot;
    expect(boot.ok).toBe(true);
    if (boot.ok) {
      expect(boot.value.storageLaw.requested).toBe(true);
      expect(boot.value.storageLaw.granted).toBe(false);
    }
  });

  it('a failing quota probe is redacted into the report while boot proceeds', async () => {
    const base = createMemoryStorageEngine();
    const engine = {
      ...base,
      quota: () => Promise.resolve(err(ledgeError('E_QUOTA', { site: 'boot-law-test' }))),
    };
    const boot = await composeBackgroundGraph({ storage: engine }).boot;
    expect(boot.ok).toBe(true);
    if (boot.ok) {
      expect(boot.value.storageLaw.error).toBe('E_QUOTA');
      expect(boot.value.storageLaw.requested).toBe(false);
    }
  });
});

describe('offscreen-root — workroom graph (ADR-008/025)', () => {
  const validEnsure: MessageEnvelope = {
    v: CONTRACT_V,
    kind: 'event',
    name: 'EnsureWorkroom',
    cid: makeEnv(9, 9).eventId,
    senderContext: 'sw',
    payload: { reasonHint: 'boot' },
    contractHash: computeContractHash(),
  };

  const collect = (): {
    graph: ReturnType<typeof composeWorkroomGraph>;
    outbox: MessageEnvelope[];
  } => {
    const outbox: MessageEnvelope[] = [];
    const graph = composeWorkroomGraph({ transport: { send: (m) => outbox.push(m) } });
    return { graph, outbox };
  };

  it('answers an SW EnsureWorkroom probe with a contract-valid WorkroomReady', () => {
    const { graph, outbox } = collect();
    const outcome = graph.dispatch(validEnsure);
    expect(outcome.type).toBe('ok');
    expect(outbox).toHaveLength(1);
    const reply = outbox.at(0);
    expect(reply?.name).toBe('WorkroomReady');
    expect(reply?.senderContext).toBe('offscreen');
    expect(reply?.kind).toBe('event');
    expect(reply !== undefined && isId(reply.cid)).toBe(true);
    expect(reply?.contractHash).toBe(computeContractHash());
    expect(graph.hello.senderContext).toBe('offscreen');
  });

  it('dispatch is total over hostile input (§3.1: ignore/never throw)', () => {
    const { graph, outbox } = collect();
    const cases: readonly unknown[] = [null, 42, 'noise', { name: 'NoSuchMessage' }];
    const outcomes = cases.map((c): ValidationOutcome => graph.dispatch(c));
    expect(outcomes.map((o) => o.type)).toEqual(['rejected', 'rejected', 'rejected', 'rejected']);
    expect(outbox).toHaveLength(0);
  });

  it('a non-SW probe is validated but earns no reply (§3.6 direction law)', () => {
    const { graph, outbox } = collect();
    const outcome = graph.dispatch({ ...validEnsure, senderContext: 'guardian' });
    expect(outcome.type).toBe('ok');
    expect(outbox).toHaveLength(0);
  });

  it('an unknown-but-well-formed name is ignored, never thrown (§3.1 rule b)', () => {
    const { graph } = collect();
    const outcome = graph.dispatch({ ...validEnsure, name: 'FromTheFuture' });
    expect(outcome.type).toBe('ignored');
  });
});

describe('page-root — quiet-page graph (ADR-005 authority-free)', () => {
  it('composes contract identity only — no storage, no listeners', () => {
    const graph = composeQuietPageGraph();
    expect(graph.context).toBe('quiet');
    expect(graph.hello.senderContext).toBe('quiet');
    expect(graph.hello.contractHash).toBe(computeContractHash());
  });

  it('hash seam overrides for handshake-skew fixtures', () => {
    const graph = composeQuietPageGraph({ contractHash: 'fixed-hash' });
    expect(graph.hello.contractHash).toBe('fixed-hash');
  });
});
