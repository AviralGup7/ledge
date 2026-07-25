// E2-T05 · hub ingest use case (Blueprint line 334/618 batching law + §2.8 ack law).
// The single-writer authority's observation intake:
//   raw chrome events → queued PendingObservations (truth is never dropped at handle
//   time) → mapped against the hydrated identity map → stamped (HLC seq/lamport
//   contiguous per device stream) → journal.append in 20-cap batches on a 50ms
//   window → ack confirmed. §2.8 timeout: 250ms deadline ⇒ exactly one immediate
//   retry against the SAME stamped batch (same eventIds, seqs, HLCs, idempotency
//   key — the journal replays the recorded ack; no double-append is representable).
// Failure posture (conservative): hydration reads the FULL device stream; while the
// journal is unreadable, observations wait in queues and every report discloses the
// stall (errorCode on the flush report) — a stalled pipeline never silently absorbs
// user truth.
import type { AppendAck, JournalPort } from '@/application/ports/journal.port.js';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import type { TabInfo, TabsEvent } from '@/application/ports/tabs.port.js';
import type { WindowsEvent } from '@/application/ports/windows.port.js';
import { advance, type Hlc } from '@/shared-kernel/clock/index.js';
import { canonicalize } from '@/shared-kernel/canon/index.js';
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import type { DeviceId, Id, IdGenerator, Now } from '@/shared-kernel/identity/index.js';
import { err, ledgeError, ok, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import { createBatcher, type Batcher } from './batcher.js';
import { createTabIdentityMap, type TabIdentityMap } from './identity-map.js';
import { mapPending, type CounterField } from './mapper.js';
import type {
  FirstRunReport,
  FlushReport,
  HydrationSummary,
  IngestCounters,
  IngestDraft,
  IngestHub,
  IngestReport,
  IngestScheduler,
  PendingObservation,
} from './types.js';
import { INGEST_ACK_TIMEOUT_MS } from './types.js';

/** meta row for the §3.1 C1 first-run flag (hinged with the crawl batch). */
const META_FIRST_RUN_KEY = 'firstRunDone';
/** §2.8: timeout ⇒ exactly one immediate retry with the same stamped batch. */
const ACK_MAX_ATTEMPTS = 2;

export interface IngestHubDeps {
  readonly journal: JournalPort;
  readonly storage: StorageEnginePort;
  readonly deviceId: DeviceId;
  readonly now: Now;
  readonly ids: IdGenerator;
  readonly scheduler: IngestScheduler;
  readonly ackTimeoutMs?: number | undefined;
}

interface CountedDraft {
  readonly draft: IngestDraft;
  readonly field: CounterField | null;
}

interface StampedBatch {
  readonly envelopes: readonly EventEnvelope[];
  readonly fields: readonly (CounterField | null)[];
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly idempotencyKey: string;
  /** First-run hinge: batch + meta.firstRunDone commit in one txn (C1 exactly-once). */
  readonly firstRunHinge: boolean;
}

/** meta row shape (type alias, StoredRecord-assignable per adapter law). */
type MetaRow = {
  readonly key: string;
  readonly value: unknown;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export function createIngestHub(deps: IngestHubDeps): IngestHub {
  const identity: TabIdentityMap = createTabIdentityMap(deps.ids);
  const counters: Record<CounterField, number> = {
    observed: 0,
    updated: 0,
    activated: 0,
    closed: 0,
    windowsClosed: 0,
    groupsChanged: 0,
    skippedUnknownTab: 0,
  };
  let prevHlc: Hlc | null = null;
  let hydrated = false;
  let hydrating: Promise<Result<HydrationSummary, LedgeError>> | null = null;
  let lastFlush: FlushReport = { kind: 'flush', events: 0, fromSeq: 0, toSeq: 0, attempts: 0 };
  /** Raws that arrived while unhydratable, oldest first (mapped before newer raws). */
  let hubPending: PendingObservation[] = [];
  /** One stamped-but-unacked batch awaiting its next attempt (journal-stalled truth). */
  let retryBatch: StampedBatch | null = null;
  const ackTimeoutMs = deps.ackTimeoutMs ?? INGEST_ACK_TIMEOUT_MS;

  const confirmedSeq = (): number => prevHlc?.seq ?? 0;

  const emitReport = (report: IngestReport): void => {
    hub.onReport?.(report);
  };

  const hydrate = (): Promise<Result<HydrationSummary, LedgeError>> => {
    if (hydrated) {
      return Promise.resolve(
        ok({ events: -1, identities: identity.size(), durableThrough: confirmedSeq() }),
      );
    }
    if (hydrating !== null) return hydrating;
    hydrating = (async (): Promise<Result<HydrationSummary, LedgeError>> => {
      const read = await deps.journal.readRange({ deviceId: deps.deviceId, fromSeq: 0 });
      if (!read.ok) {
        hydrating = null; // memoize success only — every attempt re-verifies.
        return err(read.error);
      }
      let identities = 0;
      let maxLamport = 0;
      for (const entry of read.value.events) {
        maxLamport = Math.max(maxLamport, entry.envelope.hlc.lamport);
        const payload: unknown = entry.envelope.payload;
        if (!isRecord(payload)) continue;
        const ledgeTabId = payload['ledgeTabId'];
        if (entry.envelope.type === 'TabObserved') {
          const browserTabId = payload['browserTabId'];
          const windowId = payload['windowId'];
          if (typeof browserTabId !== 'number' || typeof ledgeTabId !== 'string') continue;
          identity.learn(
            browserTabId,
            ledgeTabId as Id,
            typeof windowId === 'number' ? windowId : 0,
          );
          // A fresh identity is a fresh episode: never closed.
          identity.unclose(ledgeTabId as Id);
          identities += 1;
          continue;
        }
        // Closure finality must survive restarts: replay the stream's lifecycle
        // in order. TabClosedExternal closes the episode; a TabUpdated for the
        // same ledgeTabId only ever exists as a created-supersede (the sole
        // re-arm), so it re-opens. Anything else leaves finality untouched.
        if (typeof ledgeTabId !== 'string') continue;
        if (entry.envelope.type === 'TabClosedExternal') identity.close(ledgeTabId as Id);
        if (entry.envelope.type === 'TabUpdated') identity.unclose(ledgeTabId as Id);
      }
      prevHlc = {
        seq: read.value.durableThrough,
        lamport: maxLamport,
        deviceId: deps.deviceId,
        wallClock: 0,
      };
      hydrated = true;
      hydrating = null;
      return ok({
        events: read.value.events.length,
        identities,
        durableThrough: read.value.durableThrough,
      });
    })();
    return hydrating;
  };

  const countFields = (fields: readonly (CounterField | null)[]): void => {
    for (const f of fields) {
      if (f !== null) counters[f] += 1;
    }
  };

  /** One append raced against the §2.8 deadline; timeout ⇒ exactly one retry, same call. */
  const appendWithRetry = async (
    call: () => Promise<Result<AppendAck, LedgeError>>,
  ): Promise<Result<{ ack: AppendAck; attempts: number }, LedgeError>> => {
    let attempts = 0;
    for (;;) {
      attempts += 1;
      let cancel: () => void = () => undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        cancel = deps.scheduler.after(ackTimeoutMs, () => resolve('timeout'));
      });
      const raced = await Promise.race([call(), timeout]);
      cancel();
      if (raced === 'timeout') {
        if (attempts < ACK_MAX_ATTEMPTS) continue;
        // §2.8 failure class: the caller's deadline passed twice — the batch
        // stays queued (retryBatch) and the report discloses the stall.
        return err(ledgeError('E_DURABILITY_TIMEOUT', { op: 'ingest-append', attempts }));
      }
      if (!raced.ok) return err(raced.error);
      return ok({ ack: raced.value, attempts });
    }
  };

  const stamp = (
    counted: readonly CountedDraft[],
    fields: readonly (CounterField | null)[],
    firstRunHinge: boolean,
  ): StampedBatch | null => {
    if (counted.length === 0 || prevHlc === null) return null;
    const envelopes: EventEnvelope[] = [];
    let cursor = prevHlc;
    const wall = deps.now();
    for (const { draft } of counted) {
      cursor = advance(cursor, wall);
      envelopes.push({
        eventId: deps.ids.nextId(),
        hlc: cursor,
        type: draft.type,
        payload: draft.payload,
        producerContext: 'sw',
      });
    }
    const firstEnvelope = envelopes[0];
    if (firstEnvelope === undefined) return null;
    const fromSeq = confirmedSeq() + 1;
    return {
      envelopes,
      fields,
      fromSeq,
      toSeq: fromSeq + counted.length - 1,
      idempotencyKey: `${firstRunHinge ? 'first-run' : 'ingest'}:${deps.deviceId}:${String(fromSeq)}:${firstEnvelope.eventId}`,
      firstRunHinge,
    };
  };

  const commitAck = (batch: StampedBatch, ack: AppendAck, attempts: number): FlushReport => {
    const last = batch.envelopes[batch.envelopes.length - 1];
    if (last !== undefined) prevHlc = last.hlc;
    countFields(batch.fields);
    lastFlush = {
      kind: 'flush',
      events: batch.envelopes.length,
      fromSeq: ack.fromSeq,
      toSeq: ack.toSeq,
      attempts,
    };
    return lastFlush;
  };

  const durablyAppend = async (batch: StampedBatch): Promise<Result<FlushReport, LedgeError>> => {
    const result = await appendWithRetry(() =>
      batch.firstRunHinge
        ? deps.journal.appendHinged(batch.envelopes, {
            idempotencyKey: batch.idempotencyKey,
            extraStores: ['meta'],
            hinge: async (tx) => {
              await tx.table<MetaRow>('meta').put({ key: META_FIRST_RUN_KEY, value: true });
            },
          })
        : deps.journal.append(batch.envelopes, { idempotencyKey: batch.idempotencyKey }),
    );
    if (!result.ok) return err(result.error);
    return ok(commitAck(batch, result.value.ack, result.value.attempts));
  };

  const stall = (code: string, current: readonly PendingObservation[]): false => {
    hubPending = [...current, ...hubPending];
    lastFlush = { ...lastFlush, events: 0, errorCode: code };
    emitReport(lastFlush);
    return false;
  };

  const onBatch = async (raws: readonly PendingObservation[]): Promise<boolean> => {
    const hyd = await hydrate();
    if (!hyd.ok) return stall(hyd.error.code, raws);
    if (retryBatch !== null) {
      const retried = await durablyAppend(retryBatch);
      if (!retried.ok) return stall(retried.error.code, raws);
      retryBatch = null;
      emitReport(retried.value);
    }

    const wave = [...hubPending, ...raws];
    hubPending = [];
    const fields: (CounterField | null)[] = [];
    const counted: CountedDraft[] = [];
    for (const raw of wave) {
      const mapped = mapPending(raw, identity);
      // Fields track DECISIONS per observation (skips count too) — they commit
      // exactly once the batch outcome is known (failures recount nothing).
      fields.push(mapped.count);
      for (const draft of mapped.drafts) counted.push({ draft, field: mapped.count });
    }
    const stamped = stamp(counted, fields, false);
    if (stamped === null) {
      // Nothing journalable (moves, attaches, skips) — decisions are final now.
      countFields(fields);
      return true;
    }
    const appended = await durablyAppend(stamped);
    if (!appended.ok) {
      retryBatch = stamped;
      lastFlush = { ...lastFlush, events: 0, errorCode: appended.error.code };
      emitReport(lastFlush);
      return false;
    }
    emitReport(appended.value);
    return true;
  };

  const batcher: Batcher<PendingObservation> = createBatcher<PendingObservation>({
    onBatch,
    scheduler: deps.scheduler,
  });

  const hub: IngestHub = {
    hydrate,

    handleTabsEvent: async (event: TabsEvent): Promise<void> => {
      batcher.enqueue({ source: 'tabs', event, ts: deps.now() });
    },

    handleWindowsEvent: async (event: WindowsEvent): Promise<void> => {
      batcher.enqueue({ source: 'windows', event, ts: deps.now() });
    },

    handleGroupChanged: async (input): Promise<void> => {
      batcher.enqueue({ source: 'group', input, ts: deps.now() });
    },

    flush: async (): Promise<Result<FlushReport, LedgeError>> => {
      await batcher.flush();
      // Stall-recovery kick: a stalled batch (or raws buffered while unhydratable)
      // holds no batcher queue items, so nothing else would ever re-attempt it.
      if (retryBatch !== null || hubPending.length > 0) {
        await onBatch([]);
      }
      return ok(lastFlush);
    },

    firstRunIngest: async (
      liveTabs: readonly TabInfo[],
    ): Promise<Result<FirstRunReport, LedgeError>> => {
      const hyd = await hydrate();
      if (!hyd.ok) {
        return ok({
          kind: 'first-run',
          applied: false,
          idempotentSkip: false,
          missionsCreated: 0,
          tabsCaptured: 0,
          errorCode: hyd.error.code,
        });
      }
      await batcher.flush();
      const flagged = await deps.storage.txn(['meta'], 'readonly', async (tx) => {
        const row = await tx.table<MetaRow>('meta').get(META_FIRST_RUN_KEY);
        return row !== undefined && row.value === true;
      });
      if (!flagged.ok) return err(flagged.error);
      if (flagged.value) {
        // §3.1 C1 safe-resend law: flag set ⇒ the crawl already happened.
        return ok({
          kind: 'first-run',
          applied: false,
          idempotentSkip: true,
          missionsCreated: 0,
          tabsCaptured: 0,
        });
      }

      const ts = deps.now();
      const counted: CountedDraft[] = [];
      for (const tab of liveTabs) {
        const resolved = identity.resolve(tab.browserTabId, tab.windowId);
        if (!resolved.isNew) continue; // restart-crawl refresh deltas are E2-T06's
        const canon = canonicalize(tab.url);
        counted.push({
          draft: {
            type: 'TabObserved',
            payload: {
              ledgeTabId: resolved.ledgeTabId,
              browserTabId: tab.browserTabId,
              windowId: tab.windowId,
              ...(tab.groupId !== null ? { groupId: tab.groupId } : {}),
              url: tab.url,
              urlCanon: canon.canonForm,
              canonRulesV: canon.rulesVersion,
              title: tab.title,
              domain: canon.domain,
              ts,
            },
          },
          field: 'observed',
        });
      }

      let applied: boolean;
      let errorCode: string | undefined;
      if (counted.length === 0) {
        // Nothing to journal — the flag must still land (first-run marker law).
        const written = await deps.storage.txn(['meta'], 'readwrite', async (tx) => {
          await tx.table<MetaRow>('meta').put({ key: META_FIRST_RUN_KEY, value: true });
        });
        if (!written.ok) return err(written.error);
        applied = true;
        errorCode = undefined;
      } else {
        const stamped = stamp(
          counted,
          counted.map((c) => c.field),
          true,
        );
        if (stamped === null) {
          applied = false;
          errorCode = 'unhydrated';
        } else {
          // First-run durability hinge (EES §5 law 2 / §3.1 C1): the crawl batch
          // and its firstRunDone flag commit in ONE txn — exactly-once by design.
          const appended = await durablyAppend(stamped);
          applied = appended.ok;
          errorCode = appended.ok ? undefined : appended.error.code;
          if (!appended.ok) retryBatch = stamped;
        }
      }
      const report: FirstRunReport = {
        kind: 'first-run',
        applied,
        idempotentSkip: false,
        missionsCreated: 0,
        tabsCaptured: applied ? counted.length : 0,
        ...(errorCode !== undefined ? { errorCode } : {}),
      };
      emitReport(report);
      return ok(report);
    },

    counters: (): IngestCounters => ({ ...counters }),

    stats: () => ({
      hydrated,
      queued: batcher.depth() + hubPending.length + (retryBatch === null ? 0 : 1),
      nextSeq: confirmedSeq() + 1,
      identities: identity.size(),
    }),
  };

  return hub;
}
