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
import { ok } from '@/shared-kernel/result/index.js';
import {
  createEngineModelSource,
  createExportersAdapter,
  type ExportersAdapter,
} from '@/infrastructure/exporters/index.js';

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
    const out = await mustOk(h.services.system.rescueScanNow({ mode: 'tail' }, h.ctxOf(10).ctx));
    expect(out.reportId.startsWith('diag.')).toBe(true);
    const logs = await h.rows('logs');
    expect(logs.length).toBe(1);
    expect(logs[0]?.['kind']).toBe('scan');
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
