// E8-T01 · infrastructure/ai — the durable AI job queue engine (EES §2.12 ·
// ADR-017). Owns the ai_jobs store rows end-to-end (Blueprint §2.10 "storage
// (jobs)" dependency): coalescing enqueue, lane-gated lease claims, heartbeat
// renewals, idempotent reclaim sweeps, the exactly-once terminal hinge, counted
// rejections, and the 7-day terminal retention sweep.
//
// ISOLATION LAW (ADR-041): this package imports shared-kernel, domain/memory, and
// application PORT TYPES only — no journal, no chrome, no surfaces, no mutation
// verbs. Artifacts exit exclusively through the application's hinged commit; the
// queue's terminal write rides inside that commit as the completion marker
// (EES §2.12 exactly-once law), and its throw aborts both in one fate (§5 law 2).
import type {
  AiClaim,
  AiEnqueueOutcome,
  AiFailureClass,
  AiJobKind,
  AiJobQueuePort,
  AiJobRow,
  AiLane,
  AiQueueStats,
} from '@/application/ports/ai-jobs.port.js';
import { AI_LANES } from '@/application/ports/ai-jobs.port.js';
import type { StorageEnginePort, TxScope } from '@/application/ports/storage-engine.port.js';
import { fnv1a64 } from '@/shared-kernel/canon/fnv1a.js';
import { stableStringify } from '@/shared-kernel/canon/stable-stringify.js';
import { err, ledgeError, ok, type LedgeError, type Result } from '@/shared-kernel/result/index.js';

export interface AiJobQueueDeps {
  readonly engine: StorageEnginePort;
}

/** §3.6 lease window: a beat interval the workroom maintains; 2 missed beats ⇒
 *  reclaim, so the lease horizon is 3 beats upstream (renew on beat ⇒ never
 *  expires while alive, expires exactly after 2 misses). */
const MS_PER_SECOND = 1_000;
const BEAT_SECONDS = 5;
export const JOB_BEAT_MS = BEAT_SECONDS * MS_PER_SECOND;
/** Lease = 3 beats upstream ⇒ exactly the 2-missed-beats reclaim window (§3.6). */
const BEATS_PER_LEASE = 3;
export const JOB_LEASE_MS = BEATS_PER_LEASE * JOB_BEAT_MS;

/** Blueprint §9 row 6 retry budget: 1 initial + 2 retries, then the LANE-FALLBACK
 *  claim runs with the ladder force-collapsed to the heuristic rung. */
export const JOB_RETRY_CLAIMS = 3;
export const JOB_MAX_CLAIMS = JOB_RETRY_CLAIMS + 1;

/** EES §5 ai_jobs retention: terminal rows purge after 7 days. */
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const DAYS_RETAINED = 7;
const TERMINAL_RETENTION_MS =
  DAYS_RETAINED * HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

/** Counted rejections live INSIDE the jobs store as one reserved self-describing
 *  row (Blueprint's "storage (jobs)" dependency boundary — nothing else to write).
 *  The row carries no state/lane/subjectKey fields, so every index walk excludes
 *  it by construction; full primary walks filter it by id. */
const STATS_ROW_ID = '__queue-stats__';

interface AiJobStoreRow extends Readonly<Record<string, unknown>> {
  readonly jobId: string;
  readonly kind?: AiJobKind;
  readonly subjectKey?: string;
  readonly lane?: AiLane;
  readonly state?: string;
  readonly attempts?: number;
  readonly lease?: { readonly workerTag: string; readonly expiresAt: number } | null;
  readonly malformedRejected?: number;
  readonly invalidRejected?: number;
}

const STATS_ROWS_BASE = { jobId: STATS_ROW_ID, malformedRejected: 0, invalidRejected: 0 };

/** subjectKey = hash(kind, subject, stateHash) — EES §5's coalescing key. */
export const subjectKeyFor = (kind: AiJobKind, subjectId: string, stateHash: string): string =>
  fnv1a64(stableStringify([kind, subjectId, stateHash]));

const engineFail = (r: { ok: boolean }, error?: LedgeError): Result<never, LedgeError> =>
  err(error ?? ledgeError('E_CORRUPT_STORE', { what: 'ai-jobs-txn' }));

export function createAiJobQueue(deps: AiJobQueueDeps): AiJobQueuePort {
  const jobsTable = (tx: TxScope) => tx.table<AiJobStoreRow>('ai_jobs');

  const readStatsRow = async (tx: TxScope): Promise<AiJobStoreRow> =>
    (await jobsTable(tx).get(STATS_ROW_ID)) ?? STATS_ROWS_BASE;

  const bumpRejection = async (failureClass: AiFailureClass, tx: TxScope): Promise<void> => {
    const counts = await readStatsRow(tx);
    const malformed =
      (counts.malformedRejected ?? 0) + (failureClass === 'malformed-artifact' ? 1 : 0);
    const invalid = (counts.invalidRejected ?? 0) + (failureClass === 'artifact-invalid' ? 1 : 0);
    await jobsTable(tx).put({
      ...counts,
      malformedRejected: malformed,
      invalidRejected: invalid,
    });
  };

  return {
    enqueue: async ({
      job,
      enqueuedAtSeq,
      jobId,
      now,
    }): Promise<Result<AiEnqueueOutcome, LedgeError>> => {
      const stateHash = fnv1a64(stableStringify(job.input));
      const subjectKey = subjectKeyFor(job.kind, job.subjectId, stateHash);
      const written = await deps.engine.txn(['ai_jobs'], 'readwrite', async (tx) => {
        const table = jobsTable(tx);
        const siblings = await table.byIndex({
          kind: 'equals',
          name: 'subjectKey',
          value: subjectKey,
        });
        // Coalescing law (ADR-017): a live duplicate answers its own jobId —
        // no new row, no storm. Terminal siblings never block a fresh enqueue
        // (new evidence after completion = a new job).
        const live = siblings.find((row) => row.state === 'queued' || row.state === 'claimed');
        if (live !== undefined) return { jobId: live.jobId, coalesced: true };
        const row: AiJobRow = {
          jobId,
          kind: job.kind,
          subjectKey,
          payloadRef: { subjectId: job.subjectId, input: job.input, stateHash },
          lane: job.lane,
          state: 'queued',
          attempts: 0,
          lease: null,
          createdAt: now,
          updatedAt: now,
          enqueuedAtSeq,
        };
        await table.put({ ...row });
        return { jobId, coalesced: false };
      });
      if (!written.ok) return engineFail(written, written.error);
      return ok(written.value);
    },

    claimNext: async ({ lanes, workerTag, now }): Promise<Result<AiClaim | null, LedgeError>> => {
      const claimed = await deps.engine.txn(['ai_jobs'], 'readwrite', async (tx) => {
        const table = jobsTable(tx);
        const queued = await table.byIndex({ kind: 'equals', name: 'state', value: 'queued' });
        const admitted = new Set<AiLane>(lanes);
        const candidates = queued
          .filter((row): row is AiJobStoreRow & { readonly lane: AiLane } => row.lane !== undefined)
          .filter((row) => admitted.has(row.lane))
          .sort((a, b) => {
            const laneOrder = AI_LANES.indexOf(a.lane) - AI_LANES.indexOf(b.lane);
            if (laneOrder !== 0) return laneOrder;
            return Number(a['createdAt'] ?? 0) - Number(b['createdAt'] ?? 0);
          });
        for (const candidate of candidates) {
          const attempts = (candidate.attempts ?? 0) + 1;
          if (attempts > JOB_MAX_CLAIMS) {
            // Retry budget fully spent — the job is terminally failed HERE rather
            // than claimed forever (attempts-exhausted, counted as terminal fact).
            await table.put({
              ...candidate,
              state: 'failed',
              failureClass: 'attempts-exhausted' satisfies AiFailureClass,
              lease: null,
              completedAt: now,
              updatedAt: now,
            });
            continue;
          }
          // Lane-fallback demotion (§9 row 6): past the retry window the ladder
          // runs force-collapsed to the heuristic rung on the final claim.
          const forceHeuristic = attempts > JOB_RETRY_CLAIMS ? true : undefined;
          const row: AiJobRow = {
            ...(candidate as unknown as AiJobRow),
            state: 'claimed',
            attempts,
            lease: { workerTag, expiresAt: now + JOB_LEASE_MS },
            ...(forceHeuristic !== undefined ? { forceHeuristic } : {}),
            updatedAt: now,
          };
          await table.put({ ...row });
          return row;
        }
        return null;
      });
      if (!claimed.ok) return engineFail(claimed, claimed.error);
      return ok(claimed.value);
    },

    heartbeat: async ({ jobId, workerTag, now }): Promise<Result<boolean, LedgeError>> => {
      const renewed = await deps.engine.txn(['ai_jobs'], 'readwrite', async (tx) => {
        const table = jobsTable(tx);
        const row = await table.get(jobId);
        if (row === undefined || row.state !== 'claimed') return false;
        if (row.lease?.workerTag !== workerTag) return false;
        await table.put({
          ...row,
          lease: { workerTag, expiresAt: now + JOB_LEASE_MS },
          updatedAt: now,
        });
        return true;
      });
      if (!renewed.ok) return engineFail(renewed, renewed.error);
      return ok(renewed.value);
    },

    release: async ({ jobId, workerTag, now }): Promise<Result<boolean, LedgeError>> => {
      const released = await deps.engine.txn(['ai_jobs'], 'readwrite', async (tx) => {
        const table = jobsTable(tx);
        const row = await table.get(jobId);
        if (row === undefined || row.state !== 'claimed') return false;
        if (row.lease?.workerTag !== workerTag) return false;
        await table.put({ ...row, state: 'queued', lease: null, updatedAt: now });
        return true;
      });
      if (!released.ok) return engineFail(released, released.error);
      return ok(released.value);
    },

    reclaimExpired: async ({
      now,
    }): Promise<Result<{ reclaimed: readonly string[] }, LedgeError>> => {
      const reclaimed = await deps.engine.txn(['ai_jobs'], 'readwrite', async (tx) => {
        const table = jobsTable(tx);
        const claimedRows = await table.byIndex({
          kind: 'equals',
          name: 'state',
          value: 'claimed',
        });
        const expired = claimedRows.filter((row) => {
          const expiresAt = row.lease?.expiresAt;
          return typeof expiresAt === 'number' && expiresAt < now;
        });
        for (const row of expired) {
          await table.put({ ...row, state: 'queued', lease: null, updatedAt: now });
        }
        return { reclaimed: expired.map((row) => row.jobId) };
      });
      if (!reclaimed.ok) return engineFail(reclaimed, reclaimed.error);
      return ok(reclaimed.value);
    },

    markFailed: async ({ jobId, failureClass, now }): Promise<Result<boolean, LedgeError>> => {
      const failed = await deps.engine.txn(['ai_jobs'], 'readwrite', async (tx) => {
        const table = jobsTable(tx);
        const row = await table.get(jobId);
        if (row === undefined) return false;
        if (row.state === 'done' || row.state === 'failed') return false;
        await table.put({
          ...row,
          state: 'failed',
          failureClass,
          lease: null,
          completedAt: now,
          updatedAt: now,
        });
        if (failureClass === 'malformed-artifact' || failureClass === 'artifact-invalid') {
          await bumpRejection(failureClass, tx);
        }
        return true;
      });
      if (!failed.ok) return engineFail(failed, failed.error);
      return ok(failed.value);
    },

    markSilentDone: async ({ jobId, now }): Promise<Result<boolean, LedgeError>> => {
      // E8-T05 (Spec §6.9): lawful absence — terminal 'done' with NO artifactRef
      // and NO rejection count. The stats probe derives the silence census from
      // exactly this shape (done ∧ no artifactRef); the row shape stays frozen.
      const silenced = await deps.engine.txn(['ai_jobs'], 'readwrite', async (tx) => {
        const table = jobsTable(tx);
        const row = await table.get(jobId);
        if (row === undefined) return false;
        if (row.state === 'done' || row.state === 'failed') return false;
        await table.put({ ...row, state: 'done', lease: null, completedAt: now, updatedAt: now });
        return true;
      });
      if (!silenced.ok) return engineFail(silenced, silenced.error);
      return ok(silenced.value);
    },

    writeTerminalHinge: async (tx, { jobId, artifactId, workerTag, now }): Promise<void> => {
      const table = jobsTable(tx);
      const row = await table.get(jobId);
      if (row === undefined) {
        throw ledgeError('E_DOMAIN_LEGALITY', { operation: 'ai-terminal', reason: 'job-missing' });
      }
      // Exactly-once law: a duplicate completion (redelivered result, double
      // resolve) aborts the ENTIRE hinged commit — event and marker share fate.
      if (row.state !== 'claimed') {
        throw ledgeError('E_DOMAIN_LEGALITY', {
          operation: 'ai-terminal',
          reason: `job-not-claimed:${row.state ?? 'unknown'}`,
        });
      }
      // Stale-worker law: a reclaimed job owes the OLD worker nothing — its
      // completion must not mark the new owner's claim.
      if (row.lease?.workerTag !== workerTag) {
        throw ledgeError('E_DOMAIN_LEGALITY', {
          operation: 'ai-terminal',
          reason: 'lease-mismatch',
        });
      }
      await table.put({
        ...row,
        state: 'done',
        artifactRef: artifactId,
        lease: null,
        completedAt: now,
        updatedAt: now,
      });
    },

    stats: async ({ now }): Promise<Result<AiQueueStats, LedgeError>> => {
      const read = await deps.engine.txn(['ai_jobs'], 'readonly', async (tx) => {
        const table = jobsTable(tx);
        const all = await table.toArray();
        const counts = await readStatsRow(tx);
        const lanes = AI_LANES.map((lane) => ({
          lane,
          queued: 0,
          claimed: 0,
          done: 0,
          failed: 0,
        }));
        let terminalOverRetention = 0;
        let silentDone = 0;
        const horizon = now - TERMINAL_RETENTION_MS;
        for (const row of all) {
          if (row.jobId === STATS_ROW_ID) continue;
          const depth = lanes.find((l) => l.lane === row.lane);
          const state = row.state as 'queued' | 'claimed' | 'done' | 'failed' | undefined;
          if (depth !== undefined && state !== undefined) depth[state] += 1;
          const terminal = state === 'done' || state === 'failed';
          if (terminal && Number(row['completedAt'] ?? 0) < horizon) terminalOverRetention += 1;
          // E8-T05: the silence census — done rows the hinge never stamped.
          if (state === 'done' && row['artifactRef'] === undefined) silentDone += 1;
        }
        return {
          lanes,
          malformedRejected: counts.malformedRejected ?? 0,
          invalidRejected: counts.invalidRejected ?? 0,
          terminalOverRetention,
          silentDone,
        } satisfies AiQueueStats;
      });
      if (!read.ok) return engineFail(read, read.error);
      return ok(read.value);
    },

    purgeTerminal: async ({ now }): Promise<Result<{ purged: number }, LedgeError>> => {
      const purged = await deps.engine.txn(['ai_jobs'], 'readwrite', async (tx) => {
        const table = jobsTable(tx);
        const horizon = now - TERMINAL_RETENTION_MS;
        const doomed: string[] = [];
        for (const state of ['done', 'failed'] as const) {
          const rows = await table.byIndex({ kind: 'equals', name: 'state', value: state });
          for (const row of rows) {
            if (Number(row['completedAt'] ?? 0) < horizon) doomed.push(row.jobId);
          }
        }
        await table.deleteMany(doomed);
        return { purged: doomed.length };
      });
      if (!purged.ok) return engineFail(purged, purged.error);
      return ok(purged.value);
    },
  };
}
