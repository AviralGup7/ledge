// E4 · Quiet page suite — the place of business. Laws: nav renders all sections
// and section switches issue exactly the right query with exactly the right
// payload; detail/topic/trash/settings/import-export/rescue flows ride registry
// commands with frozen payloads; live-region announcements carry catalog copy;
// stream lanes (import-ready/export-ready) render only their own affordances;
// undo keyboard contract; boot/rejoin/cleanup semantics.
import { describe, expect, it } from 'vitest';
import { ok } from '@/shared-kernel/result/index.js';
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
      missionId: '01HF7YAT001000000000000000',
      name: 'Reading week',
      namedBy: 'user',
      state: 'parked',
      concluded: false,
      tabCount: 3,
    },
    {
      missionId: '01HF7YB1QFE000000000000000',
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
    'favorite.mission.01HF7YAT001000000000000000': true,
  },
  heartbeat: { keptCount: 14, liveRecoverable: 2, asOf: 1_700_000_000_000 },
};

interface QuietHarness {
  readonly doc: FakeDocument;
  readonly fake: FakeTransport;
  readonly mounted: Mounted;
  readonly wake: () => void;
  readonly answers: Map<string, unknown>;
  readonly staged: { name: string; size: number; bytes: Uint8Array }[];
  readonly unmount: () => void;
}

/** E6-T01 · a pending loss-risk GetBootReport DTO (asOf fresh relative per render). */
const pendingReport = (over: Readonly<Record<string, unknown>> = {}): Record<string, unknown> => ({
  bootReportId: '01HF7XRECEVERY000000000000',
  severity: 'loss-risk',
  cause: 'crashed',
  copyKey: 'msg.recovery.crashed',
  outcome: 'recovered',
  asOf: Date.now() - 210_000,
  scope: { tabsRecoverable: 3, missionsAffected: 2 },
  crossCheck: 'applied',
  disclosure: [
    { token: 'journal-truncate', count: 1 },
    { token: 'left-open', count: 3 },
  ],
  pending: true,
  restoredAt: null,
  ...over,
});

/** The staged-file flow rides a duck-typed File (no DOM File in the unit lane). */
const hatchFile = (elTarget: unknown, name: string, text: string): void => {
  const bytes = new TextEncoder().encode(text);
  const duckFile = {
    name,
    size: bytes.length,
    arrayBuffer: () =>
      Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  };
  (elTarget as { files?: unknown }).files = { 0: duckFile, length: 1 };
  (elTarget as { dispatchEvent: (ev: Event) => void }).dispatchEvent(
    new (class {
      readonly type = 'change';
    })() as unknown as Event,
  );
};

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
    ['GetBootReport', null],
  ]);
  let wakeListener: (() => void) | undefined;
  const staged: { name: string; size: number; bytes: Uint8Array }[] = [];
  const mounted = mountQuietPage(asDocument(doc), {
    transport: fake.transport,
    entropy: createTestEntropy(),
    onWake: (listener) => {
      wakeListener = listener;
      return () => {};
    },
    importBytesStage: {
      put: (input: { name: string; size: number; bytes: Uint8Array }) => {
        staged.push(input);
        return Promise.resolve(ok({ staged: true as const }));
      },
    },
  });
  return {
    doc,
    fake,
    mounted,
    answers,
    staged,
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
      missionId: '01HF7YAT001000000000000000',
      name: 'Reading week',
      namedBy: 'user',
      state: 'parked',
      concluded: false,
      tabCount: 2,
    },
    tabs: [
      {
        tabId: '01HF7YCQVR90000R0000000000',
        missionId: '01HF7YAT001000000000000000',
        url: 'https://papers.example.com/a',
        title: 'Kept paper',
        domain: 'papers.example.com',
        state: 'kept',
        firstSeenAt: 1,
        lastActiveAt: 2,
      },
      {
        tabId: '01HF7YCZK7P000000000000000',
        missionId: '01HF7YAT001000000000000000',
        url: 'https://notes.example.com/b',
        title: 'Notes',
        domain: 'notes.example.com',
        state: 'kept',
        firstSeenAt: 1,
        lastActiveAt: 2,
      },
    ],
    artifacts: [
      { artifactId: '01HF7YDPSMXJ00000000000000', kind: 'topic', value: 'attention' },
      { artifactId: '01HF7YDYH3A000000000000000', kind: 'naming', value: 'reading' },
    ],
  };

  const openDetail = async (h: QuietHarness): Promise<void> => {
    h.answers.set('GetMissionDetail', DETAIL);
    await answerAll(h);
    mustQuery(
      content(h.doc),
      '[data-mission-id="01HF7YAT001000000000000000"] [data-action="open-detail"]',
    ).click();
    await answerAll(h);
    expect(h.fake.lastOf('GetMissionDetail').payload).toEqual({
      missionId: '01HF7YAT001000000000000000',
    });
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
    expect(h.fake.lastOf('ResumeMission').payload).toEqual({
      missionId: '01HF7YAT001000000000000000',
      mode: 'full',
    });
    // Applied ⇒ the after-hook returns to the library; the next flow starts there.
    h.fake.apply(h.fake.lastOf('ResumeMission').cid, { missionId: '01HF7YAT001000000000000000' });
    await answerAll(h);
    await openDetail(h);
    mustQuery(content(h.doc), '[data-action="archive"]').click();
    await flush();
    expect(h.fake.lastOf('ArchiveMission').payload).toEqual({
      missionId: '01HF7YAT001000000000000000',
    });
    h.fake.apply(h.fake.lastOf('ArchiveMission').cid, { archived: true });
    await answerAll(h);
    await openDetail(h);
    mustQuery(content(h.doc), '[data-action="conclude"]').click();
    await flush();
    expect(h.fake.lastOf('ConcludeMission').payload).toEqual({
      missionId: '01HF7YAT001000000000000000',
    });
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
    expect(h.fake.lastOf('DeleteEntity').payload).toEqual({
      kind: 'mission',
      id: '01HF7YAT001000000000000000',
    });
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
      id: '01HF7YAT001000000000000000',
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
    expect(sent.payload).toEqual({ subjectId: '01HF7YAT001000000000000000', value: 'focus' });
    h.fake.apply(sent.cid, { artifactId: '01HF7YE68JQ000000000000000' });
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
    mustQuery(
      content(h.doc),
      '[data-mission-id="01HF7YB1QFE000000000000000"] [data-action="conclude"]',
    ).click();
    await flush();
    expect(h.fake.lastOf('ConcludeMission').payload).toEqual({
      missionId: '01HF7YB1QFE000000000000000',
    });
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
      entries: [
        {
          entryId: '01HF7YENQGH000000000000000',
          tabId: '01HF7YDF25G000000000000000',
          title: 'Gone tab',
          domain: 'gone.example.com',
        },
      ],
    });
    await navTo(h, 'closed');
    const c = content(h.doc);
    expect(c.textContent).toContain('Gone tab');
    mustQuery(c, '[data-action="restore-closed"]').click();
    await flush();
    expect(h.fake.lastOf('RestoreRecentlyClosed').payload).toEqual({
      ids: ['01HF7YDF25G000000000000000'],
      target: 'new',
    });
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
      entries: [
        {
          kind: 'mission',
          id: '01HF7YFMNC5000000000000000',
          displayName: 'Dead project',
          deletedAt: 5,
        },
      ],
    });
    await navTo(h, 'trash');
    mustQuery(content(h.doc), '[data-action="restore-trash"]').click();
    await flush();
    expect(h.fake.lastOf('RestoreFromTrash').payload).toEqual({
      kind: 'mission',
      id: '01HF7YFMNC5000000000000000',
    });
    h.unmount();
  });

  it('emptying the trash is a two-step confirm riding EmptyTrash{confirm:true}', async () => {
    const h = mount();
    h.answers.set('GetTrash', {
      entries: [
        { kind: 'tab', id: '01HF7YCQVR90000R0000000000', displayName: 'Dead tab', deletedAt: 5 },
      ],
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
      entries: [
        { kind: 'tab', id: '01HF7YCQVR90000R0000000000', displayName: 'Dead tab', deletedAt: 5 },
      ],
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
  it('picking a file stages its bytes, then previews with file metadata (E5-T06)', async () => {
    const h = mount();
    await navTo(h, 'import-export');
    const c = content(h.doc);
    const text = 'https://example.com/a | A\nhttps://example.com/b | B';
    const size = new TextEncoder().encode(text).length;
    hatchFile(mustQuery(c, 'input[data-field="import-file"]'), 'tabs.txt', text);
    await flush();
    // The shelf got the exact bytes BEFORE the wire saw any metadata.
    expect(h.staged.length).toBe(1);
    expect(h.staged[0]?.name).toBe('tabs.txt');
    expect(h.staged[0]?.size).toBe(size);
    expect(new TextDecoder().decode(h.staged[0]?.bytes)).toBe(text);
    expect(h.fake.lastOf('ImportPreviewRequest').payload).toEqual({
      fileMeta: { name: 'tabs.txt', size },
    });
    h.unmount();
  });

  it('a staged file that the SW refuses renders the typed corrupt-abort card on the panel', async () => {
    const h = mount();
    await navTo(h, 'import-export');
    const c = content(h.doc);
    hatchFile(mustQuery(c, 'input[data-field="import-file"]'), 'odd.txt', 'lorem ipsum');
    await flush();
    h.fake.fail(h.fake.lastOf('ImportPreviewRequest').cid, {
      code: 'E_FORMAT_UNKNOWN',
      messageKey: 'msg.error.format',
    });
    await flush();
    const block = mustQuery(h.doc.body, '[data-block="import"]');
    const errCard = mustQuery(block, '[data-state="error"]');
    expect(errCard.textContent).toContain(copyOf('msg.import.unsupported'));
    h.unmount();
  });

  it('ImportReady on the section renders the census lane; commit rides ImportCommit', async () => {
    const h = mount();
    await navTo(h, 'import-export');
    h.fake.emitStream('ImportReady', {
      previewId: '01HF7YEXEZY000000000000000',
      modelSummary: 'onetab:m2:t7:r1:d2',
    });
    await flush();
    const lane = mustQuery(h.doc.body, '[data-lane="import-ready"]');
    // W15: counts + detected structure before any commit happens.
    expect(mustQuery(lane, '[data-line="import-detected"]').textContent).toBe(
      copyOf('msg.import.detected', { parser: 'onetab', missions: 2, tabs: 7 }),
    );
    expect(mustQuery(lane, '[data-line="import-extras"]').textContent).toBe(
      copyOf('msg.import.extras', { dupes: 2, rejects: 1 }),
    );
    expect(mustQuery(lane, '[data-line="import-rejects"]').textContent).toBe(
      copyOf('msg.import.rejects-note', { rejects: 1 }),
    );
    mustQuery(lane, '[data-action="import-commit"]').click();
    await flush();
    const sent = h.fake.lastOf('ImportCommit');
    expect(sent.payload).toEqual({ previewId: '01HF7YEXEZY000000000000000', dedupeMode: 'skip' });
    h.fake.apply(sent.cid, { imported: 10, dupes: 3, rejects: 1 });
    await flush();
    // The receipt line keeps the imported dialog; the live region carries the
    // rejects note (announcements replace, the receipt persists).
    expect(mustQuery(h.doc.body, '[data-line="import-receipt"]').textContent).toBe(
      copyOf('msg.dialog.imported', { imported: 10, dupes: 3 }),
    );
    expect(mustQuery(h.doc.body, '[data-live-region]').textContent).toBe(
      copyOf('msg.import.rejects-note', { rejects: 1 }),
    );
    // Commit consumed the flow: the lane is gone.
    expect(h.doc.body.querySelector('[data-lane="import-ready"]')).toBeNull();
    h.unmount();
  });

  it('dedupe-mode choice rides the commit radio (import-anyway), cancel clears the flow', async () => {
    const h = mount();
    await navTo(h, 'import-export');
    h.fake.emitStream('ImportReady', {
      previewId: '01HF7YEXEZY000000000000001',
      modelSummary: 'sessionbuddy:m1:t4:r0:d1',
    });
    await flush();
    const lane = mustQuery(h.doc.body, '[data-lane="import-ready"]');
    (mustQuery(lane, '[data-field="dedupe-anyway"]') as unknown as { checked: boolean }).checked =
      true;
    mustQuery(lane, '[data-action="import-commit"]').click();
    await flush();
    expect(h.fake.lastOf('ImportCommit').payload).toEqual({
      previewId: '01HF7YEXEZY000000000000001',
      dedupeMode: 'import-anyway',
    });
    h.fake.apply(h.fake.lastOf('ImportCommit').cid, { imported: 5, dupes: 1, rejects: 0 });
    await flush();

    h.fake.emitStream('ImportReady', {
      previewId: '01HF7YEXEZY000000000000002',
      modelSummary: 'netscape:m3:t9:r0:d0',
    });
    await flush();
    mustQuery(h.doc.body, '[data-action="import-cancel"]').click();
    await flush();
    expect(h.doc.body.querySelector('[data-lane="import-ready"]')).toBeNull();
    expect(h.fake.countOf('ImportCommit')).toBe(1); // cancel sent nothing to the wire
    h.unmount();
  });

  it('ImportReady off the section stays silent (no cross-section lanes)', async () => {
    const h = mount();
    await answerAll(h); // sitting on library
    h.fake.emitStream('ImportReady', {
      previewId: '01HF7YF56EB000000000000000',
      modelSummary: 'onetab:m1:t2:r0:d0',
    });
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
    h.fake.apply(scan.cid, { reportId: '01HF7YFCXXR000000000000000' });
    await flush();
    expect(mustQuery(h.doc.body, '[data-report="scan"]').textContent).toContain(
      '01HF7YFCXXR000000000000000',
    );
    mustQuery(c, '[data-action="repair-rebuild"]').click();
    await flush();
    expect(h.fake.lastOf('RepairRebuild').payload).toEqual({ scope: 'all' });
    mustQuery(c, '[data-action="export-diagnostics"]').click();
    await flush();
    expect(h.fake.lastOf('ExportDiagnostics').payload).toEqual({});
    h.fake.apply(h.fake.lastOf('ExportDiagnostics').cid, {
      manifestId: '01HF7YEE014000000000000000',
    });
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

  it('RecoveryAvailable is a hint only — the card arrives via GetBootReport, §14.4-gated', async () => {
    const h = mount();
    await answerAll(h);
    // §14.4: without a pending loss-risk report there is NO card, whatever the hint says.
    h.fake.emitStream('RecoveryAvailable', {
      bootReportId: '01HF7YBRXWN000000000000000',
      severity: 'loss-risk',
    });
    await answerAll(h);
    expect(h.doc.body.querySelector('[data-card="recovery"]')).toBeNull();
    // The incident materializes in the DTO; the same hint now lands the card.
    h.answers.set('GetBootReport', pendingReport());
    h.fake.emitStream('RecoveryAvailable', {
      bootReportId: '01HF7YBRXWN000000000000000',
      severity: 'loss-risk',
    });
    await answerAll(h);
    const card = mustQuery(h.doc.body, '[data-card="recovery"]');
    expect(card.getAttribute('data-severity')).toBe('loss-risk');
    expect(mustQuery(card, '[data-line="recovery-title"]').textContent).toContain(
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

describe('E6-T01 quiet · W7 recovery card (§14.4 venue + catalog copy)', () => {
  it('pending report renders title/scope with exact catalog copy', async () => {
    const h = mount();
    h.answers.set('GetBootReport', pendingReport({ asOf: Date.now() - 195_000 }));
    await answerAll(h);
    const card = mustQuery(h.doc.body, '[data-card="recovery"]');
    expect(card.getAttribute('data-severity')).toBe('loss-risk');
    expect(mustQuery(card, '[data-line="recovery-title"]').textContent).toBe(
      copyOf('msg.recovery.crashed', { asOf: copyOf('msg.time.minutes', { count: 3 }) }),
    );
    expect(mustQuery(card, '[data-line="recovery-scope"]').textContent).toBe(
      copyOf('msg.recovery.scope', { tabs: 3, missions: 2 }),
    );
    // §14.4: the card is not a banner — the banner lane stays clean.
    expect(mustQuery(h.doc.body, '[data-slot="banner"]').textContent).toBe('');
    h.unmount();
  });

  it('put-back rides RestoreBootSession and resolves to the restored receipt', async () => {
    const h = mount();
    h.answers.set('GetBootReport', pendingReport());
    await answerAll(h);
    mustQuery(h.doc.body, '[data-action="put-back"]').click();
    await flush();
    const sent = h.fake.lastOf('RestoreBootSession');
    expect(sent.payload).toEqual({ bootReportId: '01HF7XRECEVERY000000000000' });
    h.fake.apply(sent.cid, { missionsRestored: 2, tabsRestored: 3, disclosure: [] });
    await flush();
    expect(h.doc.body.querySelector('[data-card="recovery"]')).toBeNull();
    expect(mustQuery(h.doc.body, '[data-card="recovery-resolved"]').textContent).toBe(
      copyOf('msg.recovery.restored'),
    );
    expect(mustQuery(h.doc.body, '[data-live-region]').textContent).toBe(
      copyOf('msg.recovery.restored'),
    );
    h.unmount();
  });

  it('content-gap tokens resolve to the honest partial line', async () => {
    const h = mount();
    h.answers.set('GetBootReport', pendingReport());
    await answerAll(h);
    mustQuery(h.doc.body, '[data-action="put-back"]').click();
    await flush();
    h.fake.apply(h.fake.lastOf('RestoreBootSession').cid, {
      missionsRestored: 1,
      tabsRestored: 2,
      disclosure: ['no-content'],
    });
    await flush();
    expect(mustQuery(h.doc.body, '[data-card="recovery-resolved"]').textContent).toBe(
      copyOf('msg.recovery.restored-partial'),
    );
    h.unmount();
  });

  it('review-first expands disclosure notes with catalog copy and toggles shut', async () => {
    const h = mount();
    h.answers.set('GetBootReport', pendingReport());
    await answerAll(h);
    const card = mustQuery(h.doc.body, '[data-card="recovery"]');
    expect(card.querySelector('[data-panel="recovery-review"]')).toBeNull();
    mustQuery(card, '[data-action="review-first"]').click();
    await flush();
    const panel = mustQuery(h.doc.body, '[data-panel="recovery-review"]');
    expect(mustQuery(panel, '[data-line="recovery-note-left-open"]').textContent).toBe(
      copyOf('msg.recovery.note-left-open', { count: 3 }),
    );
    expect(mustQuery(panel, '[data-line="recovery-note-journal-truncate"]').textContent).toBe(
      copyOf('msg.recovery.note-truncate'),
    );
    mustQuery(h.doc.body, '[data-action="review-first"]').click();
    await flush();
    expect(h.doc.body.querySelector('[data-panel="recovery-review"]')).toBeNull();
    h.unmount();
  });

  it('non-pending reports never render a card (chip is the guardian venue)', async () => {
    const h = mount();
    h.answers.set('GetBootReport', pendingReport({ severity: 'clean-abnormal', pending: false }));
    await answerAll(h);
    expect(h.doc.body.querySelector('[data-card="recovery"]')).toBeNull();
    h.fake.emitStream('RecoveryAvailable', {
      bootReportId: '01HF7XRECEVERY000000000000',
      severity: 'clean-abnormal',
    });
    await answerAll(h);
    expect(h.doc.body.querySelector('[data-card="recovery"]')).toBeNull();
    h.unmount();
  });
});

// E6-T02 · candidates panel — boot-time snapshot rows, confirm-before-restore
// toggles (default excluded), additive includeCandidates put-back payload.
describe('E6-T02 quiet · recovery candidates panel (confirm-before-restore)', () => {
  const SNAPSHOT = [
    { url: 'https://alpha.test/one', title: 'Alpha one' },
    { url: 'https://beta.test/two', title: 'Beta two' },
  ];

  it('renders snapshot rows with catalog head copy; absent/empty snapshot hides the panel', async () => {
    const h = mount();
    h.answers.set('GetBootReport', pendingReport({ crossCheckCandidates: SNAPSHOT }));
    await answerAll(h);
    expect(mustQuery(h.doc.body, '[data-line="recovery-candidates-head"]').textContent).toBe(
      copyOf('msg.recovery.candidates-head', { count: 2 }),
    );
    const rows = h.doc.body.querySelectorAll('[data-line="recovery-candidate"]');
    expect(rows.length).toBe(2);
    const first = rows[0];
    const second = rows[1];
    if (first === undefined || second === undefined) throw new Error('rows must exist');
    expect(mustQuery(first, '[data-line="recovery-candidate-title"]').textContent).toBe(
      'Alpha one',
    );
    expect(mustQuery(second, '[data-url]').getAttribute('data-url')).toBe(SNAPSHOT[1]?.url);
    h.unmount();

    const h2 = mount();
    h2.answers.set('GetBootReport', pendingReport()); // no key ⇒ no snapshot taken
    await answerAll(h2);
    expect(h2.doc.body.querySelector('[data-panel="recovery-candidates"]')).toBeNull();
    h2.unmount();

    const h3 = mount();
    h3.answers.set('GetBootReport', pendingReport({ crossCheckCandidates: [] }));
    await answerAll(h3);
    expect(h3.doc.body.querySelector('[data-panel="recovery-candidates"]')).toBeNull();
    h3.unmount();
  });

  it('toggle-in arms the payload; untoggled rows never ride the put-back', async () => {
    const h = mount();
    h.answers.set('GetBootReport', pendingReport({ crossCheckCandidates: SNAPSHOT }));
    await answerAll(h);
    // Default state: every candidate excluded.
    const first = mustQuery(
      h.doc.body,
      '[data-action="include-candidate"][data-url="https://alpha.test/one"]',
    );
    expect(first.getAttribute('aria-pressed')).toBe('false');
    expect(first.textContent).toBe(copyOf('msg.action.include-candidate'));
    first.click();
    await flush();
    const armed = mustQuery(
      h.doc.body,
      '[data-action="include-candidate"][data-url="https://alpha.test/one"]',
    );
    expect(armed.getAttribute('aria-pressed')).toBe('true');
    expect(armed.textContent).toBe(copyOf('msg.action.exclude-candidate'));

    mustQuery(h.doc.body, '[data-action="put-back"]').click();
    await flush();
    const sent = h.fake.lastOf('RestoreBootSession');
    expect(sent.payload).toEqual({
      bootReportId: '01HF7XRECEVERY000000000000',
      includeCandidates: ['https://alpha.test/one'],
    });
    h.fake.apply(sent.cid, {
      missionsRestored: 2,
      tabsRestored: 3,
      disclosure: [],
      candidatesRestored: 1,
    });
    await flush();
    expect(mustQuery(h.doc.body, '[data-card="recovery-resolved"]').textContent).toBe(
      copyOf('msg.recovery.restored'),
    );
    h.unmount();
  });

  it('nothing toggled ⇒ the additive payload is an explicit empty list (never stranger urls)', async () => {
    const h = mount();
    h.answers.set('GetBootReport', pendingReport({ crossCheckCandidates: SNAPSHOT }));
    await answerAll(h);
    mustQuery(h.doc.body, '[data-action="put-back"]').click();
    await flush();
    const sent = h.fake.lastOf('RestoreBootSession');
    expect(sent.payload).toEqual({
      bootReportId: '01HF7XRECEVERY000000000000',
      includeCandidates: [],
    });
    h.unmount();
  });
});

// E6-T04/T05/T06 · rescue console v2 — §12 probe rows, unified ring timeline,
// cadence confirm flow, armed download gesture.
describe('E6 quiet · rescue console (probes + timeline + cadence + bundle)', () => {
  const HEALTH_DUMP = {
    registryV: 1,
    probes: [
      {
        name: 'journal-tail-freshness',
        wired: true,
        status: 'ok',
        fields: { scan: 'ok', suspects: 0 },
      },
      { name: 'dangling-intents', wired: true, status: 'warn', fields: { pending: 2 } },
      { name: 'ai-lanes', wired: false, status: 'unwired', fields: { tier: 'v1.1' } },
    ],
    lastBundle: null,
    recentRing: [
      {
        slot: 3,
        at: Date.now() - 61_000,
        level: 'info',
        kind: 'command',
        msg: 'command:ParkTab:applied',
        ctxHash: 'x',
      },
      {
        slot: 4,
        at: Date.now() - 31_000,
        level: 'warn',
        kind: 'scan',
        msg: 'scan-tail',
        ctxHash: 'y',
      },
      {
        slot: 5,
        at: Date.now() - 11_000,
        level: 'warn',
        kind: 'probe',
        msg: 'probe-run-issues',
        ctxHash: 'z',
      },
    ],
    asOf: Date.now(),
  };

  it('renders §12 probe rows with lifecycle chips; the raw dump folds away intact', async () => {
    const h = mount();
    h.answers.set('GetHealth', HEALTH_DUMP);
    await navTo(h, 'rescue');
    expect(mustQuery(content(h.doc), '[data-line="probes-head"]').textContent).toBe(
      copyOf('msg.rescue.probes-head', { count: 3 }),
    );
    const rows = content(h.doc).querySelectorAll('[data-line="probe-row"]');
    expect(rows.length).toBe(3);
    // Lifecycle honesty: unwired rides its own neutral chip, never green.
    expect(mustQuery(content(h.doc), '[data-chip="probe-unwired"]').textContent).toBe(
      copyOf('msg.state.probe-unwired'),
    );
    expect(mustQuery(content(h.doc), '[data-chip="probe-warn"]').textContent).toBe(
      copyOf('msg.state.probe-warn'),
    );
    // The raw dump survives inside the fold (tell-me-more lane).
    const fold = mustQuery(content(h.doc), '[data-panel="probe-fold"]');
    expect(mustQuery(fold, '[data-probe-dump]').textContent).toContain('dangling-intents');
    h.unmount();
  });

  it('unified timeline renders rows; kind filters narrow with aria-pressed honesty', async () => {
    const h = mount();
    h.answers.set('GetHealth', HEALTH_DUMP);
    await navTo(h, 'rescue');
    expect(mustQuery(content(h.doc), '[data-line="ring-head"]').textContent).toBe(
      copyOf('msg.rescue.timeline-head', { count: 3 }),
    );
    const all = content(h.doc).querySelectorAll('[data-line="ring-row"]');
    expect(all.length).toBe(3);
    const filterBtn = mustQuery(content(h.doc), '[data-action="ring-filter-command"]');
    expect(filterBtn.textContent).toBe(copyOf('msg.rescue.filter-commands'));
    filterBtn.click();
    await flush();
    const narrowed = content(h.doc).querySelectorAll('[data-line="ring-row"]');
    expect(narrowed.length).toBe(1);
    const surviving = narrowed[0];
    if (surviving === undefined) throw new Error('ring row vanished');
    expect(surviving.getAttribute('data-kind')).toBe('command');
    expect(
      mustQuery(content(h.doc), '[data-action="ring-filter-command"]').getAttribute('aria-pressed'),
    ).toBe('true');
    h.unmount();
  });

  it('bundle presence in the dump arms the download gesture (and only then)', async () => {
    const h = mount();
    h.answers.set('GetHealth', {
      ...HEALTH_DUMP,
      lastBundle: {
        bundleId: 'diag.bundle:9:abc',
        includeAddresses: false,
        size: 8,
        json: '{"a":1}',
      },
    });
    await navTo(h, 'rescue');
    expect(
      mustQuery(content(h.doc), '[data-action="download-bundle"]').getAttribute('data-armed'),
    ).toBe('true');
    h.unmount();
    // No bundle in the dump ⇒ the gesture stays disarmed.
    const h2 = mount();
    h2.answers.set('GetHealth', HEALTH_DUMP);
    await navTo(h2, 'rescue');
    expect(
      mustQuery(content(h2.doc), '[data-action="download-bundle"]').getAttribute('data-armed'),
    ).toBe('false');
    h2.unmount();
  });

  it('full scan cadence refusal ⇒ calm confirm ⇒ forced resend with the capability flag', async () => {
    const h = mount();
    await navTo(h, 'rescue');
    mustQuery(content(h.doc), '[data-action="rescue-scan-full"]').click();
    await flush();
    const first = h.fake.lastOf('RescueScanNow');
    expect(first.payload).toEqual({ mode: 'full' });
    h.fake.fail(first.cid, {
      code: 'E_DOMAIN_LEGALITY',
      retryable: false,
      messageKey: 'msg.error.domain',
      recoveryKey: 'msg.recover.retry',
      details: { reason: 'full-scan-cadence', nextEligibleAt: 1_900_000_000_000 },
    });
    await flush();
    expect(mustQuery(h.doc.body, '[data-line="force-confirm-copy"]').textContent).toBe(
      copyOf('msg.rescue.force-confirm'),
    );
    mustQuery(h.doc.body, '[data-action="scan-full-force"]').click();
    await flush();
    const forced = h.fake.lastOf('RescueScanNow');
    expect(forced.payload).toEqual({ mode: 'full', force: true });
    h.fake.apply(forced.cid, { reportId: '01HF8SCANFORCED0000000000' });
    await flush();
    expect(mustQuery(h.doc.body, '[data-report="scan-full"]').textContent).toContain(
      '01HF8SCANFORCED0000000000',
    );
    h.unmount();
  });
});
