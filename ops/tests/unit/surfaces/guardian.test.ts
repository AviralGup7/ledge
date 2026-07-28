// E4 · Guardian surface suite — the park strip's behavior over the wire. Laws:
// boot renders shell instantly then loads via queries; every action is a registry
// command riding a frozen envelope; R1 pending strip between ack and Applied; no
// optimistic truth (heartbeat moves only on HeartbeatUpdate); stream gap ⇒ full
// rejoin; wake ⇒ snapshot re-read (MV3 reconnect); unmount detaches everything.
import { describe, expect, it } from 'vitest';
import { copyOf } from '@/surfaces/components/copy/copy.js';
import { mountGuardian, type GuardianDeps, type Mounted } from '@/surfaces/guardian/guardian.js';
import type { PendingBrief } from '@/surfaces/components/widgets/brief-card.js';
import { CONTRACT_V } from '@/application/contracts/index.js';
import { FakeDocument, asDocument, fireKey, mustQuery, type FakeElement } from './fake-dom.js';
import {
  createFakeTransport,
  createTestEntropy,
  flush,
  type FakeTransport,
  type SentEnvelope,
} from './fake-transport.js';

const BOOTSTRAP = {
  missions: [
    {
      missionId: '01HF7YAT001000000000000000',
      name: 'Reading week',
      namedBy: 'user',
      state: 'parked',
      concluded: false,
      createdAt: 1_700_000_000_000,
      lastActiveAt: 1_700_000_001_000,
      tabCount: 3,
    },
    {
      missionId: '01HF7YB1QFE000000000000000',
      name: 'Trip planning',
      namedBy: 'system',
      state: 'live',
      concluded: false,
      createdAt: 1_700_000_002_000,
      lastActiveAt: 1_700_000_003_000,
      tabCount: 5,
    },
  ],
  recentlyClosed: [],
  trashCount: 0,
  watermark: 4,
  settings: { 'favorite.mission.01HF7YAT001000000000000000': true },
  heartbeat: { keptCount: 12, liveRecoverable: 4, asOf: 1_700_000_004_000 },
};

const OPEN_TABS = [
  {
    browserTabId: 11,
    windowId: 1,
    title: 'Standup notes',
    url: 'https://notes.example.com/standup',
    pinned: false,
    active: true,
    groupId: 7,
  },
  {
    browserTabId: 12,
    windowId: 1,
    title: 'Specs',
    url: 'https://specs.example.com/',
    pinned: true,
    active: false,
    groupId: null,
  },
  {
    browserTabId: 13,
    windowId: 2,
    title: 'Mail',
    url: 'https://mail.example.com/',
    pinned: false,
    active: false,
    groupId: null,
  },
];

interface GuardianHarness {
  readonly doc: FakeDocument;
  readonly fake: FakeTransport;
  readonly mounted: Mounted;
  readonly wake: () => void;
  readonly unmount: () => void;
}

const mount = (options?: {
  readonly ackResponder?: (env: SentEnvelope) => unknown;
  readonly briefs?: GuardianDeps['briefs'];
  readonly dupes?: GuardianDeps['dupes'];
}): GuardianHarness => {
  const doc = new FakeDocument();
  const fake = createFakeTransport();
  fake.respondWith((env) => options?.ackResponder?.(env) ?? { outcome: 'ack' });
  let wakeListener: (() => void) | undefined;
  let detachedWake = false;
  const mounted = mountGuardian(asDocument(doc), {
    transport: fake.transport,
    entropy: createTestEntropy(),
    ...(options?.briefs !== undefined ? { briefs: options.briefs } : {}),
    ...(options?.dupes !== undefined ? { dupes: options.dupes } : {}),
    onWake: (listener) => {
      wakeListener = listener;
      return () => {
        detachedWake = true;
      };
    },
  });
  return {
    doc,
    fake,
    mounted,
    wake: () => wakeListener?.(),
    unmount: () => {
      mounted.unmount();
      expect(detachedWake).toBe(true);
    },
  };
};

/** Boot settlement helper: every query terminal arrives via the stream. */
const settleBoot = async (fake: FakeTransport): Promise<void> => {
  await flush();
  for (const env of [...fake.sent]) {
    if (env.name === 'GetBootstrap') fake.apply(env.cid, BOOTSTRAP);
    if (env.name === 'PeekOpenTabs') fake.apply(env.cid, OPEN_TABS);
  }
  await flush();
};

const section = (doc: FakeDocument, name: string): FakeElement =>
  mustQuery(doc.body, `[data-section="${name}"]`);

describe('E4 guardian · boot', () => {
  it('renders the shell instantly, then asks for bootstrap + open tabs as guardian', async () => {
    const { doc, fake, unmount } = mount();
    expect(doc.body.querySelector('[data-surface="guardian"]')).not.toBeNull();
    expect(section(doc, 'open').textContent).toContain(copyOf('msg.state.loading'));
    await settleBoot(fake);
    const boot = fake.lastOf('GetBootstrap');
    expect(boot.kind).toBe('query');
    expect(boot.payload).toEqual({ surface: 'guardian' });
    expect(boot.senderContext).toBe('guardian');
    expect(boot.v).toBe(CONTRACT_V);
    expect(boot.contractHash.length).toBeGreaterThan(0);
    expect(fake.lastOf('PeekOpenTabs').payload).toEqual({});
    unmount();
  });

  it('after boot: heartbeat pill honest, missions render, chips from settings', async () => {
    const { doc, fake, unmount } = mount();
    await settleBoot(fake);
    expect(doc.body.textContent).toContain(copyOf('msg.heartbeat.safe', { count: 12 }));
    const missions = section(doc, 'missions');
    expect(missions.textContent).toContain('Reading week');
    expect(missions.textContent).toContain('Trip planning');
    expect(
      missions.querySelector('[data-mission-id="01HF7YAT001000000000000000"] .chip-favorite'),
    ).not.toBeNull();
    expect(missions.querySelectorAll('.mission-card')).toHaveLength(2);
    unmount();
  });

  it('open tabs group by window with park affordances (tab, window, all)', async () => {
    const { doc, fake, unmount } = mount();
    await settleBoot(fake);
    const open = section(doc, 'open');
    const windows = open.querySelectorAll('.window-block');
    expect(windows).toHaveLength(2);
    expect(windows[0]?.getAttribute('data-window-id')).toBe('1');
    expect(open.querySelectorAll('.tab-row')).toHaveLength(3);
    expect(open.querySelector('[data-action="park-window"]')).not.toBeNull();
    expect(open.querySelector('[data-action="park-all"]')).not.toBeNull();
    unmount();
  });

  it('boot failure shows an error block with retry that re-issues the query', async () => {
    const { doc, fake, unmount } = mount();
    await flush();
    const bootEnv = fake.lastOf('GetBootstrap');
    fake.fail(bootEnv.cid, { code: 'E_CAPABILITY', messageKey: 'msg.error.capability' });
    await flush();
    const banner = mustQuery(doc.body, '[data-slot="banner"]');
    expect(banner.querySelector('[role="alert"]')).not.toBeNull();
    expect(banner.textContent).toContain(copyOf('msg.error.capability'));
    const retriesBefore = fake.countOf('GetBootstrap');
    mustQuery(banner, '[data-action="retry"]').click();
    await settleBoot(fake);
    expect(fake.countOf('GetBootstrap')).toBe(retriesBefore + 1);
    expect(doc.body.textContent).toContain('Reading week');
    unmount();
  });

  it('first-run posture: empty library offers FirstRunIngest exactly once per boot', async () => {
    const { doc, fake, unmount } = mount();
    fake.respondWith(() => ({ outcome: 'ack' }));
    await flush();
    const bootEnv = fake.lastOf('GetBootstrap');
    fake.apply(bootEnv.cid, {
      missions: [],
      recentlyClosed: [],
      trashCount: 0,
      watermark: 0,
      settings: {},
      heartbeat: { keptCount: 0, liveRecoverable: 0, asOf: 0 },
    });
    const peekEnv = fake.lastOf('PeekOpenTabs');
    fake.apply(peekEnv.cid, OPEN_TABS);
    await flush();
    const card = mustQuery(doc.body, '[data-card="first-run"]');
    expect(card.textContent).toContain(copyOf('msg.hint.first-run'));
    mustQuery(card, '[data-action="first-run"]').click();
    await flush();
    const ingest = fake.lastOf('FirstRunIngest');
    expect(ingest.kind).toBe('command');
    expect(ingest.payload).toEqual({});
    expect(doc.body.querySelector('[data-card="first-run"]')).toBeNull();
    unmount();
  });
});

describe('E4 guardian · park interactions (R1 two-phase honesty)', () => {
  it('ParkTab rides the registry payload and shows a pending chip until Applied', async () => {
    const { doc, fake, unmount } = mount();
    await settleBoot(fake);
    const open = section(doc, 'open');
    const before = fake.countOf('PeekOpenTabs');
    mustQuery(open, '[data-tab-id="11"] [data-action="park-tab"]').click();
    await flush();
    const sent = fake.lastOf('ParkTab');
    expect(sent.kind).toBe('command');
    expect(sent.payload).toEqual({ browserTabId: 11 });
    // R1: ack arrived, no terminal yet — the pending chip is the honest state.
    const pending = section(doc, 'pending');
    expect(pending.querySelector(`[data-cid="${sent.cid}"]`)).not.toBeNull();
    expect(pending.textContent).toContain(copyOf('msg.state.pending'));
    fake.acknowledge(sent.cid, '01HF7YCG49W000000000000000');
    await flush();
    expect(mustQuery(pending, `[data-cid="${sent.cid}"]`).getAttribute('data-phase')).toBe(
      'acknowledged',
    );
    fake.apply(sent.cid, { kept: '01HF7YC8CTF000000000000000' });
    await flush();
    expect(pending.querySelector(`[data-cid="${sent.cid}"]`)).toBeNull();
    // Applied ⇒ open tabs are re-peeked (post-truth refresh, never optimistic).
    expect(fake.countOf('PeekOpenTabs')).toBeGreaterThan(before);
    unmount();
  });

  it('ParkGroup carries the group id only for real groups; ParkWindow its window', async () => {
    const { doc, fake, unmount } = mount();
    await settleBoot(fake);
    const open = section(doc, 'open');
    mustQuery(open, '[data-group-id="7"] [data-action="park-group"]').click();
    await flush();
    expect(fake.lastOf('ParkGroup').payload).toEqual({ groupId: 7 });
    mustQuery(open, '[data-window-id="1"] [data-action="park-window"]').click();
    await flush();
    expect(fake.lastOf('ParkWindow').payload).toEqual({ windowId: 1 });
    unmount();
  });

  it('ParkAll sends the empty payload (no window exclusion asked in v1)', async () => {
    const { doc, fake, unmount } = mount();
    await settleBoot(fake);
    mustQuery(section(doc, 'open'), '[data-action="park-all"]').click();
    await flush();
    expect(fake.lastOf('ParkAll').payload).toEqual({});
    unmount();
  });

  it('a failed command surfaces its error with a retry that re-sends it', async () => {
    const { doc, fake, unmount } = mount();
    await settleBoot(fake);
    mustQuery(section(doc, 'open'), '[data-tab-id="12"] [data-action="park-tab"]').click();
    await flush();
    const sent = fake.lastOf('ParkTab');
    fake.fail(sent.cid, { code: 'E_TAB_LOST', messageKey: 'msg.error.tab-gone' });
    await flush();
    const banner = mustQuery(doc.body, '[data-slot="banner"]');
    expect(banner.querySelector('[role="alert"]')).not.toBeNull();
    expect(banner.textContent).toContain(copyOf('msg.error.tab-gone'));
    const before = fake.countOf('ParkTab');
    mustQuery(banner, '[data-action="retry"]').click();
    await flush();
    expect(fake.countOf('ParkTab')).toBe(before + 1);
    unmount();
  });

  it('a rejected ack (validation failed SW-side) surfaces as an error too', async () => {
    const { doc, fake, unmount } = mount();
    await settleBoot(fake);
    fake.respondWith(() => ({
      outcome: 'rejected',
      error: {
        code: 'E_SCHEMA',
        messageKey: 'msg.error.schema',
        recoveryKey: 'msg.recover.report',
      },
    }));
    mustQuery(section(doc, 'open'), '[data-action="park-all"]').click();
    await flush();
    const banner = mustQuery(doc.body, '[data-slot="banner"]');
    expect(banner.querySelector('[role="alert"]')).not.toBeNull();
    unmount();
  });
});

describe('E4 guardian · missions & start', () => {
  it('resume is offered on parked missions and sends ResumeMission', async () => {
    const { doc, fake, unmount } = mount();
    await settleBoot(fake);
    const missions = section(doc, 'missions');
    const card = mustQuery(missions, '[data-mission-id="01HF7YAT001000000000000000"]');
    mustQuery(card, '[data-action="resume"]').click();
    await flush();
    expect(fake.lastOf('ResumeMission').payload).toEqual({
      missionId: '01HF7YAT001000000000000000',
      mode: 'full',
    });
    // Live missions do not offer resume.
    expect(
      mustQuery(missions, '[data-mission-id="01HF7YB1QFE000000000000000"]').querySelector(
        '[data-action="resume"]',
      ),
    ).toBeNull();
    unmount();
  });

  it('StartMission sends a trimmed name, or the empty payload when blank', async () => {
    const { doc, fake, unmount } = mount();
    await settleBoot(fake);
    const start = section(doc, 'start');
    const input = mustQuery(start, 'input[data-field="mission-name"]');
    input.value = '  Deep dive  ';
    mustQuery(start, '[data-action="start-mission"]').click();
    await flush();
    expect(fake.lastOf('StartMission').payload).toEqual({ name: 'Deep dive' });
    input.value = '';
    mustQuery(start, '[data-action="start-mission"]').click();
    await flush();
    expect(fake.lastOf('StartMission').payload).toEqual({});
    unmount();
  });
});

describe('E4 guardian · undo & keyboard', () => {
  it('the u key sends Undo and announces the undo label through the live region', async () => {
    const { doc, fake, unmount } = mount();
    await settleBoot(fake);
    fireKey(doc.body, { key: 'u' });
    await flush();
    const undo = fake.lastOf('Undo');
    expect(undo.kind).toBe('command');
    // msg.undo.archived is the audit E4-F1 label: emitted by the frozen Domain,
    // previously missing from the catalog (would have rendered the raw key).
    fake.apply(undo.cid, { undid: 'msg.undo.archived' });
    await flush();
    const live = mustQuery(doc.body, '[data-live-region]');
    expect(live.textContent).toBe(copyOf('msg.undo.archived'));
    expect(live.textContent).not.toContain('msg.undo.');
    unmount();
  });

  it('ctrl+z / meta+z also undo; typing in the name field never fires shortcuts', async () => {
    const { doc, fake, unmount } = mount();
    await settleBoot(fake);
    const beforeCount = fake.countOf('Undo');
    fireKey(doc.body, { key: 'z', ctrlKey: true });
    await flush();
    expect(fake.countOf('Undo')).toBe(beforeCount + 1);
    const start = section(doc, 'start');
    const input = mustQuery(start, 'input[data-field="mission-name"]');
    input.focus();
    fireKey(input, { key: 'u' }); // editable target: binding inert by law
    await flush();
    expect(fake.countOf('Undo')).toBe(beforeCount + 1);
    unmount();
  });

  it('the r key forces a snapshot refresh (reconnect-by-reread affordance)', async () => {
    const { doc, fake, unmount } = mount();
    await settleBoot(fake);
    fake.reset();
    fireKey(doc.body, { key: 'r' });
    await flush();
    expect(fake.sent.map((e) => e.name)).toEqual(['GetBootstrap', 'PeekOpenTabs']);
    unmount();
  });

  it('undo failure announces the fallible outcome (never silent)', async () => {
    const { doc, fake, unmount } = mount();
    await settleBoot(fake);
    fireKey(doc.body, { key: 'u' });
    await flush();
    fake.fail(fake.lastOf('Undo').cid, { code: 'E_CONFLICT', messageKey: 'msg.error.conflict' });
    await flush();
    expect(mustQuery(doc.body, '[data-live-region]').textContent).toBe(
      copyOf('msg.error.conflict'),
    );
    unmount();
  });
});

describe('E4 guardian · streams', () => {
  it('HeartbeatUpdate is the ONLY thing that moves the pill (post-Applied truth)', async () => {
    const { doc, fake, unmount } = mount();
    await settleBoot(fake);
    expect(doc.body.textContent).toContain(copyOf('msg.heartbeat.safe', { count: 12 }));
    // Parking ack does not move it.
    mustQuery(section(doc, 'open'), '[data-action="park-all"]').click();
    await flush();
    expect(doc.body.textContent).toContain(copyOf('msg.heartbeat.safe', { count: 12 }));
    fake.emitStream('HeartbeatUpdate', { keptCount: 40, liveRecoverable: 0, asOf: 1 });
    await flush();
    expect(doc.body.textContent).toContain(copyOf('msg.heartbeat.safe', { count: 40 }));
    expect(mustQuery(doc.body, '[data-live-region]').textContent).toContain(
      copyOf('msg.heartbeat.safe', { count: 40 }),
    );
    unmount();
  });

  it('a ViewDelta gap triggers a full rejoin (banner + fresh bootstrap + peek)', async () => {
    const { doc, fake, unmount } = mount();
    await settleBoot(fake);
    // Give the store a watermark so the incoming jump is provably a gap.
    fake.emitStream('ViewDelta', {
      view: 'missions',
      watermark: 1,
      ops: [
        {
          kind: 'upsert',
          key: '01HF7YBH6D8000000000000000',
          record: { missionId: '01HF7YBH6D8000000000000000', name: 'X', state: 'parked' },
        },
      ],
    });
    await flush();
    const bootsBefore = fake.countOf('GetBootstrap');
    const peeksBefore = fake.countOf('PeekOpenTabs');
    fake.emitStream('ViewDelta', { view: 'missions', watermark: 99, ops: [] });
    await flush();
    expect(mustQuery(doc.body, '[data-banner="resync"]').textContent).toContain(
      copyOf('msg.state.resync'),
    );
    await settleBoot(fake);
    expect(fake.countOf('GetBootstrap')).toBeGreaterThan(bootsBefore);
    expect(fake.countOf('PeekOpenTabs')).toBeGreaterThan(peeksBefore);
    expect(doc.body.textContent).toContain('Reading week'); // rejoin restored truth
    unmount();
  });

  it('an applied missions delta re-renders the mission grid without queries', async () => {
    const { doc, fake, unmount } = mount();
    await settleBoot(fake);
    fake.emitStream('ViewDelta', {
      view: 'missions',
      watermark: 1,
      ops: [
        {
          kind: 'upsert',
          key: '01HF7YB9EYV000000R00000000',
          record: {
            missionId: '01HF7YB9EYV000000R00000000',
            name: 'New arrival',
            state: 'parked',
            tabCount: 1,
          },
        },
      ],
    });
    await flush();
    expect(section(doc, 'missions').textContent).toContain('New arrival');
    unmount();
  });

  it('RecoveryAvailable renders the §14.4 strip: chip for clean-abnormal, card-line for loss-risk', async () => {
    const { doc, fake, unmount } = mount();
    await settleBoot(fake);
    fake.emitStream('RecoveryAvailable', {
      bootReportId: '01HF7YBRXWN000000000000000',
      severity: 'clean-abnormal',
    });
    await flush();
    const chip = mustQuery(doc.body, '[data-card="recovery"]');
    expect(chip.getAttribute('data-severity')).toBe('clean-abnormal');
    expect(chip.getAttribute('class')).toContain('recovery-chip');
    expect(chip.textContent).toContain(copyOf('msg.heartbeat.recovered'));
    fake.emitStream('RecoveryAvailable', {
      bootReportId: '01HF7YC0NB200R0R0000000000',
      severity: 'loss-risk',
    });
    await flush();
    const cardLine = mustQuery(doc.body, '[data-card="recovery"]');
    expect(cardLine.getAttribute('data-severity')).toBe('loss-risk');
    expect(cardLine.getAttribute('class')).toContain('recovery-card');
    expect(cardLine.textContent).toContain(copyOf('msg.heartbeat.recovered'));
    unmount();
  });

  it('ResyncRequired schema ⇒ honest error block only (never a silent partial)', async () => {
    const { doc, fake, unmount } = mount();
    await settleBoot(fake);
    const bootsBefore = fake.countOf('GetBootstrap');
    fake.emitStream('ResyncRequired', { reason: 'schema' });
    await flush();
    const banner = mustQuery(doc.body, '[data-slot="banner"]');
    expect(banner.querySelector('[role="alert"]')).not.toBeNull();
    expect(banner.textContent).toContain(copyOf('msg.error.output'));
    expect(banner.textContent).toContain(copyOf('msg.recover.report'));
    expect(fake.countOf('GetBootstrap')).toBe(bootsBefore); // banner only, no rejoin
    unmount();
  });

  it('ResyncRequired gap/death ⇒ the rejoin path runs', async () => {
    const { doc, fake, unmount } = mount();
    await settleBoot(fake);
    fake.emitStream('ResyncRequired', { reason: 'gap' });
    await flush();
    await settleBoot(fake);
    expect(mustQuery(doc.body, '[data-banner="resync"]')).not.toBeNull();
    unmount();
  });

  it('malformed stream payloads are ignored (never a crash in a listener)', async () => {
    const { doc, fake, unmount } = mount();
    await settleBoot(fake);
    fake.emitRaw({ v: CONTRACT_V, kind: 'stream', name: 'ViewDelta', payload: 'garbage' });
    fake.emitRaw({ v: CONTRACT_V, kind: 'stream', name: 'HeartbeatUpdate', payload: 42 });
    fake.emitRaw(null);
    await flush();
    expect(doc.body.querySelector('[data-surface="guardian"]')).not.toBeNull();
    unmount();
  });
});

describe('E4 guardian · reconnect & lifecycle', () => {
  it('wake re-reads bootstrap + open tabs (MV3 honest resume)', async () => {
    const { doc, fake, wake, unmount } = mount();
    await settleBoot(fake);
    fake.reset();
    wake();
    await flush();
    // The wake listener issued a fresh snapshot pair (stream death is unannounceable).
    expect(fake.sent.map((e) => e.name)).toEqual(['GetBootstrap', 'PeekOpenTabs']);
    await settleBoot(fake);
    expect(doc.body.textContent).toContain('Reading week');
    unmount();
  });

  it('unmount detaches streams, keys, wake and the root element', async () => {
    const { doc, fake, mounted } = mount();
    await settleBoot(fake);
    expect(fake.listenerCount()).toBe(1);
    const undosBefore = fake.countOf('Undo');
    mounted.unmount();
    expect(fake.listenerCount()).toBe(0);
    expect(doc.body.querySelector('[data-surface="guardian"]')).toBeNull();
    fireKey(doc.body, { key: 'u' }); // keys detached
    await flush();
    expect(doc.body.querySelector('[data-live-region]')).toBeNull(); // region disposed
    expect(fake.countOf('Undo')).toBe(undosBefore);
    fake.emitStream('HeartbeatUpdate', { keptCount: 99 }); // streams detached
    await flush();
    expect(doc.body.textContent).not.toContain(copyOf('msg.heartbeat.safe', { count: 99 }));
  });
});

describe('E8-T05 guardian · resumption briefs (Spec §6.9 · W5)', () => {
  const BRIEF: PendingBrief = {
    missionId: '01HF7YAT001000000000000000',
    missionName: 'Reading week',
    text: 'You left Reading week with 3 tabs across 2 domains. You stopped at Standup notes.',
    presentation: 'normal',
  };
  const SUGGESTED_BRIEF: PendingBrief = { ...BRIEF, presentation: 'suggested' };

  const cards = (doc: FakeDocument): readonly FakeElement[] =>
    section(doc, 'briefs').querySelectorAll('[data-widget="brief-card"]');

  it('W5-1: a gated brief renders ONE card at the window top, verbatim, with calm actions', async () => {
    const { doc, fake, unmount } = mount({ briefs: { pending: () => Promise.resolve([BRIEF]) } });
    await settleBoot(fake);
    await flush();
    const briefs = section(doc, 'briefs');
    expect(cards(doc)).toHaveLength(1);
    expect(briefs.textContent).toContain(BRIEF.text); // artifact truth, verbatim
    expect(briefs.textContent).toContain(copyOf('msg.brief.heading'));
    expect(briefs.querySelector('[data-action="resume-brief"]')).not.toBeNull();
    expect(briefs.querySelector('[data-action="dismiss-brief"]')).not.toBeNull();
    // Window top of the resumption area: the brief slot precedes the missions.
    const sections = doc.body
      .querySelectorAll('[data-section]')
      .map((n) => n.getAttribute('data-section'));
    expect(sections.indexOf('briefs')).toBeLessThan(sections.indexOf('missions'));
    unmount();
  });

  it('W5-2: resume rides the SAME ResumeMission command as the mission card (no second path)', async () => {
    const { doc, fake, unmount } = mount({
      briefs: { pending: () => Promise.resolve([BRIEF]) },
    });
    await settleBoot(fake);
    await flush();
    mustQuery(section(doc, 'briefs'), '[data-action="resume-brief"]').click();
    await flush();
    const sent = fake.lastOf('ResumeMission');
    expect(sent.kind).toBe('command');
    expect(sent.payload).toEqual({ missionId: BRIEF.missionId, mode: 'full' });
    unmount();
  });

  it('W5-3: dismiss is per-mission-forever within the mount — later seeds never resurface it', async () => {
    const dismissed: string[] = [];
    const { doc, fake, wake, unmount } = mount({
      briefs: {
        pending: () => Promise.resolve([BRIEF]),
        onDismiss: (missionId) => dismissed.push(missionId),
      },
    });
    await settleBoot(fake);
    await flush();
    mustQuery(section(doc, 'briefs'), '[data-action="dismiss-brief"]').click();
    await flush();
    expect(dismissed).toEqual([BRIEF.missionId]);
    expect(cards(doc)).toHaveLength(0);
    // A wake re-seeds the store (the brief is still "pending" upstream)…
    wake();
    await settleBoot(fake);
    await flush();
    expect(cards(doc)).toHaveLength(0); // …yet dismissal outranks every later seed
    unmount();
  });

  it('W5-4: shown-once is sticky — a later seed neither duplicates nor erases the card', async () => {
    const { doc, fake, wake, unmount } = mount({
      briefs: { pending: () => Promise.resolve([BRIEF]) },
    });
    await settleBoot(fake);
    await flush();
    expect(cards(doc)).toHaveLength(1);
    wake();
    await settleBoot(fake);
    await flush();
    expect(cards(doc)).toHaveLength(1); // exactly one, the SAME truth
    unmount();
  });

  it('W5-5: §6.11 affordance — the medium tier wears the suggested chip (word, never number)', async () => {
    const { doc, fake, unmount } = mount({
      briefs: { pending: () => Promise.resolve([SUGGESTED_BRIEF]) },
    });
    await settleBoot(fake);
    await flush();
    const card = cards(doc)[0];
    expect(card?.getAttribute('data-presentation')).toBe('suggested');
    expect(card?.querySelector('.chip-suggested')?.textContent).toContain(
      copyOf('msg.brief.suggested'),
    );
    unmount();
  });

  it('W5-6: absence-by-default — no seam renders nothing; a seam fault renders nothing new', async () => {
    const plain = mount();
    await settleBoot(plain.fake);
    await flush();
    expect(cards(plain.doc)).toHaveLength(0);
    plain.unmount();
    const faulty = mount({
      briefs: {
        pending: () => Promise.reject(new Error('wire down')),
        onDismiss: () => undefined,
      },
    });
    await settleBoot(faulty.fake);
    await flush();
    expect(cards(faulty.doc)).toHaveLength(0); // calm degrade, no banner
    expect(faulty.doc.body.querySelector('[role="alert"]')).toBeNull();
    faulty.unmount();
  });
});

describe('E8-T07 guardian · dupe strip (Spec "marks, does not close" · opt-in law)', () => {
  const GROUP = {
    canonHash: 'hash-a',
    title: 'Spec — Ledge docs',
    domain: 'docs.example',
    duplicateCount: 2,
    keepBrowserTabId: 42,
  };

  const rowOf = (doc: FakeDocument, hash: string): FakeElement =>
    mustQuery(section(doc, 'dupes'), `[data-canon-hash="${hash}"]`);

  it('D7-1: a group renders one honest row — title verbatim, "3 copies open", park count 2 — above the open section', async () => {
    const { doc, fake, unmount } = mount({
      dupes: { list: () => Promise.resolve([GROUP]), park: () => undefined },
    });
    await settleBoot(fake);
    await flush();
    const row = rowOf(doc, GROUP.canonHash);
    expect(row.textContent).toContain(GROUP.title);
    expect(row.textContent).toContain('3 copies open'); // candidates + the kept copy
    const parkBtn = mustQuery(row, '[data-action="park-dupes"]');
    expect(parkBtn.textContent).toContain('Park 2 older copies'); // exactly the candidates
    expect(mustQuery(row, '[data-action="ignore-dupe"]').textContent).toContain('Ignore');
    const sections = doc.body
      .querySelectorAll('[data-section]')
      .map((n) => n.getAttribute('data-section'));
    expect(sections.indexOf('dupes')).toBeGreaterThanOrEqual(0);
    expect(sections.indexOf('dupes')).toBeLessThan(sections.indexOf('open'));
    unmount();
  });

  it('D7-2 · CRITERION (opt-in law): ZERO park calls until the tap; after the tap exactly one (hash, keep) and a truth re-pull', async () => {
    const parkCalls: [string, number][] = [];
    let listCalls = 0;
    const { doc, fake, unmount } = mount({
      dupes: {
        list: () => {
          listCalls += 1;
          return Promise.resolve(parkCalls.length === 0 ? [GROUP] : []);
        },
        park: (hash, keep) => parkCalls.push([hash, keep]),
      },
    });
    await settleBoot(fake);
    await flush();
    expect(parkCalls).toHaveLength(0); // render never acts
    const listBefore = listCalls;
    mustQuery(rowOf(doc, GROUP.canonHash), '[data-action="park-dupes"]').click();
    await flush();
    expect(parkCalls).toEqual([[GROUP.canonHash, GROUP.keepBrowserTabId]]);
    expect(listCalls).toBe(listBefore + 1); // truth re-pull after the gesture
    expect(doc.body.querySelector('[data-widget="dupe-strip"]')).toBeNull(); // dissolved: list is empty now
    unmount();
  });

  it('D7-3: ignore is per-group memory — row removed on tap, dismiss recorded, nothing parked', async () => {
    const ignored: string[] = [];
    const parkCalls: [string, number][] = [];
    const { doc, fake, unmount } = mount({
      dupes: {
        list: () => Promise.resolve([GROUP]),
        park: (hash, keep) => parkCalls.push([hash, keep]),
        onIgnore: (hash) => ignored.push(hash),
      },
    });
    await settleBoot(fake);
    await flush();
    mustQuery(rowOf(doc, GROUP.canonHash), '[data-action="ignore-dupe"]').click();
    await flush();
    expect(ignored).toEqual([GROUP.canonHash]);
    expect(parkCalls).toHaveLength(0); // dismiss never closes anything
    expect(doc.body.querySelector(`[data-canon-hash="${GROUP.canonHash}"]`)).toBeNull();
    unmount();
  });

  it('D7-4: calm absence — no seam, empty groups, or a seam fault all render nothing', async () => {
    const plain = mount();
    await settleBoot(plain.fake);
    await flush();
    expect(plain.doc.body.querySelector('[data-widget="dupe-strip"]')).toBeNull();
    plain.unmount();
    const empty = mount({ dupes: { list: () => Promise.resolve([]), park: () => undefined } });
    await settleBoot(empty.fake);
    await flush();
    expect(empty.doc.body.querySelector('[data-widget="dupe-strip"]')).toBeNull();
    empty.unmount();
    const faulty = mount({
      dupes: { list: () => Promise.reject(new Error('wire down')), park: () => undefined },
    });
    await settleBoot(faulty.fake);
    await flush();
    expect(faulty.doc.body.querySelector('[data-widget="dupe-strip"]')).toBeNull();
    expect(faulty.doc.body.querySelector('[role="alert"]')).toBeNull(); // no tantrum
    faulty.unmount();
  });
});
