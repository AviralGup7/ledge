// E6-T04 · §12 probe catalog (registry v1 — user-ruled F2 "catalog complete =
// definitions exist"): ALL ten SECTION 12 probes are registered here; the two
// v1.1-probes (AI lanes, offscreen spawn) report lifecycle 'unwired' — honest
// grey, never fake green. Every probe is TOTAL (a read fault is a 'fail' row,
// never a throw past the registry boundary).
import type { DiagProbeRow } from '@/application/ports/diagnostics.port.js';
import type { JournalPort } from '@/application/ports/journal.port.js';
import type { ProjectionEnginePort } from '@/application/ports/projection-engine.port.js';
import type { IntentLedgerPort } from '@/application/ports/intent-ledger.port.js';
import type { SearchRankPort } from '@/application/ports/search.port.js';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';

export interface ProbeDeps {
  readonly engine: StorageEnginePort;
  readonly journal: JournalPort;
  readonly projections: ProjectionEnginePort;
  readonly ledger: IntentLedgerPort;
  readonly search: SearchRankPort;
  readonly now: () => number;
}

const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1_000;
const MS_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;
const PERCENT_BASE = 100;
/** §5 storage law 6: quota pressure probe trips at 80%. */
const QUOTA_WARN_RATIO = 0.8;
const DEFAULT_TRASH_RETENTION_DAYS = 30;

const meta = async (engine: StorageEnginePort, key: string): Promise<unknown | undefined> => {
  const r = await engine.txn(['meta'], 'readonly', async (tx) =>
    tx.table<{ readonly key: string; readonly value: unknown }>('meta').get(key),
  );
  return r.ok ? r.value?.['value'] : undefined;
};

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/** The ten §12 definitions in catalog order (stable ids, registry v1). */
export const PROBE_CATALOG: readonly string[] = [
  'journal-tail-freshness',
  'projection-watermark-lag',
  'dangling-intents',
  'storage-quota',
  'compaction-baseline',
  'trash-sweep',
  'ai-lanes',
  'search-index-freshness',
  'offscreen-spawn',
  'boot-report',
];

const fail = (what: string): Omit<DiagProbeRow, 'name'> => ({
  wired: true,
  status: 'fail',
  fields: { error: what },
});

export const createDefaultProbes = (
  deps: ProbeDeps,
): Readonly<Record<string, () => Promise<Omit<DiagProbeRow, 'name'>>>> => ({
  'journal-tail-freshness': async () => {
    const scan = await deps.journal.scanTail();
    if (!scan.ok) return fail(scan.error.code);
    const suspects = scan.value.suspects.length;
    return {
      wired: true,
      status: scan.value.status === 'ok' && suspects === 0 ? 'ok' : 'fail',
      fields: { scan: scan.value.status, suspects, devices: scan.value.devices.length },
    };
  },

  'projection-watermark-lag': async () => {
    const status = await deps.projections.status();
    if (!status.ok) return fail(status.error.code);
    const dirtyViews = status.value.views.filter((v) => v.dirty).map((v) => v.view);
    const watermarkSum = status.value.views.reduce(
      (acc, v) => acc + v.watermarks.reduce((a, w) => a + w.seq, 0),
      0,
    );
    return {
      wired: true,
      status: dirtyViews.length === 0 ? 'ok' : 'warn',
      fields: {
        views: status.value.views.length,
        dirty: dirtyViews.length,
        dirtyList: dirtyViews.join(','),
        watermarkSeqSum: watermarkSum,
      },
    };
  },

  'dangling-intents': async () => {
    const pending = await deps.ledger.pending();
    if (!pending.ok) return fail(pending.error.code);
    const count = pending.value.length;
    return {
      wired: true,
      // Post-boot-reconcile residue is the loss-risk signal — worth one look.
      status: count === 0 ? 'ok' : 'warn',
      fields: { pending: count },
    };
  },

  'storage-quota': async () => {
    const quota = await deps.engine.quota();
    if (!quota.ok) return fail(quota.error.code);
    const ratio = quota.value.pressureRatio;
    if (!quota.value.apiAvailable)
      return {
        wired: true,
        status: 'warn',
        fields: { apiAvailable: false, persisted: quota.value.persisted },
      };
    const over = ratio !== undefined && ratio >= QUOTA_WARN_RATIO;
    return {
      wired: true,
      status: over ? 'warn' : 'ok',
      fields: {
        persisted: quota.value.persisted,
        ...(ratio !== undefined
          ? { pressureRatio: Math.round(ratio * PERCENT_BASE) / PERCENT_BASE }
          : {}),
        warnAt: QUOTA_WARN_RATIO,
      },
    };
  },

  'compaction-baseline': async () => {
    // The compactor is operator/playbook-driven in v1 (no scheduled lane yet —
    // the run-stamp lands with it, adr-noted): the honest signal is whether a
    // purge-epoch baseline exists, with its epoch/throughSeq, never a fake age.
    try {
      const baseline = (await meta(deps.engine, 'purgeEpoch')) as
        { epoch?: unknown; throughSeq?: unknown; status?: unknown } | undefined;
      return {
        wired: true,
        status: 'ok',
        fields: {
          baselinePresent: baseline !== undefined,
          baselineEpoch: num(baseline?.epoch) ?? -1,
          baselineThroughSeq: num(baseline?.throughSeq) ?? -1,
          schedule: 'operator',
        },
      };
    } catch {
      return fail('meta-read');
    }
  },

  'trash-sweep': async () => {
    const retentionSetting = await meta(deps.engine, 'trash.retentionDays');
    const retentionDays =
      typeof retentionSetting === 'object' && retentionSetting !== null
        ? (num((retentionSetting as { value?: unknown }).value) ?? DEFAULT_TRASH_RETENTION_DAYS)
        : DEFAULT_TRASH_RETENTION_DAYS;
    const trash = await deps.engine.txn(['tabs'], 'readonly', async (tx) =>
      tx
        .table<Readonly<Record<string, unknown>>>('tabs')
        .byIndex({ kind: 'equals', name: 'state', value: 'trash' }),
    );
    if (!trash.ok) return fail(trash.error.code);
    const horizon = deps.now() - retentionDays * MS_PER_DAY;
    const overdue = trash.value.filter((row) => {
      const deletedAt = row['deletedAt'];
      return typeof deletedAt === 'number' && deletedAt < horizon;
    }).length;
    return {
      wired: true,
      status: overdue === 0 ? 'ok' : 'warn',
      fields: { inTrash: trash.value.length, overdue, retentionDays },
    };
  },

  'ai-lanes': () =>
    Promise.resolve({
      wired: false,
      status: 'unwired' as const,
      fields: { tier: 'v1.1' },
    }),

  'search-index-freshness': async () => {
    const fresh = await deps.search.freshness();
    if (!fresh.ok) return fail(fresh.error.code);
    const dirty = fresh.value.dirty;
    const built = fresh.value.tokenizerV !== undefined;
    return {
      wired: true,
      status: !built || dirty ? 'warn' : 'ok',
      fields: {
        built,
        dirty,
        ...(fresh.value.tokenizerV !== undefined ? { tokenizerV: fresh.value.tokenizerV } : {}),
      },
    };
  },

  'offscreen-spawn': () =>
    Promise.resolve({
      wired: false,
      status: 'unwired' as const,
      fields: { tier: 'v1.1' },
    }),

  'boot-report': async () => {
    try {
      const slot = (await meta(deps.engine, 'bootReport.latest')) as
        { severity?: unknown; settledAt?: unknown } | undefined;
      const pending =
        slot !== undefined && slot.severity === 'loss-risk' && slot.settledAt === null;
      return {
        wired: true,
        status: pending ? 'warn' : 'ok',
        fields: {
          slot: slot === undefined ? 'absent' : 'present',
          severity: typeof slot?.severity === 'string' ? slot.severity : 'none',
          pending,
        },
      };
    } catch {
      return fail('meta-read');
    }
  },
});

/** Lifecycle probe appended past the §12 ten: redactor self-test status. */
export const SELFTEST_PROBE = 'diag-selftest';

export const selfTestProbe = (degraded: boolean): Omit<DiagProbeRow, 'name'> => ({
  wired: true,
  status: degraded ? 'fail' : 'ok',
  fields: { redactor: degraded ? 'degraded' : 'selftest-pass' },
});
