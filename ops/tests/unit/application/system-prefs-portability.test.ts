// E3-APP · System/prefs/portability contract (W1 first-run, ADR-035 settings law,
// W16 chip-edit teaching, C19–C22 capability honesty, C25 derived-only purge).
import { describe, expect, it } from 'vitest';
import type { ImporterPort } from '@/application/ports/import-export.port.js';
import { platformIds } from '@/shared-kernel/identity/index.js';
import {
  browserTabIdOf,
  ledgeTabIdOf,
  liveTabPlan,
  makeServices,
  mustOk,
  testId,
} from './services.testkit.js';
import type { ServiceDeps } from '@/application/usecases/index.js';
import { err, ledgeError, ok } from '@/shared-kernel/result/index.js';
import {
  createEngineModelSource,
  createExportersAdapter,
  type ExportersAdapter,
} from '@/infrastructure/exporters/index.js';
import { createImportersAdapter } from '@/infrastructure/importers/index.js';
import { canonicalize } from '@/shared-kernel/canon/index.js';

const FAKE_IMPORTER: ImporterPort = {
  preview: () =>
    Promise.resolve(
      ok({
        previewId: testId(55_001),
        parserId: 'fake-json',
        missions: 1,
        tabs: 2,
        dupesHint: 0,
        rejects: 0,
        modelSummary: 'missions=1/tabs=2',
      }),
    ),
  commit: () =>
    Promise.resolve(
      ok({
        batchId: testId(55_002),
        source: 'fake-json',
        canonRulesV: 1,
        missions: [
          {
            name: 'Imported mission',
            tabs: [
              {
                url: 'https://imp-one.test/x',
                title: 'Imp One',
                domain: 'imp-one.test',
                urlCanon: 'imp-one.test/x',
              },
              {
                url: 'https://imp-two.test/y',
                title: 'Imp Two',
                domain: 'imp-two.test',
                urlCanon: 'imp-two.test/y',
              },
            ],
          },
        ],
        dupes: 0,
        rejects: 0,
      }),
    ),
};

describe('E3-APP system — W1 first-run + ADR-035 settings law', () => {
  it('first run forms ONE mission per window (system-named), resend-safe by ingest flag', async () => {
    const h = await makeServices({ withIngest: true });
    // Crawl input is browser truth; tab rows arrive via the ingest stub's projection.
    h.fakeTabs.seedLive(browserTabIdOf(1), { active: true });
    h.fakeTabs.seedLive(browserTabIdOf(2));
    h.fakeTabs.seedLive(browserTabIdOf(150));
    await h.seed([liveTabPlan(1), liveTabPlan(2), liveTabPlan(150)]);

    const first = await mustOk(h.services.system.firstRunIngest(h.ctxOf(1).ctx));
    expect(first.missionsCreated).toBe(2);
    expect(first.tabsCaptured).toBe(3);
    const formed = (await h.events()).filter((e) => e.type === 'MissionFormed');
    expect(formed.length).toBe(2);
    for (const e of formed) {
      expect((e.payload as { namedBy: string }).namedBy).toBe('system');
      expect((e.payload as { provenance?: string }).provenance).toBe('first-run');
    }
    // W1 naming law: the window with the ACTIVE tab takes its tab's domain.
    const names = formed.map((e) => (e.payload as { name: string }).name).sort();
    expect(names).toContain('site-1.test');
    expect(names).toContain('First window');

    // Resend: ingest flag flips to skip; zero additional formations.
    const second = await mustOk(h.services.system.firstRunIngest(h.ctxOf(2).ctx));
    expect(second.missionsCreated).toBe(0);
    expect((await h.events()).filter((e) => e.type === 'MissionFormed').length).toBe(2);

    // Unwired ingest seam is the honest capability error, never a fake success.
    const bare = await makeServices();
    const unwired = await bare.services.system.firstRunIngest(bare.ctxOf(3).ctx);
    expect(unwired.ok).toBe(false);
    if (unwired.ok) return;
    expect(unwired.error.code).toBe('E_CAPABILITY');
  });

  it('setSetting enforces the closed whitelist and rides SettingsChanged fan-out hint', async () => {
    const h = await makeServices();
    const out = await mustOk(
      h.services.system.setSetting({ key: 'trash.retentionDays', value: 14 }, h.ctxOf(4).ctx),
    );
    expect(Object.keys(out).length).toBe(0);
    const row = await h.row('settings', 'trash.retentionDays');
    expect(row?.['value']).toBe(14);
    const changed = (await h.events()).find((e) => e.type === 'SettingsChanged');
    expect((changed?.payload as { key: string }).key).toBe('trash.retentionDays');

    const refused = await h.services.system.setSetting(
      { key: 'telemetry.endpoint', value: 'https://evil.example' },
      h.ctxOf(5).ctx,
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe('E_DOMAIN_LEGALITY');

    const nonPrimitive = await h.services.system.setSetting(
      { key: 'trash.retentionDays', value: { nested: true } },
      h.ctxOf(6).ctx,
    );
    expect(nonPrimitive.ok).toBe(false);
  });

  it('forgetEverything purges DERIVED stores only — journal truth and settings survive', async () => {
    const h = await makeServices();
    await mustOk(
      h.services.system.setSetting({ key: 'favorite.mission."x"', value: true }, h.ctxOf(7).ctx),
    );
    const eventCountBefore = (await h.events()).length;

    const refused = await h.services.system.forgetEverything({ confirm: false }, h.ctxOf(8).ctx);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe('E_DOMAIN_LEGALITY');

    const out = await mustOk(h.services.system.forgetEverything({ confirm: true }, h.ctxOf(9).ctx));
    expect(typeof out.artifactsPurged).toBe('number');
    expect((await h.events()).length).toBe(eventCountBefore + 1); // MemoryWiped is truthful
    expect((await h.events()).some((e) => e.type === 'MemoryWiped')).toBe(true);
    expect(await h.row('settings', 'favorite.mission."x"')).toBeDefined(); // settings untouched
  });

  it('rescueScanNow writes the diagnostics ring row and returns its reportId', async () => {
    const h = await makeServices();
    const out = await mustOk(
      h.services.system.rescueScanNow({ mode: 'tail', consoleAuthorized: false }, h.ctxOf(10).ctx),
    );
    expect(out.reportId.startsWith('diag.')).toBe(true);
    const logs = await h.rows('logs');
    expect(logs.length).toBe(1);
    expect(logs[0]?.['kind']).toBe('scan');
    expect(logs[0]?.['msg']).toBe('scan-tail');
  });
});

describe('E6-T06 · C24 cadence law — full-scan pacing + capability-authorized force', () => {
  const FULL = 'full' as const;
  const TAIL = 'tail' as const;

  it('first full scan stamps the clock; an immediate second refuses with cadence + nextEligibleAt', async () => {
    const h = await makeServices();
    const first = await mustOk(
      h.services.system.rescueScanNow({ mode: FULL, consoleAuthorized: false }, h.ctxOf(30).ctx),
    );
    expect(first.reportId.startsWith('diag.scan:')).toBe(true);
    expect((await h.row('meta', 'diag.lastFullScanAt'))?.['value']).not.toBeUndefined();
    // Tail rides free — no cadence on the ≤50ms-law scan.
    await mustOk(
      h.services.system.rescueScanNow({ mode: TAIL, consoleAuthorized: false }, h.ctxOf(31).ctx),
    );
    const second = await h.services.system.rescueScanNow(
      { mode: FULL, consoleAuthorized: false },
      h.ctxOf(32).ctx,
    );
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('E_DOMAIN_LEGALITY');
      expect(second.error.details?.['reason']).toBe('full-scan-cadence');
      expect(typeof second.error.details?.['nextEligibleAt']).toBe('number');
    }
  });

  it('force honors ONLY the console capability: stranger ⇒ force-unauthorized; console ⇒ runs + audit row', async () => {
    const h = await makeServices();
    await mustOk(
      h.services.system.rescueScanNow({ mode: FULL, consoleAuthorized: false }, h.ctxOf(33).ctx),
    );
    const stranger = await h.services.system.rescueScanNow(
      { mode: FULL, force: true, consoleAuthorized: false },
      h.ctxOf(34).ctx,
    );
    expect(stranger.ok).toBe(false);
    if (!stranger.ok) expect(stranger.error.details?.['reason']).toBe('force-unauthorized');
    const forced = await mustOk(
      h.services.system.rescueScanNow(
        { mode: FULL, force: true, consoleAuthorized: true },
        h.ctxOf(35).ctx,
      ),
    );
    expect(forced.reportId.startsWith('diag.scan:')).toBe(true);
    // The audit row finds the override (user-ruled F1 "makes overrides auditable").
    const audit = (await h.rows('logs')).filter((r) => r['kind'] === 'scan');
    expect(audit.length).toBe(2);
    expect(audit[1]?.['fields']).toMatchObject({ mode: 'full', forced: true });
  });

  it('the clock re-opens after the 7d grain', async () => {
    const h = await makeServices();
    await mustOk(
      h.services.system.rescueScanNow({ mode: FULL, consoleAuthorized: false }, h.ctxOf(36).ctx),
    );
    const stamped = (await h.row('meta', 'diag.lastFullScanAt'))?.['value'];
    if (typeof stamped !== 'number') throw new Error('stamp missing');
    const pastGrain = 8 * 24 * 60 * 60 * 1000;
    const r = await h.engine.txn(['meta'], 'readwrite', async (tx) => {
      await tx.table('meta').put({ key: 'diag.lastFullScanAt', value: stamped - pastGrain });
    });
    if (!r.ok) throw new Error('restamp failed');
    await mustOk(
      h.services.system.rescueScanNow({ mode: FULL, consoleAuthorized: false }, h.ctxOf(37).ctx),
    );
  });
});

describe('E3-APP prefs — W16 teaching + settings carriers', () => {
  it('correctTopic writes the certainty artifact (confidence 1, provider user) and invalidates the prior', async () => {
    const h = await makeServices();
    const out = await mustOk(
      h.services.prefs.correctTopic(
        { subjectId: testId(60_001), value: '  deep   work  ', priorArtifactId: testId(60_002) },
        h.ctxOf(11).ctx,
      ),
    );
    expect(out.artifactId.length).toBe(26);
    const events = await h.events();
    const written = events.find((e) => e.type === 'MemoryArtifactWritten');
    expect((written?.payload as { value: string }).value).toBe('deep work');
    expect((written?.payload as { confidence: number }).confidence).toBe(1);
    expect((written?.payload as { provider: string }).provider).toBe('user');
    const invalidated = events.find((e) => e.type === 'MemoryArtifactInvalidated');
    expect((invalidated?.payload as { artifactId: string }).artifactId).toBe(testId(60_002));

    const blank = await h.services.prefs.correctTopic(
      { subjectId: testId(60_003), value: '   ' },
      h.ctxOf(12).ctx,
    );
    expect(blank.ok).toBe(false);
    if (blank.ok) return;
    expect(blank.error.code).toBe('E_DOMAIN_LEGALITY');
  });

  it('favorite/pin ride the per-entity settings carriers (primitive values, whitelist prefixes)', async () => {
    const h = await makeServices();
    await mustOk(
      h.services.prefs.setFavorite(
        { entityKind: 'mission', id: 'm-1', favor: true },
        h.ctxOf(13).ctx,
      ),
    );
    await mustOk(h.services.prefs.setPinned({ id: 'm-1', pinned: true }, h.ctxOf(14).ctx));
    expect((await h.row('settings', 'favorite.mission.m-1'))?.['value']).toBe(true);
    expect((await h.row('settings', 'pinnedMission.m-1'))?.['value']).toBe(true);
    await mustOk(h.services.prefs.setPinned({ id: 'm-1', pinned: false }, h.ctxOf(15).ctx));
    expect((await h.row('settings', 'pinnedMission.m-1'))?.['value']).toBe(false);
  });
});

describe('E3-APP portability — capability honesty + the R11 import-undo law', () => {
  it('unwired seams refuse with the typed capability fault (never fake previews)', async () => {
    const h = await makeServices();
    for (const r of [
      await h.services.portability.importPreview(
        { fileMeta: { name: 'f.json', size: 10 } },
        h.ctxOf(16).ctx,
      ),
      await h.services.portability.importCommit(
        { previewId: 'p-1', dedupeMode: 'skip' },
        h.ctxOf(17).ctx,
      ),
      await h.services.portability.exportRequest(
        { scope: { kind: 'all' }, formats: ['json'] },
        h.ctxOf(18).ctx,
      ),
    ]) {
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error.code).toBe('E_CAPABILITY');
    }
  });

  it('importCommit materializes parked missions + kept tabs and pushes the import-undo atom', async () => {
    const h = await makeServices({ importer: FAKE_IMPORTER });
    const out = await mustOk(
      h.services.portability.importCommit(
        { previewId: testId(55_001), dedupeMode: 'skip' },
        h.ctxOf(19).ctx,
      ),
    );
    expect(out.batchId).toBe(testId(55_002));
    expect(out.imported).toBe(2);
    const committed = (await h.events()).find((e) => e.type === 'ImportCommitted');
    const batchId = (committed?.payload as { batchId: string }).batchId;
    const missions = await h.rows('missions');
    const imported = missions.filter((m) => m['namedBy'] === 'import');
    expect(imported.length).toBe(1);
    expect(imported[0]?.['state']).toBe('parked');
    const tabs = (await h.rows('tabs')).filter((t) => t['state'] === 'kept');
    expect(tabs.length).toBe(2);

    // R11: the import-undo atom rides the stack; replaying it bulk-trashes the batch.
    const undoRow = await h.row('meta', 'undoStack');
    const stack = Array.isArray(undoRow?.['value']) ? undoRow['value'] : [];
    expect(stack.at(-1)?.['kind']).toBe('import-undo');
    const undone = await mustOk(h.services.undo.undo(h.ctxOf(20).ctx));
    expect(undone.undid).toContain('msg.undo');
    expect((await h.row('missions', imported[0]?.['missionId'] as string))?.['state']).toBe(
      'trash',
    );
    const trashedBatch = (await h.events()).filter((e) => e.type === 'EntityTrashed');
    expect(trashedBatch.some((e) => (e.payload as { bulkId?: string }).bulkId === batchId)).toBe(
      true,
    );
  });

  it('importPreview materializes NOTHING but its audit event (plans-not-truth law)', async () => {
    const h = await makeServices({ importer: FAKE_IMPORTER });
    const out = await mustOk(
      h.services.portability.importPreview(
        { fileMeta: { name: 'f.json', size: 10 } },
        h.ctxOf(21).ctx,
      ),
    );
    expect(out.previewId).toBe(testId(55_001));
    // C20/§4: the preview model rides ImportPreviewed (audit + workroom material);
    // entity rows are strictly commit-side law.
    const evs = await h.events();
    expect(evs.length).toBe(1);
    expect(evs[0]?.type).toBe('ImportPreviewed');
    expect((await h.rows('missions')).length).toBe(0);
    expect((await h.rows('tabs')).length).toBe(0);
  });
});

describe('E5-T03 export — the wired render pipeline rides the service', () => {
  const NOW_X = 1_800_000_000_000;
  const MISSION = testId(77_001);

  /** Service harness with the REAL exporters adapter bound to the harness engine. */
  const wiredWorld = async () => {
    let adapter: ExportersAdapter | undefined;
    const h = await makeServices({
      exporterFactory: (engine) => {
        adapter = createExportersAdapter({
          source: createEngineModelSource(engine),
          ids: platformIds,
          now: () => NOW_X,
          build: 'build-it-1',
        });
        return adapter;
      },
    });
    await h.seed([
      liveTabPlan(1),
      liveTabPlan(2),
      {
        type: 'MissionFormed',
        payload: {
          missionId: MISSION,
          name: 'Exportable',
          namedBy: 'user',
          tabIds: [ledgeTabIdOf(1), ledgeTabIdOf(2)],
        },
      },
    ]);
    const adapterOf = (): ExportersAdapter => {
      if (adapter === undefined) throw new Error('adapter not composed');
      return adapter;
    };
    return { h, adapterOf };
  };

  it('exportRequest renders + journals ExportCompleted with the plan seal', async () => {
    const { h, adapterOf } = await wiredWorld();
    const out = await mustOk(
      h.services.portability.exportRequest(
        { scope: { kind: 'all' }, formats: ['md', 'json'] },
        h.ctxOf(31).ctx,
      ),
    );
    const completed = (await h.events()).find((e) => e.type === 'ExportCompleted');
    const payload = completed?.payload as {
      exportId: string;
      scope: string;
      formats: string[];
      manifestChecksum: string;
    };
    expect(payload.exportId).toBe(out.exportId);
    expect(payload.scope).toBe('all');
    expect(payload.formats).toEqual(['json', 'md']);
    expect(payload.manifestChecksum).toMatch(/^[0-9a-f]{8}$/);
    // The sealed artifact is fetchable and its manifest carries the same checksum.
    const artifact = adapterOf().fetchArtifact(out.exportId)?.artifacts['json'];
    expect(artifact?.manifest.manifestChecksum).toBe(payload.manifestChecksum);
    const parsed = JSON.parse(artifact?.text ?? '') as { missions: { name: string }[] };
    expect(parsed.missions.map((m) => m.name)).toEqual(['Exportable']);
  });

  it('mission-missing is a domain legality fault BEFORE any render happens', async () => {
    const { h } = await wiredWorld();
    const r = await h.services.portability.exportRequest(
      { scope: { kind: 'mission', missionId: testId(77_099) }, formats: ['json'] },
      h.ctxOf(32).ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('E_DOMAIN_LEGALITY');
    expect(r.error.details?.['reason']).toBe('mission-missing');
    // Fail-closed: nothing journaled — the audit feed never fabricates outcomes.
    expect((await h.events()).some((e) => e.type === 'ExportCompleted')).toBe(false);
  });

  it('formats-empty rides the adapter legality fault through the service', async () => {
    const { h } = await wiredWorld();
    const r = await h.services.portability.exportRequest(
      { scope: { kind: 'all' }, formats: [] },
      h.ctxOf(33).ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('E_DOMAIN_LEGALITY');
    expect((await h.events()).some((e) => e.type === 'ExportCompleted')).toBe(false);
  });
});

describe('E5-T05 import — the wired two-phase pipeline rides the service', () => {
  const NOW_I = 1_800_000_000_000;
  /** One group: tracker-param dupe pair + one distinct tab + one quarantined scheme. */
  const ONETAB_TEXT = [
    'https://import-one.test/report/dup-9?utm_source=newsletter | First copy',
    'https://import-one.test/report/dup-9 | Second copy',
    'https://import-two.test/notes/solo-3 | Solo distinct',
    'javascript:alert(1) | Injected script scheme',
  ].join('\n');

  const wiredImport = async () => {
    const importer = createImportersAdapter({ ids: platformIds, now: () => NOW_I });
    const h = await makeServices({ importer });
    return { h, importer };
  };
  const previewInput = {
    fileMeta: { name: 'onetab.txt', size: ONETAB_TEXT.length },
    bytesRef: { kind: 'text' as const, text: ONETAB_TEXT },
  };

  it('importPreview journals ImportPreviewed with the real parser census', async () => {
    const { h } = await wiredImport();
    const out = await mustOk(h.services.portability.importPreview(previewInput, h.ctxOf(41).ctx));
    const evs = await h.events();
    expect(evs.length).toBe(1);
    const previewed = evs[0];
    expect(previewed?.type).toBe('ImportPreviewed');
    const payload = previewed?.payload as { previewId: string; modelSummary: string };
    expect(payload.previewId).toBe(out.previewId);
    expect(payload.modelSummary).toBe('onetab:m1:t3:r1:d1');
    // Plans-not-truth holds through the real parser too: nothing materialized.
    expect((await h.rows('missions')).length).toBe(0);
  });

  it('importCommit journals ImportCommitted — batchId := previewId, sealed manifest, undo atom', async () => {
    const { h } = await wiredImport();
    const preview = await mustOk(
      h.services.portability.importPreview(previewInput, h.ctxOf(42).ctx),
    );
    const out = await mustOk(
      h.services.portability.importCommit(
        { previewId: preview.previewId, dedupeMode: 'skip' },
        h.ctxOf(43).ctx,
      ),
    );
    expect(out.batchId).toBe(preview.previewId); // the idempotency derive (C21)
    expect(out.imported).toBe(2); // dupe skipped; reject never reached the plan
    expect(out.dupes).toBe(1);
    expect(out.rejects).toBe(1);

    const committed = (await h.events()).find((e) => e.type === 'ImportCommitted');
    const payload = committed?.payload as {
      batchId: string;
      source: string;
      dupesMode: string;
      canonRulesV: number;
      batchManifestRef: {
        missions: {
          missionId: string;
          name: string;
          tabIds: string[];
          tabs: { ledgeTabId: string; url: string; urlCanonHash: string }[];
        }[];
      };
    };
    expect(payload.batchId).toBe(preview.previewId);
    expect(payload.source).toBe('onetab');
    expect(payload.dupesMode).toBe('skip');
    expect(payload.canonRulesV).toBe(1);
    // Referential probe: every manifest tabId exists in the parked materialization,
    // and the canon stamps survive the trip (urlCanon rides as urlCanonHash).
    const manifest = payload.batchManifestRef.missions[0];
    expect(manifest?.name).toBe(''); // onetab groups arrive unnamed
    expect(manifest?.tabIds.length).toBe(2);
    expect(manifest?.tabs.map((t) => t.url)).toEqual([
      'https://import-one.test/report/dup-9?utm_source=newsletter',
      'https://import-two.test/notes/solo-3',
    ]);
    for (const t of manifest?.tabs ?? []) {
      expect(t.urlCanonHash).toBe(canonicalize(t.url).canonForm);
      expect(t.ledgeTabId.length).toBeGreaterThan(0);
    }
    const missions = (await h.rows('missions')).filter((m) => m['namedBy'] === 'import');
    expect(missions.length).toBe(1);
    expect(missions[0]?.['missionId']).toBe(payload.batchManifestRef.missions[0]?.missionId);

    // R11: ONE undo atom covers the batch; the hinge wrote it next to the event.
    const undoRow = await h.row('meta', 'undoStack');
    const stack = Array.isArray(undoRow?.['value']) ? undoRow['value'] : [];
    const atom = stack.at(-1) as { kind: string; label: string; payload: { batchId: string } };
    expect(atom.kind).toBe('import-undo');
    expect(atom.label).toBe('msg.undo.imported');
    expect(atom.payload.batchId).toBe(preview.previewId);
  });

  it('a double commit keeps the batchId stable (the C21 idempotency key) per invocation', async () => {
    const { h } = await wiredImport();
    const preview = await mustOk(
      h.services.portability.importPreview(previewInput, h.ctxOf(44).ctx),
    );
    const first = await mustOk(
      h.services.portability.importCommit(
        { previewId: preview.previewId, dedupeMode: 'skip' },
        h.ctxOf(45).ctx,
      ),
    );
    const second = await mustOk(
      h.services.portability.importCommit(
        { previewId: preview.previewId, dedupeMode: 'skip' },
        h.ctxOf(46).ctx,
      ),
    );
    // C21 "idempotent by previewId-derived batchId": the adapter's identity derive
    // makes the idempotency key stable across replays — consumers dedupe by it.
    expect(second.batchId).toBe(first.batchId);
    expect(second.batchId).toBe(preview.previewId);
    const committed = (await h.events()).filter((e) => e.type === 'ImportCommitted');
    expect(committed.length).toBe(2);
    expect(
      committed.every((e) => (e.payload as { batchId: string }).batchId === first.batchId),
    ).toBe(true);
    // Durable ids are application truth: opKey mints a fresh journal key per
    // invocation (no key-reuse-with-alien-content), so each invoke mints its own
    // manifest ids — service-side dedupe-by-batchId is the recorded door
    // (docs/adr-notes/e5-importers.md [follow-up]).
    const ids = committed.map((e) =>
      (
        e.payload as { batchManifestRef: { missions: { missionId: string }[] } }
      ).batchManifestRef.missions.map((m) => m.missionId),
    );
    expect(ids[1]).not.toEqual(ids[0]);
  });
});

describe('E5-T06 import — the bytes shelf hinge (C20 workroom-contract frame)', () => {
  const NOW_S = 1_800_000_000_000;
  const SHELF_TEXT = 'https://shelf-one.test/a | A\nhttps://shelf-two.test/b | B';
  const SHELF_BYTES = new TextEncoder().encode(SHELF_TEXT);

  type ShelfMode = 'match' | 'empty' | 'fault';
  const shelfRig = async (mode: ShelfMode) => {
    const importer = createImportersAdapter({ ids: platformIds, now: () => NOW_S });
    const claims: { name: string; size: number }[] = [];
    const importBytesStage: ServiceDeps['importBytesStage'] & object = {
      put: () => Promise.resolve(ok({ staged: true as const })),
      takeMatching: (meta: { name: string; size: number }) => {
        claims.push(meta);
        if (mode === 'fault')
          return Promise.resolve(err(ledgeError('E_CORRUPT_STORE', { what: 'stage-read' })));
        return Promise.resolve(
          ok(
            mode === 'match'
              ? { name: meta.name, size: meta.size, stagedAt: NOW_S, bytes: SHELF_BYTES }
              : undefined,
          ),
        );
      },
      sweep: () => Promise.resolve(ok({ swept: 0 })),
    };
    const h = await makeServices({ importer, importBytesStage });
    return { h, claims };
  };
  const previewMeta = { name: 'tabs.txt', size: SHELF_BYTES.length };

  it('a bytesRef-less preview resolves the shelf and parses for real (end-to-end)', async () => {
    const { h, claims } = await shelfRig('match');
    const out = await mustOk(
      h.services.portability.importPreview({ fileMeta: previewMeta }, h.ctxOf(51).ctx),
    );
    expect(claims).toEqual([previewMeta]); // the hinge claimed exactly the wire meta
    expect(out.modelSummary).toBe('onetab:m1:t2:r0:d0');
    const evs = await h.events();
    const previewed = evs.find((e) => e.type === 'ImportPreviewed');
    expect((previewed?.payload as { modelSummary: string }).modelSummary).toBe(
      'onetab:m1:t2:r0:d0',
    );
  });

  it('an empty shelf keeps the honest import-bytes refusal (nothing fabricated, nothing journalled)', async () => {
    const { h } = await shelfRig('empty');
    const r = await h.services.portability.importPreview(
      { fileMeta: previewMeta },
      h.ctxOf(52).ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('E_FORMAT_UNKNOWN');
      expect(r.error.details?.['what']).toBe('import-bytes');
    }
    expect((await h.events()).length).toBe(0);
  });

  it('a shelf fault propagates typed (the hinge never invents bytes)', async () => {
    const { h } = await shelfRig('fault');
    const r = await h.services.portability.importPreview(
      { fileMeta: previewMeta },
      h.ctxOf(53).ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('E_CORRUPT_STORE');
    expect((await h.events()).length).toBe(0);
  });
});
