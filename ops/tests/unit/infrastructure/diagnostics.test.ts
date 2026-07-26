// E6-T03/T05 · diagnostics module unit laws (ops lane, unit project) — redactor
// hash posture + fail-drop PROOF (the row's completion gate), unified-ring
// retention/batching, include-flip 24h auto-decay fixture, §12 probe registry
// honesty, bundle assembly under the ≤10s budget.
import { describe, expect, it } from 'vitest';
import { fnv1a64 } from '@/shared-kernel/canon/fnv1a.js';
import { createIdGenerator } from '@/shared-kernel/identity/index.js';
import { openEngine, testId } from '@/infrastructure/journal/core/testkit.js';
import { err, ledgeError, ok, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import type { JournalPort, JournalIntegrityReport } from '@/application/ports/journal.port.js';
import type { ProjectionEnginePort } from '@/application/ports/projection-engine.port.js';
import type { IntentLedgerPort, IntentRecord } from '@/application/ports/intent-ledger.port.js';
import type { SearchRankPort } from '@/application/ports/search.port.js';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import {
  redactFields,
  redactString,
  selfTestRedactor,
} from '@/infrastructure/diagnostics/redactor.js';
import {
  BUNDLE_RING_ENTRIES,
  createDiagnosticsAdapter,
  FLUSH_BATCH,
  INCLUDE_ADDRESSES_TTL_MS,
  LOG_RING_SLOTS,
} from '@/infrastructure/diagnostics/index.js';
import { PROBE_CATALOG, SELFTEST_PROBE } from '@/infrastructure/diagnostics/probes.js';

const WALL_BASE = 1_786_000_000_000;
const ID_FILL = 3;

let wall = WALL_BASE;
const now = (): number => {
  wall += 1;
  return wall;
};
const ids = createIdGenerator({ now, randomBytes: (n: number) => new Uint8Array(n).fill(ID_FILL) });

const cleanScan = (): JournalIntegrityReport => ({
  status: 'ok',
  coverage: 'tail',
  suspects: [],
  devices: [],
});

const makeJournal = (over: Partial<JournalPort> = {}): JournalPort =>
  ({
    scanTail: () => Promise.resolve(ok(cleanScan())),
    scanFull: () => Promise.resolve(ok({ ...cleanScan(), coverage: 'full' as const })),
    ...over,
  }) as unknown as JournalPort;

const makeProjections = (over: Partial<ProjectionEnginePort> = {}): ProjectionEnginePort =>
  ({
    status: () => Promise.resolve(ok({ views: [] })),
    ...over,
  }) as unknown as ProjectionEnginePort;

const makeLedger = (pending: readonly IntentRecord[] = []): IntentLedgerPort =>
  ({
    pending: () => Promise.resolve(ok(pending)),
  }) as unknown as IntentLedgerPort;

const makeSearch = (): SearchRankPort => ({
  freshness: () => Promise.resolve(ok({ lag: 0, dirty: false, tokenizerV: 1 })),
  query: () => Promise.resolve(err(ledgeError('E_CAPABILITY', { op: 'rank' }))),
  dupesFor: () => Promise.resolve(ok([])),
  ensureIndexFresh: () => Promise.resolve(),
});

const probeDeps = (
  engine: StorageEnginePort,
  over: {
    journal?: JournalPort;
    projections?: ProjectionEnginePort;
    ledger?: IntentLedgerPort;
  } = {},
) => ({
  engine,
  journal: over.journal ?? makeJournal(),
  projections: over.projections ?? makeProjections(),
  ledger: over.ledger ?? makeLedger(),
  search: makeSearch(),
  now,
});

const mustOk = async <T>(r: Promise<Result<T, LedgeError>>): Promise<T> => {
  const v = await r;
  if (!v.ok) throw new Error(`expected ok, got ${v.error.code}`);
  return v.value;
};

describe('E6-T03 redactor — hash posture + fail-drop proof', () => {
  it('URLs hash to stable fnv tokens; raw address never survives; non-addresses pass', () => {
    const url = 'https://deep.example.com/roadmap?secret=yes';
    const out = redactString(`opened ${url} calmly`, null);
    expect(out).toBe(`opened adr#${fnv1a64(url)} calmly`);
    expect(out).not.toContain('deep.example.com');
    // Stable (pseudonym-joinable across entries) and idempotent on re-pass.
    expect(redactString(out, null)).toBe(out);
    expect(redactString('plain words only', null)).toBe('plain words only');
    // Bare domains in declared-address carriers hash whole-value.
    expect(redactString('example.com', 'domain')).toBe(`adr#${fnv1a64('example.com')}`);
    expect(redactString('127.0.0.1:8080/p', 'url')).toBe(`adr#${fnv1a64('127.0.0.1:8080/p')}`);
  });

  it('includeAddresses=true passes raw verbatim (the opt-in flip posture)', () => {
    const fields = { url: 'https://x.example/a', note: 'https://x.example/a inside' };
    expect(redactFields(fields, true)).toEqual(fields);
    const redacted = redactFields(fields, false);
    expect(redacted === fields).toBe(false);
    expect(JSON.stringify(redacted)).not.toContain('x.example');
  });

  it('FAIL-DROP PROOF: redactor failure drops the entry — never passes raw through', async () => {
    const engine = await openEngine();
    let sabotaged = true;
    const adapter = createDiagnosticsAdapter({
      engine,
      ids,
      now,
      probes: probeDeps(engine),
      redact: (fields, include) => {
        if (sabotaged) throw new Error('redactor-melted');
        return redactFields(fields, include);
      },
    });
    // log() must not throw and must NOT persist the entry.
    adapter.log({
      level: 'error',
      kind: 'command',
      msg: 'should-never-land',
      fields: { url: 'https://leak.invalid/x' },
    });
    await mustOk(adapter.flush());
    expect((await mustOk(adapter.ringDump(10))).length).toBe(0);
    // report() refuses honestly (no silent success under a dropped row).
    const rid = await adapter.report('diag', { level: 'error', msg: 'also-dropped' });
    expect(rid.ok).toBe(false);
    if (!rid.ok) expect(rid.error.details?.['reason']).toBe('redactor-drop');
    // Heal the seam: the NEXT write lands (drop is per-entry, not a wedge).
    sabotaged = false;
    adapter.log({ level: 'info', kind: 'command', msg: 'lands-after-heal' });
    await mustOk(adapter.flush());
    const dump = await mustOk(adapter.ringDump(10));
    expect(dump.map((r) => r.msg)).toContain('lands-after-heal');
  });

  it('self-test: healthy redactor ⇒ ok; raw-passing or non-refusing redactors ⇒ degraded', () => {
    expect(selfTestRedactor(redactFields)).toBe('ok');
    expect(selfTestRedactor((f) => f)).toBe('degraded'); // raw survives
    expect(
      selfTestRedactor((fields) => {
        const out = { ...(fields ?? {}) };
        for (const k of Object.keys(out)) out[k] = 'adr#x';
        return out; // hashes, but never refuses non-primitives
      }),
    ).toBe('degraded');
  });
});

describe('E6-T03 unified ring — batching, retention, redaction at write time', () => {
  it('queue batching: nothing durable below FLUSH_BATCH until flushed; batch lands en bloc', async () => {
    const engine = await openEngine();
    const adapter = createDiagnosticsAdapter({ engine, ids, now, probes: probeDeps(engine) });
    for (let i = 0; i < FLUSH_BATCH - 1; i += 1)
      adapter.log({ level: 'info', kind: 'command', msg: `cmd-${i}` });
    expect((await mustOk(adapter.ringDump(500))).length).toBe(0); // still queued
    await mustOk(adapter.flush());
    const dump = await mustOk(adapter.ringDump(500));
    expect(dump.length).toBe(FLUSH_BATCH - 1);
    // Newest first.
    expect(dump[0]?.msg).toBe(`cmd-${FLUSH_BATCH - 2}`);
  });

  it('write-time redaction: addresses hash unless the flip is ACTIVE at flush time', async () => {
    const engine = await openEngine();
    const adapter = createDiagnosticsAdapter({ engine, ids, now, probes: probeDeps(engine) });
    adapter.log({
      level: 'info',
      kind: 'command',
      msg: 'cmd',
      fields: { url: 'https://ring.example/t' },
    });
    await mustOk(adapter.flush());
    const row = (await mustOk(adapter.ringDump(5)))[0];
    expect(row?.fields?.['url']).toBe(`adr#${fnv1a64('https://ring.example/t')}`);
    expect(typeof row?.ctxHash).toBe('string');
    // Grant the flip: subsequent entries land raw (24h window, read-side decay).
    await mustOk(adapter.grantIncludeAddresses(true));
    expect(await mustOk(adapter.includeAddressesActive())).toBe(true);
    adapter.log({
      level: 'info',
      kind: 'command',
      msg: 'cmd-raw',
      fields: { url: 'https://raw.example/u' },
    });
    await mustOk(adapter.flush());
    const raw = (await mustOk(adapter.ringDump(5)))[0];
    expect(raw?.fields?.['url']).toBe('https://raw.example/u');
    await mustOk(adapter.grantIncludeAddresses(false));
    expect(await mustOk(adapter.includeAddressesActive())).toBe(false);
  });

  it('ring retention: exactly 500 rolling, drop-oldest on overflow', async () => {
    const engine = await openEngine();
    const adapter = createDiagnosticsAdapter({ engine, ids, now, probes: probeDeps(engine) });
    const overflow = 7;
    for (let i = 0; i < LOG_RING_SLOTS + overflow; i += 1) {
      const rid = await adapter.report('diag', { level: 'info', msg: `row-${i}` });
      if (!rid.ok) throw new Error('report failed');
    }
    const rows = await engine.txn(['logs'], 'readonly', async (tx) => tx.table('logs').toArray());
    if (!rows.ok) throw new Error('read failed');
    expect(rows.value.length).toBe(LOG_RING_SLOTS);
    // Slot wrap: the LAST 500 writes hold slots (oldest 7 evicted).
    const msgs = new Set(rows.value.map((r) => r['msg']));
    expect(msgs.has('row-0')).toBe(false);
    expect(msgs.has(`row-${LOG_RING_SLOTS + overflow - 1}`)).toBe(true);
  });
});

describe('E6-T05 include-flip auto-decay fixture (ADR-027 ≤24h law)', () => {
  it('active inside the window, expired by observation past it — no timers', async () => {
    const engine = await openEngine();
    const adapter = createDiagnosticsAdapter({ engine, ids, now, probes: probeDeps(engine) });
    await mustOk(adapter.grantIncludeAddresses(true));
    expect(await mustOk(adapter.includeAddressesActive())).toBe(true);
    // Frozen-time travel: jump past the 24h grain; the flip has decayed.
    wall += INCLUDE_ADDRESSES_TTL_MS + 1_000;
    expect(await mustOk(adapter.includeAddressesActive())).toBe(false);
    adapter.log({
      level: 'info',
      kind: 'command',
      msg: 'post-decay',
      fields: { url: 'https://decay.example/d' },
    });
    await mustOk(adapter.flush());
    const row = (await mustOk(adapter.ringDump(5)))[0];
    expect(row?.fields?.['url']).toBe(`adr#${fnv1a64('https://decay.example/d')}`);
  });
});

describe('E6-T04 §12 probe registry — catalog-complete, honest lifecycle', () => {
  it('registry v1 runs all ten §12 probes in catalog order + lifecycle probe, unwired rides honest', async () => {
    const engine = await openEngine();
    const adapter = createDiagnosticsAdapter({ engine, ids, now, probes: probeDeps(engine) });
    await mustOk(adapter.selfTest());
    const rows = await mustOk(adapter.runProbes());
    expect(rows.map((r) => r.name)).toEqual([...PROBE_CATALOG, SELFTEST_PROBE]);
    const byName = new Map(rows.map((r) => [r.name, r]));
    expect(byName.get('ai-lanes')?.status).toBe('unwired');
    expect(byName.get('ai-lanes')?.wired).toBe(false);
    expect(byName.get('offscreen-spawn')?.status).toBe('unwired');
    expect(byName.get('journal-tail-freshness')?.status).toBe('ok');
    expect(byName.get(SELFTEST_PROBE)?.status).toBe('ok');
    // Catalog-complete ≠ fake-green: unwired rows never carry an ok status.
    for (const row of rows) if (!row.wired) expect(row.status).toBe('unwired');
  });

  it('probe readings drive statuses: dangling intents warn, suspect journal fails, throw is a fail row', async () => {
    const engine = await openEngine();
    const dangling = [{ intentId: testId(9_100_008) } as unknown as IntentRecord];
    const adapter = createDiagnosticsAdapter({
      engine,
      ids,
      now,
      probes: probeDeps(engine, {
        journal: makeJournal({
          scanTail: () => Promise.reject(new Error('scanner-explode')),
        }),
        ledger: makeLedger(dangling),
      }),
    });
    const rows = await mustOk(adapter.runProbes());
    const byName = new Map(rows.map((r) => [r.name, r]));
    expect(byName.get('dangling-intents')?.status).toBe('warn');
    expect(byName.get('dangling-intents')?.fields['pending']).toBe(1);
    expect(byName.get('journal-tail-freshness')?.status).toBe('fail'); // thrown ⇒ fail row, registry never wedges
    // A warn/fail registry run rings exactly ONE summary row (signal, not noise).
    const ring = await mustOk(adapter.ringDump(5));
    expect(ring.filter((r) => r.kind === 'probe').length).toBe(1);
  });
});

describe('E6-T05 export bundle — assembly, redaction posture, budget', () => {
  it('assembles the full dossier, redacted by default, downloadable later via lastBundle — under 10s', async () => {
    const engine = await openEngine();
    const adapter = createDiagnosticsAdapter({ engine, ids, now, probes: probeDeps(engine) });
    adapter.log({
      level: 'info',
      kind: 'command',
      msg: 'pre-bundle',
      fields: { url: 'https://bundle.example/b' },
    });
    const started = Date.now();
    const bundle = await mustOk(adapter.exportBundle());
    const elapsedMs = Date.now() - started;
    expect(elapsedMs).toBeLessThan(10_000); // EES §7.10 law
    expect(bundle.includeAddresses).toBe(false);
    const doc = JSON.parse(bundle.json) as Record<string, unknown>;
    expect(doc['schemaV']).toBe(1);
    expect(doc['bundleId']).toBe(bundle.bundleId);
    expect(bundle.json).not.toContain('bundle.example'); // redaction posture held
    expect(Array.isArray(doc['probes'])).toBe(true);
    expect(Array.isArray(doc['ring'])).toBe(true);
    // Receipt rides the ring; lastBundle re-serves the SAME document (gesture lane).
    const again = await mustOk(adapter.lastBundle());
    expect(again?.bundleId).toBe(bundle.bundleId);
    expect(JSON.parse(again?.json ?? '{}')['bundleId']).toBe(bundle.bundleId);
    // Timeline rows strip the bundle payload (hygiene).
    const dump = await mustOk(adapter.ringDump(10));
    const receipt = dump.find((r) => r.kind === 'bundle');
    expect(receipt?.msg).toBe('bundle-exported');
    expect(dump.every((r) => !('bundleJson' in r))).toBe(true);
    expect(BUNDLE_RING_ENTRIES).toBe(100);
  });
});
