// E8-T01 · ai_jobs queue engine unit laws (ops lane, unit project — the memory
// engine is the ADR-032 in-memory binding; the Dexie binding rides the same
// storage contract suite):
//  Q1 enqueue stamps the frozen §5 row (subjectKey=hash(kind,subject,stateHash))
//  Q2 coalescing: a live duplicate answers its own jobId (ADR-017 law 2)
//  Q3 a terminal sibling never blocks a fresh enqueue (new evidence = new job)
//  Q4 lane priority: interactive > maintenance > background; FIFO within a lane
//  Q5 lane admission: claims honor the admitted set only
//  Q6 claim CAS: lease stamped (workerTag, expires=now+LEASE), attempts=1
//  Q7 heartbeat renews the lease; foreign tag / missing row are false
//  Q8 release returns to queued (same owner only)
//  Q9 reclaimExpired re-queues expired claims and is idempotent on a second sweep
// Q10 retry budget: claims past JOB_RETRY_CLAIMS force-collapse to heuristic,
//     and claims past JOB_MAX_CLAIMS fail terminally (attempts-exhausted)
// Q11 markFailed: terminal stamps + reject+count law on the probe counters
// Q12 writeTerminalHinge: the one-fate completion marker; duplicates & stale
//     leases throw (which is what aborts the hinged commit, §5 law 2)
// Q13 stats: lane depths, counted rejections, retention backlog
// Q14 purgeTerminal: >7d terminal rows purge, fresh/queued stay, counters stay
// Q15 done jobs are never re-claimed (lease+marker is the completion authority)
import { describe, expect, it } from 'vitest';
import { openEngine } from '@/infrastructure/journal/core/testkit.js';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import type { AiJobRow } from '@/application/ports/ai-jobs.port.js';
import {
  createAiJobQueue,
  JOB_LEASE_MS,
  JOB_RETRY_CLAIMS,
  subjectKeyFor,
} from '@/infrastructure/ai/job-queue.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';

const WALL = 1_786_000_000_000;
const DAYS = 24 * 60 * 60 * 1_000;

interface Harness {
  readonly engine: StorageEnginePort;
  readonly queue: ReturnType<typeof createAiJobQueue>;
  readonly rows: () => Promise<readonly AiJobRow[]>;
  readonly row: (jobId: string) => Promise<AiJobRow | undefined>;
  seqId: number;
}

const makeHarness = async (): Promise<Harness> => {
  const engine = await openEngine();
  const queue = createAiJobQueue({ engine });
  const h: Harness = {
    engine,
    queue,
    seqId: 0,
    rows: async () => {
      const r = await engine.txn(['ai_jobs'], 'readonly', async (tx) =>
        tx.table<AiJobRow & Readonly<Record<string, unknown>>>('ai_jobs').toArray(),
      );
      if (!r.ok) throw new Error('rows read failed');
      return r.value.filter((row) => !row.jobId.startsWith('__'));
    },
    row: async (jobId) => {
      const r = await engine.txn(['ai_jobs'], 'readonly', async (tx) =>
        tx.table<AiJobRow & Readonly<Record<string, unknown>>>('ai_jobs').get(jobId),
      );
      if (!r.ok) throw new Error('row read failed');
      return r.value;
    },
  };
  return h;
};

const enqueueInput = (
  h: Harness,
  over: Partial<Parameters<Harness['queue']['enqueue']>[0]['job']> = {},
) => ({
  job: {
    kind: 'mission-name' as const,
    subjectId: 'mission-1',
    lane: 'maintenance' as const,
    input: { tabCount: 3, rootDomains: ['a.example'], takenAt: WALL },
    ...over,
  },
  enqueuedAtSeq: 0,
  jobId: `job-${(h.seqId += 1)}`,
  now: WALL,
});

const unwrap = <T>(r: Result<T, LedgeError>): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.value;
};

describe('ai_jobs queue engine laws', () => {
  it('Q1: enqueue stamps the frozen-row shape incl. the §5 subjectKey law', async () => {
    const h = await makeHarness();
    const out = unwrap(await h.queue.enqueue(enqueueInput(h)));
    expect(out.coalesced).toBe(false);
    const row = await h.row(out.jobId);
    expect(row?.state).toBe('queued');
    expect(row?.kind).toBe('mission-name');
    expect(row?.attempts).toBe(0);
    expect(row?.lease).toBeNull();
    expect(row?.artifactRef).toBeUndefined();
    const stateHash = row?.payloadRef.stateHash;
    expect(typeof stateHash).toBe('string');
    expect(row?.subjectKey).toBe(subjectKeyFor('mission-name', 'mission-1', stateHash ?? ''));
    expect(row?.subjectKey.length).toBeGreaterThan(0);
  });

  it('Q2: a live duplicate enqueues nothing (coalesced, one row total)', async () => {
    const h = await makeHarness();
    const first = unwrap(await h.queue.enqueue(enqueueInput(h)));
    const second = unwrap(await h.queue.enqueue(enqueueInput(h)));
    expect(second.jobId).toBe(first.jobId);
    expect(second.coalesced).toBe(true);
    expect((await h.rows()).length).toBe(1);
  });

  it('Q3: terminal siblings never block a fresh enqueue', async () => {
    const h = await makeHarness();
    const first = unwrap(await h.queue.enqueue(enqueueInput(h)));
    unwrap(
      await h.queue.markFailed({ jobId: first.jobId, failureClass: 'provider-error', now: WALL }),
    );
    const second = unwrap(await h.queue.enqueue(enqueueInput(h)));
    expect(second.jobId).not.toBe(first.jobId);
    expect(second.coalesced).toBe(false);
    expect((await h.rows()).length).toBe(2);
  });

  it('Q4: claim order is interactive > maintenance > background, FIFO within lane', async () => {
    const h = await makeHarness();
    const m1 = unwrap(await h.queue.enqueue(enqueueInput(h, { subjectId: 'm1' })));
    const bg1 = unwrap(
      await h.queue.enqueue(enqueueInput(h, { subjectId: 'bg1', lane: 'background' })),
    );
    const i1 = unwrap(
      await h.queue.enqueue(enqueueInput(h, { subjectId: 'i1', lane: 'interactive' })),
    );
    const m2 = unwrap(await h.queue.enqueue(enqueueInput(h, { subjectId: 'm2' })));
    const lanes = ['interactive', 'maintenance', 'background'] as const;
    const order: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const claim = unwrap(await h.queue.claimNext({ lanes, workerTag: `w${i}`, now: WALL }));
      if (claim === null) break;
      order.push(claim.jobId);
    }
    expect(order).toEqual([i1.jobId, m1.jobId, m2.jobId, bg1.jobId]);
  });

  it('Q5: claims honor the admitted lanes only', async () => {
    const h = await makeHarness();
    unwrap(await h.queue.enqueue(enqueueInput(h)));
    const denied = unwrap(
      await h.queue.claimNext({ lanes: ['interactive'], workerTag: 'w', now: WALL }),
    );
    expect(denied).toBeNull();
    const admitted = unwrap(
      await h.queue.claimNext({ lanes: ['maintenance'], workerTag: 'w', now: WALL }),
    );
    expect(admitted?.jobId).toBeDefined();
  });

  it('Q6: claim CAS stamps lease + first attempt', async () => {
    const h = await makeHarness();
    unwrap(await h.queue.enqueue(enqueueInput(h)));
    const claim = unwrap(
      await h.queue.claimNext({ lanes: ['maintenance'], workerTag: 'w1', now: WALL }),
    );
    expect(claim?.state).toBe('claimed');
    expect(claim?.attempts).toBe(1);
    expect(claim?.lease).toEqual({ workerTag: 'w1', expiresAt: WALL + JOB_LEASE_MS });
  });

  it('Q7: heartbeat renews the lease for the owner only', async () => {
    const h = await makeHarness();
    const out = unwrap(await h.queue.enqueue(enqueueInput(h)));
    unwrap(await h.queue.claimNext({ lanes: ['maintenance'], workerTag: 'w1', now: WALL }));
    expect(
      unwrap(await h.queue.heartbeat({ jobId: out.jobId, workerTag: 'w1', now: WALL + 1000 })),
    ).toBe(true);
    const row = await h.row(out.jobId);
    expect(row?.lease).toEqual({ workerTag: 'w1', expiresAt: WALL + 1000 + JOB_LEASE_MS });
    expect(
      unwrap(await h.queue.heartbeat({ jobId: out.jobId, workerTag: 'alien', now: WALL + 2000 })),
    ).toBe(false);
    expect(
      unwrap(await h.queue.heartbeat({ jobId: 'missing', workerTag: 'w1', now: WALL + 2000 })),
    ).toBe(false);
  });

  it('Q8: release returns the job to queued for the owner only', async () => {
    const h = await makeHarness();
    const out = unwrap(await h.queue.enqueue(enqueueInput(h)));
    unwrap(await h.queue.claimNext({ lanes: ['maintenance'], workerTag: 'w1', now: WALL }));
    expect(unwrap(await h.queue.release({ jobId: out.jobId, workerTag: 'alien', now: WALL }))).toBe(
      false,
    );
    expect(unwrap(await h.queue.release({ jobId: out.jobId, workerTag: 'w1', now: WALL }))).toBe(
      true,
    );
    const row = await h.row(out.jobId);
    expect(row?.state).toBe('queued');
    expect(row?.lease).toBeNull();
  });

  it('Q9: reclaim is idempotent (two sweeps, second is a no-op)', async () => {
    const h = await makeHarness();
    const out = unwrap(await h.queue.enqueue(enqueueInput(h)));
    unwrap(await h.queue.claimNext({ lanes: ['maintenance'], workerTag: 'w1', now: WALL }));
    const first = unwrap(await h.queue.reclaimExpired({ now: WALL + JOB_LEASE_MS + 1 }));
    expect(first.reclaimed).toEqual([out.jobId]);
    const second = unwrap(await h.queue.reclaimExpired({ now: WALL + JOB_LEASE_MS + 2 }));
    expect(second.reclaimed).toEqual([]);
    const row = await h.row(out.jobId);
    expect(row?.state).toBe('queued');
    expect(row?.attempts).toBe(1);
  });

  it('Q10: retry budget — forced-heuristic final claim, then attempts-exhausted', async () => {
    const h = await makeHarness();
    const out = unwrap(await h.queue.enqueue(enqueueInput(h)));
    // Claims 1..JOB_RETRY_CLAIMS: normal ladder. Each is released so the next claim lands.
    for (let claim = 1; claim <= JOB_RETRY_CLAIMS; claim += 1) {
      const c = unwrap(
        await h.queue.claimNext({ lanes: ['maintenance'], workerTag: `w${claim}`, now: WALL }),
      );
      expect(c?.jobId).toBe(out.jobId);
      expect(c?.attempts).toBe(claim);
      expect(c?.forceHeuristic).toBeUndefined();
      unwrap(await h.queue.release({ jobId: out.jobId, workerTag: `w${claim}`, now: WALL }));
    }
    // Claim JOB_RETRY+1 = the lane-fallback claim: ladder force-collapses.
    const final = unwrap(
      await h.queue.claimNext({ lanes: ['maintenance'], workerTag: 'wf', now: WALL }),
    );
    expect(final?.attempts).toBe(JOB_RETRY_CLAIMS + 1);
    expect(final?.forceHeuristic).toBe(true);
    unwrap(await h.queue.release({ jobId: out.jobId, workerTag: 'wf', now: WALL }));
    // Anything past JOB_MAX_CLAIMS ⇒ terminal attempts-exhausted, never claimed again.
    const doomed = unwrap(
      await h.queue.claimNext({ lanes: ['maintenance'], workerTag: 'wx', now: WALL }),
    );
    expect(doomed).toBeNull();
    const row = await h.row(out.jobId);
    expect(row?.state).toBe('failed');
    expect(row?.failureClass).toBe('attempts-exhausted');
  });

  it('Q11: markFailed stamps terminal + the reject+count law updates the counters', async () => {
    const h = await makeHarness();
    const a = unwrap(await h.queue.enqueue(enqueueInput(h, { subjectId: 'a' })));
    const b = unwrap(await h.queue.enqueue(enqueueInput(h, { subjectId: 'b' })));
    const c = unwrap(await h.queue.enqueue(enqueueInput(h, { subjectId: 'c' })));
    unwrap(
      await h.queue.markFailed({ jobId: a.jobId, failureClass: 'malformed-artifact', now: WALL }),
    );
    unwrap(
      await h.queue.markFailed({ jobId: b.jobId, failureClass: 'artifact-invalid', now: WALL }),
    );
    unwrap(await h.queue.markFailed({ jobId: c.jobId, failureClass: 'provider-error', now: WALL }));
    // Terminal writes are final (idempotent guard).
    expect(
      unwrap(
        await h.queue.markFailed({ jobId: a.jobId, failureClass: 'artifact-invalid', now: WALL }),
      ),
    ).toBe(false);
    const stats = unwrap(await h.queue.stats({ now: WALL }));
    expect(stats.malformedRejected).toBe(1);
    expect(stats.invalidRejected).toBe(1);
    expect(stats.lanes.find((l) => l.lane === 'maintenance')?.failed).toBe(3);
  });

  it('Q12: the hinged terminal write — marker set; duplicate and stale-lease throw', async () => {
    const h = await makeHarness();
    const out = unwrap(await h.queue.enqueue(enqueueInput(h)));
    unwrap(await h.queue.claimNext({ lanes: ['maintenance'], workerTag: 'w1', now: WALL }));
    // One fate: the write inside a live txn commits marker + artifactRef.
    const committed = await h.engine.txn(['ai_jobs'], 'readwrite', async (tx) => {
      await h.queue.writeTerminalHinge(tx, {
        jobId: out.jobId,
        artifactId: 'art-1',
        workerTag: 'w1',
        now: WALL + 10,
      });
    });
    expect(committed.ok).toBe(true);
    const row = await h.row(out.jobId);
    expect(row?.state).toBe('done');
    expect(row?.artifactRef).toBe('art-1');
    // Duplicate completion ⇒ the hinge THROWS E_DOMAIN_LEGALITY (this is what
    // aborts the §5-law-2 hinged commit in production: event + marker share one
    // fate). The memory engine maps our own thrown envelope to a Result-err.
    const dup = await h.engine.txn(['ai_jobs'], 'readwrite', async (tx) => {
      await h.queue.writeTerminalHinge(tx, {
        jobId: out.jobId,
        artifactId: 'art-2',
        workerTag: 'w1',
        now: WALL + 20,
      });
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.error.code).toBe('E_DOMAIN_LEGALITY');
      expect(String(dup.error.details?.['reason'])).toBe('job-not-claimed:done');
    }
    const after = await h.row(out.jobId);
    expect(after?.artifactRef).toBe('art-1');
  });

  it('Q12b: a stale worker writing against a reclaimed lease aborts (lease-mismatch)', async () => {
    const h = await makeHarness();
    const out = unwrap(await h.queue.enqueue(enqueueInput(h)));
    unwrap(await h.queue.claimNext({ lanes: ['maintenance'], workerTag: 'w1', now: WALL }));
    // Kill window: the lease expires, the sweeper reclaims, a NEW worker claims.
    unwrap(await h.queue.reclaimExpired({ now: WALL + JOB_LEASE_MS + 1 }));
    const second = unwrap(
      await h.queue.claimNext({
        lanes: ['maintenance'],
        workerTag: 'w2',
        now: WALL + JOB_LEASE_MS + 2,
      }),
    );
    expect(second?.lease?.workerTag).toBe('w2');
    // The DEAD worker's late terminal write must abort — it never marks the new claim.
    const stale = await h.engine.txn(['ai_jobs'], 'readwrite', async (tx) => {
      await h.queue.writeTerminalHinge(tx, {
        jobId: out.jobId,
        artifactId: 'art-stale',
        workerTag: 'w1',
        now: WALL + JOB_LEASE_MS + 3,
      });
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(String(stale.error.details?.['reason'])).toBe('lease-mismatch');
    const row = await h.row(out.jobId);
    expect(row?.state).toBe('claimed');
    expect(row?.artifactRef).toBeUndefined();
  });

  it('Q13: stats read lane depths, counted rejections, and the retention backlog', async () => {
    const h = await makeHarness();
    const q1 = unwrap(await h.queue.enqueue(enqueueInput(h, { subjectId: 'q1' })));
    unwrap(await h.queue.enqueue(enqueueInput(h, { subjectId: 'q2', lane: 'interactive' })));
    unwrap(await h.queue.claimNext({ lanes: ['maintenance'], workerTag: 'w1', now: WALL }));
    unwrap(
      await h.queue.markFailed({
        jobId: q1.jobId,
        failureClass: 'malformed-artifact',
        now: WALL - 8 * DAYS,
      }),
    );
    // completedAt is stamped at markFailed-time; simulate an old terminal row.
    await h.engine.txn(['ai_jobs'], 'readwrite', async (tx) => {
      const table = tx.table<AiJobRow & Readonly<Record<string, unknown>>>('ai_jobs');
      const row = await table.get(q1.jobId);
      if (row !== undefined) await table.put({ ...row, completedAt: WALL - 8 * DAYS });
    });
    const stats = unwrap(await h.queue.stats({ now: WALL }));
    expect(stats.lanes.find((l) => l.lane === 'interactive')?.queued).toBe(1);
    expect(stats.lanes.find((l) => l.lane === 'maintenance')?.failed).toBe(1);
    expect(stats.malformedRejected).toBe(1);
    expect(stats.terminalOverRetention).toBe(1);
  });

  it('Q14: retention sweep purges old terminals only (counters row survives)', async () => {
    const h = await makeHarness();
    const a = unwrap(await h.queue.enqueue(enqueueInput(h, { subjectId: 'a' })));
    const b = unwrap(await h.queue.enqueue(enqueueInput(h, { subjectId: 'b' })));
    unwrap(
      await h.queue.markFailed({
        jobId: a.jobId,
        failureClass: 'malformed-artifact',
        now: WALL - 8 * DAYS,
      }),
    );
    await h.engine.txn(['ai_jobs'], 'readwrite', async (tx) => {
      const table = tx.table<AiJobRow & Readonly<Record<string, unknown>>>('ai_jobs');
      const row = await table.get(a.jobId);
      if (row !== undefined) await table.put({ ...row, completedAt: WALL - 8 * DAYS });
    });
    const purged = unwrap(await h.queue.purgeTerminal({ now: WALL }));
    expect(purged.purged).toBe(1);
    const rows = await h.rows();
    expect(rows.map((r) => r.jobId)).toEqual([b.jobId]);
    // The counters row is retention-immortal (probe evidence never purges).
    const stats = unwrap(await h.queue.stats({ now: WALL }));
    expect(stats.malformedRejected).toBe(1);
  });

  it('Q15: done jobs are never re-claimed (marker is the completion authority)', async () => {
    const h = await makeHarness();
    const out = unwrap(await h.queue.enqueue(enqueueInput(h)));
    unwrap(await h.queue.claimNext({ lanes: ['maintenance'], workerTag: 'w1', now: WALL }));
    await h.engine.txn(['ai_jobs'], 'readwrite', async (tx) => {
      await h.queue.writeTerminalHinge(tx, {
        jobId: out.jobId,
        artifactId: 'art',
        workerTag: 'w1',
        now: WALL,
      });
    });
    const again = unwrap(
      await h.queue.claimNext({ lanes: ['maintenance'], workerTag: 'w2', now: WALL }),
    );
    expect(again).toBeNull();
  });
});
