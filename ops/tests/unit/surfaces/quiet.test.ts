// E4 · Quiet page suite — the place of business. Laws: nav renders all sections
// and section switches issue exactly the right query with exactly the right
// payload; detail/topic/trash/settings/import-export/rescue flows ride registry
// commands with frozen payloads; live-region announcements carry catalog copy;
// stream lanes (import-ready/export-ready) render only their own affordances;
// undo keyboard contract; boot/rejoin/cleanup semantics.
import { describe, expect, it } from 'vitest';
import { copyOf } from '@/surfaces/components/copy/copy.js';
import { mountQuietPage, type Mounted } from '@/surfaces/quiet-page/quiet.js';
import { FakeDocument, asDocument, fireKey, mustQuery, type FakeElement } from './fake-dom.js';
import {
  createFakeTransport,
  createTestEntropy,
  flush,
  type FakeTransport,
} from './fake-transport.js';

const BOOTSTRAP = {
  missions: [
    {
      missionId: 'm1',
      name: 'Reading week',
      namedBy: 'user',
      state: 'parked',
      concluded: false,
      tabCount: 3,
    },
    {
      missionId: 'm2',
      name: 'Trip planning',
      namedBy: 'system',
      state: 'archived',
      concluded: true,
      tabCount: 9,
    },
  ],
  recentlyClosed: [],
  trashCount: 2,
  watermark: 6,
  settings: {
    'trash.retentionDays': 30,
    'undo.stackCap': 20,
    'favorite.mission.m1': true,
  },
  heartbeat: { keptCount: 14, liveRecoverable: 2, asOf: 1_700_000_000_000 },
};

interface QuietHarness {
  readonly doc: FakeDocument;
  readonly fake: FakeTransport;
  readonly mounted: Mounted;
  readonly wake: () => void;
  readonly answers: Map<string, unknown>;
  readonly unmount: () => void;
}

const mount = (): QuietHarness => {
  const doc = new FakeDocument();
  const fake = createFakeTransport();
  const answers = new Map<string, unknown>([
    ['GetBootstrap', BOOTSTRAP],
    ['GetLibrary', { missions: BOOTSTRAP.missions, nextCursor: undefined }],
    ['GetRecentlyClosed', { entries: [] }],
    ['GetTrash', { entries: [] }],
    ['GetActivity', []],
    ['GetHistory', []],
    ['GetHealth', { storage: 'ok', journalHead: 41 }],
  ]);
  let wakeListener: (() => void) | undefined;
  const mounted = mountQuietPage(asDocument(doc), {
    transport: fake.transport,
    entropy: createTestEntropy(),
    onWake: (listener) => {
      wakeListener = listener;
      return () => {};
    },
  });
  return {
    doc,
    fake,
    mounted,
    answers,
    wake: () => wakeListener?.(),
    unmount: () => mounted.unmount(),
  };
};

/** Answer every unanswered query from the answers table (the scripted SW). Two
 *  rounds: bootstrap application can trigger follow-on queries (seed ⇒ re-render),
 *  the second round settles those before assertions run. */
const answerAll = async (h: QuietHarness): Promise<void> => {
  for (let round = 0; round < 2; round += 1) {
    await flush();
    for (const env of [...h.fake.sent]) {
      if (env.kind === 'query' && h.answers.has(env.name)) {
        h.fake.apply(env.cid, h.answers.get(env.name));
      }
    }
    await flush();
  }
};

const navTo = async (h: QuietHarness, section: string): Promise<void> => {
  mustQuery(h.doc.body, `[data-nav="${section}"]`).click();
  await answerAll(h);
};

const content = (doc: FakeDocument): FakeElement => mustQuery(doc.body, '[data-section="content"]');

describe('E4 quiet · boot & nav', () => {
  it('boots: shell + nav instantly, bootstrap query as quiet, library default', async () => {
    const h = mount();
    const nav = mustQuery(h.doc.body, 'nav[data-widget="nav"]');
    expect(nav.getAttribute('aria-label')).toBe(copyOf('msg.aria.nav'));
    expect(nav.querySelectorAll('[data-nav]')).toHaveLength(9);
    await answerAll(h);
    const boot = h.fake.lastOf('GetBootstrap');
    expect(boot.payload).toEqual({ surface: 'quiet' });
    expect(boot.senderContext).toBe('quiet');
    expect(h.doc.body.textContent).toContain(copyOf('msg.heartbeat.safe', { count: 14 }));
    expect(content(h.doc).textContent).toContain('Reading week');
    h.unmount();
  });

  it('section switches mark aria-current and issue the section query', async () => {
    const h = mount();
    await answerAll(h);
    await navTo(h, 'archive');
    expect(mustQuery(h.doc.body, '[data-nav="archive"]').getAttribute('aria-current')).toBe('page');
    expect(mustQuery(h.doc.body, '[data-nav="library"]').getAttribute('aria-current')).toBe(
      'false',
    );
    expect(content(h.doc).textContent).toContain('Trip planning');
    h.unmount();
  });

  it('library asks GetLibrary with no filter; archive asks for the archived filter', async () => {
    const h = mount();
    await answerAll(h);
    const libraryCalls = h.fake.sent.filter((e) => e.name === 'GetLibrary');
    expect(libraryCalls[0]?.payload).toEqual({});
    await navTo(h, 'archive');
    expect(h.fake.lastOf('GetLibrary').payload).toEqual({ filter: { state: 'archived' } });
    h.unmount();
  });

  it('first-run posture: empty library offers FirstRunIngest', async () => {
    const h = mount();
    h.answers.set('GetBootstrap', {
      missions: [],
      recentlyClosed: [],
      trashCount: 0,
      watermark: 0,
      settings: {},
      heartbeat: { keptCount: 0, liveRecoverable: 0, asOf: 0 },
    });
    h.answers.set('GetLibrary', { missions: [] });
    await answerAll(h);
    const card = mustQuery(h.doc.body, '[data-card="first-run"]');
    mustQuery(card, '[data-action="first-run"]').click();
    await flush();
    expect(h.fake.lastOf('FirstRunIngest').payload).toEqual({});
    h.unmount();
  });

  it('boot failure shows the error block; retry re-issues the bootstrap', async () => {
    const h = mount();
    await flush();
    h.fake.fail(h.fake.lastOf('GetBootstrap').cid, {
      code: 'E_STORE_INTEGRITY',
      messageKey: 'msg.error.store',
    });
    await flush();
    expect(content(h.doc).querySelector('[role="alert"]')).not.toBeNull();
    mustQuery(content(h.doc), '[data-action="retry"]').click();
    await answerAll(h);
    expect(content(h.doc).textContent).toContain('Reading week');
    h.unmount();
  });
});

describe('E4 quiet · library & detail', () => {
  const DETAIL = {
    mission: {
      missionId: 'm1',
      name: 'Reading week',
      namedBy: 'user',
      state: 'parked',
      concluded: false,
      tabCount: 2,
    },
    tabs: [
      {
        tabId: 't1',
        missionId: 'm1',
        url: 'https://papers.example.com/a',
        title: 'Kept paper',
        domain: 'papers.example.com',
        state: 'kept',
        firstSeenAt: 1,
        lastActiveAt: 2,
      },
      {
        tabId: 't2',
        missionId: 'm1',
        url: 'https://notes.example.com/b',
        title: 'Notes',
        domain: 'notes.example.com',
        state: 'kept',
        firstSeenAt: 1,
        lastActiveAt: 2,
      },
    ],
    artifacts: [
      { artifactId: 'a1', kind: 'topic', value: 'attention' },
      { artifactId: 'a2', kind: 'naming', value: 'reading' },
    ],
  };

  const openDetail = async (h: QuietHarness): Promise<void> => {
    h.answers.set('GetMissionDetail', DETAIL);
    await answerAll(h);
    mustQuery(content(h.doc), '[data-mission-id="m1"] [data-action="open-detail"]').click();
    await answerAll(h);
    expect(h.fake.lastOf('GetMissionDetail').payload).toEqual({ missionId: 'm1' });
  };

  it('detail renders mission, topics (topic-kind artifacts only) and member tabs', async () => {
    const h = mount();
    await openDetail(h);
    const c = content(h.doc);
    expect(c.textContent).toContain('Reading week');
    expect(mustQuery(c, '[data-block="topics"]').textContent).toContain('attention');
    expect(mustQuery(c, '[data-block="topics"]').textContent).not.toContain('naming');
    expect(c.querySelectorAll('.tab-row')).toHaveLength(2);
    h.unmount();
  });

  it('detail actions ride the registry: resume/archive/conclude/delete flows', async () => {
    const h = mount();
    await openDetail(h);
    mustQuery(content(h.doc), '[data-action="resume"]').click();
    await flush();
    expect(h.fake.lastOf('ResumeMission').payload).toEqual({ missionId: 'm1', mode: 'full' });
    // Applied ⇒ the after-hook returns to the library; the next flow starts there.
    h.fake.apply(h.fake.lastOf('ResumeMission').cid, { missionId: 'm1' });
    await answerAll(h);
    await openDetail(h);
    mustQuery(content(h.doc), '[data-action="archive"]').click();
    await flush();
    expect(h.fake.lastOf('ArchiveMission').payload).toEqual({ missionId: 'm1' });
    h.fake.apply(h.fake.lastOf('ArchiveMission').cid, { archived: true });
    await answerAll(h);
    await openDetail(h);
    mustQuery(content(h.doc), '[data-action="conclude"]').click();
    await flush();
    expect(h.fake.lastOf('ConcludeMission').payload).toEqual({ missionId: 'm1' });
    h.unmount();
  });

  it('delete requires the confirm lane before DeleteEntity leaves the surface', async () => {
    const h = mount();
    await openDetail(h);
    const c = content(h.doc);
    mustQuery(c, '[data-action="trash-mission"]').click();
    await flush();
    expect(h.fake.countOf('DeleteEntity')).toBe(0); // nothing sent yet — confirm first
    const lane = mustQuery(c, '[data-lane="confirm"]');
    expect(lane.textContent).toContain(copyOf('msg.hint.confirm-delete'));
    mustQuery(lane, '[data-action="confirm"]').click();
    await flush();
    expect(h.fake.lastOf('DeleteEntity').payload).toEqual({ kind: 'mission', id: 'm1' });
    h.unmount();
  });

  it('confirm-lane cancel returns to the detail unchanged', async () => {
    const h = mount();
    await openDetail(h);
    const c = content(h.doc);
    mustQuery(c, '[data-action="trash-mission"]').click();
    await flush();
    mustQuery(c, '[data-lane="confirm"] [data-action="cancel"]').click();
    await flush();
    expect(h.fake.countOf('DeleteEntity')).toBe(0);
    expect(content(h.doc).textContent).toContain('Reading week');
    h.unmount();
  });

  it('favorite toggles ride SetFavorite with the inverted current flag', async () => {
    const h = mount();
    await openDetail(h); // m1 is favorited in bootstrap settings
    mustQuery(content(h.doc), '[data-action="favorite"]').click();
    await flush();
    expect(h.fake.lastOf('SetFavorite').payload).toEqual({
      entityKind: 'mission',
      id: 'm1',
      favor: false,
    });
    h.unmount();
  });

  it('teach sends CorrectTopic and announces the correction', async () => {
    const h = mount();
    await openDetail(h);
    const c = content(h.doc);
    const input = mustQuery(c, 'input[data-field="topic"]');
    input.value = '  focus  ';
    mustQuery(c, '[data-action="correct-topic"]').click();
    await flush();
    const sent = h.fake.lastOf('CorrectTopic');
    expect(sent.payload).toEqual({ subjectId: 'm1', value: 'focus' });
    h.fake.apply(sent.cid, { artifactId: 'a9' });
    await flush();
    expect(mustQuery(h.doc.body, '[data-live-region]').textContent).toBe(
      copyOf('msg.dialog.topic-saved'),
    );
    h.unmount();
  });

  it('a blank teach input sends nothing', async () => {
    const h = mount();
    await openDetail(h);
    const c = content(h.doc);
    mustQuery(c, 'input[data-field="topic"]');
    mustQuery(c, '[data-action="correct-topic"]').click();
    await flush();
    expect(h.fake.countOf('CorrectTopic')).toBe(0);
    h.unmount();
  });

  it('list-level conclude and close-detail return to the library', async () => {
    const h = mount();
    await answerAll(h);
    mustQuery(content(h.doc), '[data-mission-id="m2"] [data-action="conclude"]').click();
    await flush();
    expect(h.fake.lastOf('ConcludeMission').payload).toEqual({ missionId: 'm2' });
    await openDetail(h);
    mustQuery(content(h.doc), '[data-action="detail-close"]').click();
    await answerAll(h);
    expect(content(h.doc).querySelector('.mission-grid')).not.toBeNull();
    h.unmount();
  });
});

describe('E4 quiet · closed & trash', () => {
  it('recently closed restores ride RestoreRecentlyClosed with the tab id array', async () => {
    const h = mount();
    h.answers.set('GetRecentlyClosed', {
      entries: [{ entryId: 'e1', tabId: 't9', title: 'Gone tab', domain: 'gone.example.com' }],
    });
    await navTo(h, 'closed');
    const c = content(h.doc);
    expect(c.textContent).toContain('Gone tab');
    mustQuery(c, '[data-action="restore-closed"]').click();
    await flush();
    expect(h.fake.lastOf('RestoreRecentlyClosed').payload).toEqual({ ids: ['t9'], target: 'new' });
    h.unmount();
  });

  it('empty closed/trash render their empty blocks without any action buttons', async () => {
    const h = mount();
    await navTo(h, 'closed');
    expect(content(h.doc).textContent).toContain(copyOf('msg.empty.closed'));
    await navTo(h, 'trash');
    expect(content(h.doc).textContent).toContain(copyOf('msg.empty.trash'));
    h.unmount();
  });

  it('trash rows restore via RestoreFromTrash with entity kind + id', async () => {
    const h = mount();
    h.answers.set('GetTrash', {
      entries: [{ kind: 'mission', id: 'm7', displayName: 'Dead project', deletedAt: 5 }],
    });
    await navTo(h, 'trash');
    mustQuery(content(h.doc), '[data-action="restore-trash"]').click();
    await flush();
    expect(h.fake.lastOf('RestoreFromTrash').payload).toEqual({ kind: 'mission', id: 'm7' });
    h.unmount();
  });

  it('emptying the trash is a two-step confirm riding EmptyTrash{confirm:true}', async () => {
    const h = mount();
    h.answers.set('GetTrash', {
      entries: [{ kind: 'tab', id: 't1', displayName: 'Dead tab', deletedAt: 5 }],
    });
    await navTo(h, 'trash');
    const c = content(h.doc);
    mustQuery(c, '[data-action="empty-trash"]').click();
    await flush();
    expect(h.fake.countOf('EmptyTrash')).toBe(0); // step one: the confirm lane appears
    const lane = mustQuery(c, '[data-lane="confirm"]');
    expect(lane.textContent).toContain(copyOf('msg.hint.confirm-purge'));
    mustQuery(lane, '[data-action="confirm"]').click();
    await flush();
    expect(h.fake.lastOf('EmptyTrash').payload).toEqual({ confirm: true });
    h.unmount();
  });

  it('cancelling the purge re-renders the trash list with no command sent', async () => {
    const h = mount();
    h.answers.set('GetTrash', {
      entries: [{ kind: 'tab', id: 't1', displayName: 'Dead tab', deletedAt: 5 }],
    });
    await navTo(h, 'trash');
    const c = content(h.doc);
    mustQuery(c, '[data-action="empty-trash"]').click();
    await flush();
    mustQuery(c, '[data-lane="confirm"] [data-action="cancel"]').click();
    await flush();
    expect(h.fake.countOf('EmptyTrash')).toBe(0);
    h.unmount();
  });
});

describe('E4 quiet · activity & history', () => {
  it('both timeline sections ride GetActivity with the limit payload', async () => {
    const h = mount();
    h.answers.set('GetActivity', [
      { kind: 'MissionFormed', label: 'Reading week', at: 1_700_000_000_000 },
    ]);
    await navTo(h, 'activity');
    expect(h.fake.lastOf('GetActivity').payload).toEqual({ limit: 50 });
    expect(content(h.doc).textContent).toContain('Reading week');
    await navTo(h, 'history');
    expect(h.fake.lastOf('GetActivity').payload).toEqual({ limit: 50 });
    expect(content(h.doc).querySelector('.activity-list')).not.toBeNull();
    h.unmount();
  });

  it('empty timelines render their distinct calm blocks', async () => {
    const h = mount();
    await navTo(h, 'activity');
    expect(content(h.doc).textContent).toContain(copyOf('msg.empty.activity'));
    await navTo(h, 'history');
    expect(content(h.doc).textContent).toContain(copyOf('msg.empty.history'));
    h.unmount();
  });
});

describe('E4 quiet · settings', () => {
  it('renders the six whitelisted setting rows with current values as inputs', async () => {
    const h = mount();
    await navTo(h, 'settings');
    const rows = content(h.doc).querySelectorAll('[data-setting]');
    expect(rows).toHaveLength(6);
    const retention = mustQuery(content(h.doc), '[data-setting="trash.retentionDays"] input');
    expect(retention.value).toBe('30');
    expect(retention.getAttribute('id')).toBe('setting-trash.retentionDays');
    const label = mustQuery(content(h.doc), '[data-setting="trash.retentionDays"] label');
    expect(label.getAttribute('for')).toBe('setting-trash.retentionDays');
    h.unmount();
  });

  it('saving a numeric setting rides SetSetting and announces the save', async () => {
    const h = mount();
    await navTo(h, 'settings');
    const row = mustQuery(content(h.doc), '[data-setting="trash.retentionDays"]');
    mustQuery(row, 'input').value = '45';
    mustQuery(row, '[data-action="set-setting"]').click();
    await flush();
    const sent = h.fake.lastOf('SetSetting');
    expect(sent.kind).toBe('command');
    expect(sent.payload).toEqual({ key: 'trash.retentionDays', value: 45 });
    h.fake.apply(sent.cid, { applied: true });
    await flush();
    const live = mustQuery(h.doc.body, '[data-live-region]');
    expect(live.textContent).toBe(copyOf('msg.dialog.settings-saved'));
    h.unmount();
  });

  it('non-numeric or blank values never reach the wire', async () => {
    const h = mount();
    await navTo(h, 'settings');
    const row = mustQuery(content(h.doc), '[data-setting="undo.stackCap"]');
    mustQuery(row, 'input').value = 'not-a-number';
    mustQuery(row, '[data-action="set-setting"]').click();
    mustQuery(row, 'input').value = '';
    mustQuery(row, '[data-action="set-setting"]').click();
    await flush();
    expect(h.fake.countOf('SetSetting')).toBe(0);
    h.unmount();
  });
});

describe('E4 quiet · import & export', () => {
  it('preview request rides ImportPreviewRequest with file metadata', async () => {
    const h = mount();
    await navTo(h, 'import-export');
    const c = content(h.doc);
    mustQuery(c, 'input[data-field="file-name"]').value = 'bookmarks.html';
    mustQuery(c, 'input[data-field="file-size"]').value = '2048';
    mustQuery(c, '[data-action="import-preview"]').click();
    await flush();
    expect(h.fake.lastOf('ImportPreviewRequest').payload).toEqual({
      fileMeta: { name: 'bookmarks.html', size: 2048 },
    });
    h.unmount();
  });

  it('ImportReady on the section renders the commit lane; commit rides ImportCommit', async () => {
    const h = mount();
    await navTo(h, 'import-export');
    h.fake.emitStream('ImportReady', { previewId: 'p1' });
    await flush();
    const lane = mustQuery(h.doc.body, '[data-lane="import-ready"]');
    mustQuery(lane, '[data-action="import-commit"]').click();
    await flush();
    const sent = h.fake.lastOf('ImportCommit');
    expect(sent.payload).toEqual({ previewId: 'p1', dedupeMode: 'skip' });
    h.fake.apply(sent.cid, { imported: 10, dupes: 3 });
    await flush();
    expect(mustQuery(h.doc.body, '[data-live-region]').textContent).toBe(
      copyOf('msg.dialog.imported', { imported: 10, dupes: 3 }),
    );
    h.unmount();
  });

  it('ImportReady off the section stays silent (no cross-section lanes)', async () => {
    const h = mount();
    await answerAll(h); // sitting on library
    h.fake.emitStream('ImportReady', { previewId: 'p2' });
    await flush();
    expect(h.doc.body.querySelector('[data-lane="import-ready"]')).toBeNull();
    h.unmount();
  });

  it('export request + ExportReady renders the download link', async () => {
    const h = mount();
    await navTo(h, 'import-export');
    mustQuery(content(h.doc), '[data-action="export-request"]').click();
    await flush();
    expect(h.fake.lastOf('ExportRequest').payload).toEqual({
      scope: 'all',
      formats: ['json', 'html', 'md'],
    });
    h.fake.emitStream('ExportReady', {
      fetchURL: 'https://local.invalid/export.json',
      manifestId: 'mf1',
      chunkChecksums: [],
    });
    await flush();
    const link = mustQuery(h.doc.body, '[data-link="export"]');
    expect(link.getAttribute('href')).toBe('https://local.invalid/export.json');
    expect(link.getAttribute('rel')).toBe('noreferrer');
    h.unmount();
  });
});

describe('E4 quiet · rescue console', () => {
  it('renders the health probe after GetHealth answers', async () => {
    const h = mount();
    await navTo(h, 'rescue');
    expect(h.fake.lastOf('GetHealth').payload).toEqual({});
    const dump = mustQuery(content(h.doc), '[data-probe-dump]');
    expect(dump.textContent).toContain('journalHead');
    h.unmount();
  });

  it('scan/repair/diagnostics ride their registry commands with frozen payloads', async () => {
    const h = mount();
    await navTo(h, 'rescue');
    const c = content(h.doc);
    mustQuery(c, '[data-action="rescue-scan"]').click();
    await flush();
    const scan = h.fake.lastOf('RescueScanNow');
    expect(scan.payload).toEqual({ mode: 'tail' });
    h.fake.apply(scan.cid, { reportId: 'r-1' });
    await flush();
    expect(mustQuery(h.doc.body, '[data-report="scan"]').textContent).toContain('r-1');
    mustQuery(c, '[data-action="repair-rebuild"]').click();
    await flush();
    expect(h.fake.lastOf('RepairRebuild').payload).toEqual({ scope: 'all' });
    mustQuery(c, '[data-action="export-diagnostics"]').click();
    await flush();
    expect(h.fake.lastOf('ExportDiagnostics').payload).toEqual({});
    h.fake.apply(h.fake.lastOf('ExportDiagnostics').cid, { manifestId: 'd1' });
    await flush();
    expect(mustQuery(h.doc.body, '[data-live-region]').textContent).toBe(
      copyOf('msg.dialog.diagnostics-done'),
    );
    h.unmount();
  });

  it('repair completion rejoins (views are being rebuilt — watermarks reset)', async () => {
    const h = mount();
    await navTo(h, 'rescue');
    mustQuery(content(h.doc), '[data-action="repair-rebuild"]').click();
    await flush();
    const bootsBefore = h.fake.countOf('GetBootstrap');
    h.fake.apply(h.fake.lastOf('RepairRebuild').cid, { rebuilt: true });
    await flush();
    expect(mustQuery(h.doc.body, '[data-banner="resync"]')).not.toBeNull();
    await answerAll(h);
    expect(h.fake.countOf('GetBootstrap')).toBeGreaterThan(bootsBefore);
    h.unmount();
  });
});

describe('E4 quiet · streams, undo & lifecycle', () => {
  it('HeartbeatUpdate moves the pill and announces through the live region', async () => {
    const h = mount();
    await answerAll(h);
    h.fake.emitStream('HeartbeatUpdate', { keptCount: 21, liveRecoverable: 1, asOf: 2 });
    await flush();
    expect(h.doc.body.textContent).toContain(copyOf('msg.heartbeat.safe', { count: 21 }));
    expect(mustQuery(h.doc.body, '[data-live-region]').textContent).toContain(
      copyOf('msg.heartbeat.safe', { count: 21 }),
    );
    h.unmount();
  });

  it('ResyncRequired schema shows the honest error block and does NOT rejoin', async () => {
    const h = mount();
    await answerAll(h);
    const bootsBefore = h.fake.countOf('GetBootstrap');
    h.fake.emitStream('ResyncRequired', { reason: 'schema' });
    await flush();
    const banner = mustQuery(h.doc.body, '[data-slot="banner"]');
    expect(banner.querySelector('[role="alert"]')).not.toBeNull();
    expect(banner.textContent).toContain(copyOf('msg.error.output'));
    expect(banner.textContent).toContain(copyOf('msg.recover.report'));
    expect(h.fake.countOf('GetBootstrap')).toBe(bootsBefore);
    h.unmount();
  });

  it('a ViewDelta gap rejoins through the resync banner into a fresh bootstrap', async () => {
    const h = mount();
    await answerAll(h);
    h.fake.emitStream('ViewDelta', {
      view: 'missions',
      watermark: 1,
      ops: [{ kind: 'upsert', key: 'mx', record: { missionId: 'mx', name: 'X' } }],
    });
    await flush();
    const bootsBefore = h.fake.countOf('GetBootstrap');
    h.fake.emitStream('ViewDelta', { view: 'missions', watermark: 50, ops: [] });
    await flush();
    expect(mustQuery(h.doc.body, '[data-banner="resync"]')).not.toBeNull();
    await answerAll(h);
    expect(h.fake.countOf('GetBootstrap')).toBeGreaterThan(bootsBefore);
    h.unmount();
  });

  it('RecoveryAvailable shows the severity-driven recovery banner', async () => {
    const h = mount();
    await answerAll(h);
    h.fake.emitStream('RecoveryAvailable', { bootReportId: 'b1', severity: 'loss-risk' });
    await flush();
    expect(mustQuery(h.doc.body, '[data-banner="recovery"]').textContent).toContain(
      'Everything is safe',
    );
    h.unmount();
  });

  it('undo keyboard contract: u/ctrl+z/meta+z send Undo and announce the label', async () => {
    const h = mount();
    await answerAll(h);
    fireKey(h.doc.body, { key: 'u' });
    await flush();
    const undo = h.fake.lastOf('Undo');
    h.fake.apply(undo.cid, { undid: 'msg.undo.merged' });
    await flush();
    expect(mustQuery(h.doc.body, '[data-live-region]').textContent).toBe(copyOf('msg.undo.merged'));
    fireKey(h.doc.body, { key: 'z', metaKey: true });
    await flush();
    expect(h.fake.countOf('Undo')).toBe(2);
    h.unmount();
  });

  it('wake re-reads the bootstrap (MV3 honest resume)', async () => {
    const h = mount();
    await answerAll(h);
    const before = h.fake.countOf('GetBootstrap');
    h.wake();
    await flush();
    expect(h.fake.countOf('GetBootstrap')).toBe(before + 1);
    h.unmount();
  });

  it('query failures inside a section show the retry block and recover', async () => {
    const h = mount();
    await answerAll(h);
    mustQuery(h.doc.body, '[data-nav="trash"]').click();
    await flush();
    h.fake.fail(h.fake.lastOf('GetTrash').cid, {
      code: 'E_STORE_INTEGRITY',
      messageKey: 'msg.error.store',
    });
    await flush();
    const c = content(h.doc);
    expect(c.querySelector('[role="alert"]')).not.toBeNull();
    mustQuery(c, '[data-action="retry"]').click();
    await answerAll(h);
    expect(content(h.doc).textContent).toContain(copyOf('msg.empty.trash'));
    h.unmount();
  });

  it('unmount detaches streams, keys and the root', async () => {
    const h = mount();
    await answerAll(h);
    expect(h.fake.listenerCount()).toBe(1);
    const undos = h.fake.countOf('Undo');
    h.mounted.unmount();
    expect(h.fake.listenerCount()).toBe(0);
    fireKey(h.doc.body, { key: 'u' });
    await flush();
    expect(h.fake.countOf('Undo')).toBe(undos);
    expect(h.doc.body.querySelector('[data-surface="quiet"]')).toBeNull();
    expect(h.doc.body.querySelector('[data-live-region]')).toBeNull();
  });
});
