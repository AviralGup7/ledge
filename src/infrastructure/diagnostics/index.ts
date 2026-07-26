// E6-T03/T05 · diagnostics adapter — the §2.15 module behind DiagnosticsPort:
// unified typed observability ring (user-ruled F4: one timeline, one retention
// 500, drop-oldest), redactor with fail-drop law + boot self-test, §12 probe
// registry run, export-bundle assembly (≤10s, ADR-027 local-only), include-
// addresses flip with 24h read-side auto-decay. Drop-safe by constitution:
// log() queues in memory and batch-flushes (EES §6 ≤1ms/log amortized law) —
// queued entries are diagnostics, never truth, so SW death may orphan them.
import type {
  DiagEvent,
  DiagProbeRow,
  DiagRingRow,
  DiagnosticsPort,
} from '@/application/ports/diagnostics.port.js';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import type { IdGenerator, Now } from '@/shared-kernel/identity/index.js';
import { err, ledgeError, ok, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import { fnv1a64 } from '@/shared-kernel/canon/fnv1a.js';
import { redactFields, selfTestRedactor, type PrimitiveFields } from './redactor.js';
import {
  createDefaultProbes,
  PROBE_CATALOG,
  SELFTEST_PROBE,
  selfTestProbe,
  type ProbeDeps,
} from './probes.js';

/** §5 logs ring covenant. */
export const LOG_RING_SLOTS = 500;
/** ADR-027: include-addresses window (auto-decays by observation, no timers). */
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1_000;
export const INCLUDE_ADDRESSES_TTL_MS =
  HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;
/** Batch law: flush the queue at this depth (amortized-write budget). */
export const FLUSH_BATCH = 25;
/** Bundle payload stays far under the §3.1 256KB wire cap (it rides GetHealth). */
export const BUNDLE_RING_ENTRIES = 100;

const META_SLOT_KEY = 'logs.slot';
const META_INCLUDE_KEY = 'diag.includeUntil';
const REF_PREFIX = 'diag';
const QUEUE_CAP = LOG_RING_SLOTS;

interface QueuedEntry {
  readonly event: DiagEvent;
  readonly at: number;
}

/** Ring row as STORED (bundle rows carry the assembled payload under a strip-
 *  listed key so timeline reads stay light). */
interface StoredDiagRow extends DiagRingRow {
  readonly bundleJson?: string | undefined;
}

export const createDiagnosticsAdapter = (deps: {
  readonly engine: StorageEnginePort;
  readonly ids: IdGenerator;
  readonly now: Now;
  readonly probes: ProbeDeps;
  /** Test seam: sabotage the redactor to prove fail-drop (default: production). */
  readonly redact?: typeof redactFields;
}): DiagnosticsPort => {
  const redact = deps.redact ?? redactFields;
  const queue: QueuedEntry[] = [];
  let redactorDegraded = false;
  let droppedSinceFlush = 0;

  const includeActive = async (): Promise<boolean> => {
    const r = await deps.engine.txn(['meta'], 'readonly', async (tx) =>
      tx.table<{ readonly key: string; readonly value: unknown }>('meta').get(META_INCLUDE_KEY),
    );
    if (!r.ok) return false; // read fault ⇒ safest posture: redact
    const until = r.value?.['value'];
    return typeof until === 'number' && until > deps.now();
  };

  const refId = (kind: string): string =>
    `${REF_PREFIX}.${kind}:${String(deps.now())}:${deps.ids.nextId()}`;

  const toRow = async (
    kind: DiagEvent['kind'],
    level: DiagEvent['level'],
    msg: string,
    fields: PrimitiveFields | undefined,
    at: number,
  ): Promise<StoredDiagRow | null> => {
    let redacted: PrimitiveFields | undefined;
    try {
      redacted = redact(fields, await includeActive());
    } catch {
      // FAIL-DROP LAW (EES §2.15): redactor failure ⇒ entry dropped, NEVER raw.
      return null;
    }
    const material = JSON.stringify(redacted ?? {});
    const slotRead = await deps.engine.txn(['meta'], 'readwrite', async (tx) => {
      const row = await tx
        .table<{ readonly key: string; readonly value: unknown }>('meta')
        .get(META_SLOT_KEY);
      const slot = typeof row?.['value'] === 'number' ? row['value'] : 0;
      const next = (slot + 1) % LOG_RING_SLOTS;
      await tx.table('meta').put({ key: META_SLOT_KEY, value: next });
      return slot;
    });
    if (!slotRead.ok) return null;
    return {
      slot: slotRead.value,
      at,
      level,
      kind,
      msg,
      ...(redacted !== undefined ? { fields: redacted } : {}),
      ctxHash: fnv1a64(material),
    };
  };

  const putRows = async (rows: readonly StoredDiagRow[]): Promise<Result<void, LedgeError>> => {
    if (rows.length === 0) return ok(undefined);
    const r = await deps.engine.txn(['logs'], 'readwrite', async (tx) => {
      for (const row of rows) await tx.table('logs').put({ ...row });
    });
    return r.ok ? ok(undefined) : err(r.error);
  };

  const flushQueue = async (): Promise<Result<void, LedgeError>> => {
    if (queue.length === 0) return ok(undefined);
    const batch = queue.splice(0, queue.length);
    const rows: StoredDiagRow[] = [];
    if (droppedSinceFlush > 0) {
      const marker = await toRow(
        'diag',
        'warn',
        'ring-dropped-queued',
        {
          count: droppedSinceFlush,
        },
        deps.now(),
      );
      if (marker !== null) rows.push(marker);
      droppedSinceFlush = 0;
    }
    for (const entry of batch) {
      const row = await toRow(
        entry.event.kind,
        entry.event.level,
        entry.event.msg,
        entry.event.fields,
        entry.at,
      );
      // Each entry independent: one bad apple drops, the batch lands.
      if (row !== null) rows.push(row);
    }
    return putRows(rows);
  };

  const readRing = async (): Promise<Result<readonly StoredDiagRow[], LedgeError>> => {
    const r = await deps.engine.txn(['logs'], 'readonly', async (tx) => tx.table('logs').toArray());
    if (!r.ok) return err(r.error);
    return ok(
      (r.value as readonly (Record<string, unknown> & Partial<StoredDiagRow>)[])
        .filter(
          (row): row is Record<string, unknown> & StoredDiagRow => typeof row['slot'] === 'number',
        )
        .sort((a, b) => b.at - a.at || b.slot - a.slot),
    );
  };

  /** Timeline hygiene: bundle payloads are export artifacts, not timeline rows —
   *  strip them to the naked ring shape (slot/at/level/kind/msg/fields/ctxHash). */
  const stripBundle = (row: StoredDiagRow): DiagRingRow => ({
    slot: row.slot,
    at: row.at,
    level: row.level,
    kind: row.kind,
    msg: row.msg,
    ...(row.fields !== undefined ? { fields: row.fields } : {}),
    ctxHash: row.ctxHash,
  });

  return {
    log: (event) => {
      if (queue.length >= QUEUE_CAP) {
        queue.shift();
        droppedSinceFlush += 1;
      }
      queue.push({ event, at: deps.now() });
      // Fire-and-forget flush at batch depth; failures stay silent (drop-safe).
      if (queue.length >= FLUSH_BATCH) void flushQueue().catch(() => undefined);
    },

    flush: () => flushQueue(),

    report: async (kind, event) => {
      const ref = refId(kind);
      const row = await toRow(kind, event.level, event.msg, event.fields, deps.now());
      if (row === null)
        return err(
          ledgeError('E_OUTPUT_MALFORMED', { what: 'diag-report', reason: 'redactor-drop' }),
        );
      const wrote = await putRows([row]);
      if (!wrote.ok) return err(wrote.error);
      return ok(ref);
    },

    ringDump: async (limit) => {
      const ring = await readRing();
      if (!ring.ok) return err(ring.error);
      return ok(ring.value.slice(0, Math.max(0, limit)).map(stripBundle));
    },

    includeAddressesActive: () => includeActive().then((active) => ok(active)),

    grantIncludeAddresses: async (include) => {
      const value = include ? deps.now() + INCLUDE_ADDRESSES_TTL_MS : 0;
      const r = await deps.engine.txn(['meta'], 'readwrite', async (tx) => {
        await tx.table('meta').put({ key: META_INCLUDE_KEY, value });
      });
      if (!r.ok) return err(r.error);
      const row = await toRow(
        'diag',
        'info',
        'include-flip',
        {
          granted: include,
          until: value,
        },
        deps.now(),
      );
      if (row !== null) await putRows([row]);
      return ok(undefined);
    },

    selfTest: async () => {
      const verdict = selfTestRedactor(redact);
      redactorDegraded = verdict === 'degraded';
      const row = await toRow(
        'diag',
        verdict === 'ok' ? 'info' : 'error',
        'redactor-selftest',
        {
          verdict,
        },
        deps.now(),
      );
      if (row !== null) await putRows([row]);
      return ok(verdict);
    },

    runProbes: async () => {
      const fns = createDefaultProbes(deps.probes);
      const rows: DiagProbeRow[] = [];
      for (const name of PROBE_CATALOG) {
        const probe = fns[name];
        if (probe === undefined) {
          rows.push({
            name,
            wired: false,
            status: 'unwired',
            fields: { registry: 'missing-impl' },
          });
          continue;
        }
        try {
          rows.push({ name, ...(await probe()) });
        } catch {
          rows.push({ name, wired: true, status: 'fail', fields: { error: 'probe-throw' } });
        }
      }
      rows.push({ name: SELFTEST_PROBE, ...selfTestProbe(redactorDegraded) });
      // Signal-not-noise law: a registry run rings ONE row only when something
      // needs a look (a per-open flood would churn the 500-slot ring).
      const needing = rows.filter((r) => r.status === 'warn' || r.status === 'fail').length;
      if (needing > 0) {
        const row = await toRow(
          'probe',
          'warn',
          'probe-run-issues',
          {
            probes: rows.length,
            needing,
          },
          deps.now(),
        );
        if (row !== null) await putRows([row]);
      }
      return ok(rows);
    },

    exportBundle: async () => {
      await flushQueue();
      const include = await includeActive();
      const bundleId = refId('bundle');
      const probes = await createDiagnosticsProbeRun();
      const projections = await deps.probes.projections.status();
      const tail = await deps.probes.journal.scanTail();
      const quota = await deps.engine.quota();
      const ring = await readRing();
      const ringEntries = ring.ok ? ring.value.slice(0, BUNDLE_RING_ENTRIES).map(stripBundle) : [];
      const document = {
        schemaV: 1,
        bundleId,
        generatedAt: deps.now(),
        includeAddresses: include,
        redactor: redactorDegraded ? 'degraded' : 'selftest-pass',
        probes: probes ?? [],
        projections: projections.ok
          ? projections.value.views.map((v) => ({
              view: v.view,
              dirty: v.dirty,
              projectorV: v.projectorV,
            }))
          : { error: 'status-unavailable' },
        journalTailScan: tail.ok
          ? { status: tail.value.status, suspects: tail.value.suspects.length }
          : { error: 'scan-unavailable' },
        storage: quota.ok
          ? { persisted: quota.value.persisted, apiAvailable: quota.value.apiAvailable }
          : { error: 'quota-unavailable' },
        ring: ringEntries,
      };
      const json = JSON.stringify(document);
      const row = await toRow(
        'bundle',
        'info',
        'bundle-exported',
        {
          bundleId,
          size: json.length,
          includeAddresses: include,
        },
        deps.now(),
      );
      if (row === null)
        return err(
          ledgeError('E_OUTPUT_MALFORMED', { what: 'diag-bundle', reason: 'redactor-drop' }),
        );
      const wrote = await putRows([{ ...row, bundleJson: json }]);
      if (!wrote.ok) return err(wrote.error);
      return ok({
        bundleId,
        createdAt: deps.now(),
        includeAddresses: include,
        size: json.length,
        json,
      });

      async function createDiagnosticsProbeRun(): Promise<readonly DiagProbeRow[] | null> {
        const fns = createDefaultProbes(deps.probes);
        const rows: DiagProbeRow[] = [];
        for (const name of PROBE_CATALOG) {
          const probe = fns[name];
          if (probe === undefined) continue;
          try {
            rows.push({ name, ...(await probe()) });
          } catch {
            rows.push({ name, wired: true, status: 'fail', fields: { error: 'probe-throw' } });
          }
        }
        rows.push({ name: SELFTEST_PROBE, ...selfTestProbe(redactorDegraded) });
        return rows;
      }
    },

    lastBundle: async () => {
      const ring = await readRing();
      if (!ring.ok) return err(ring.error);
      const latest = ring.value.find((row) => row.kind === 'bundle');
      if (latest === undefined || typeof latest.bundleJson !== 'string') return ok(null);
      const fields = latest.fields ?? {};
      return ok({
        bundleId: typeof fields['bundleId'] === 'string' ? fields['bundleId'] : refId('bundle.x'),
        createdAt: latest.at,
        includeAddresses: fields['includeAddresses'] === true,
        size: typeof fields['size'] === 'number' ? fields['size'] : latest.bundleJson.length,
        json: latest.bundleJson,
      });
    },
  };
};

export { PROBE_CATALOG, SELFTEST_PROBE };
