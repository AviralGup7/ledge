// E4 · Guardian surface suite — the park strip's behavior over the wire. Laws:
// boot renders shell instantly then loads via queries; every action is a registry
// command riding a frozen envelope; R1 pending strip between ack and Applied; no
// optimistic truth (heartbeat moves only on HeartbeatUpdate); stream gap ⇒ full
// rejoin; wake ⇒ snapshot re-read (MV3 reconnect); unmount detaches everything.
import { describe, expect, it } from 'vitest';
import { copyOf } from '@/surfaces/components/copy/copy.js';
import { mountGuardian, type Mounted } from '@/surfaces/guardian/guardian.js';
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
      missionId: 'm1',
      name: 'Reading week',
      namedBy: 'user',
      state: 'parked',
      concluded: false,
      createdAt: 1_700_000_000_000,
      lastActiveAt: 1_700_000_001_000,
      tabCount: 3,
    },
    {
      missionId: 'm2',
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
  settings: { 'favorite.mission.m1': true },
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
}): GuardianHarness => {
  const doc = new FakeDocument();
  const fake = createFakeTransport();
  fake.respondWith((env) => options?.ackResponder?.(env) ?? { outcome: 'ack' });
  let wakeListener: (() => void) | undefined;
  let detachedWake = false;
  const mounted = mountGuardian(asDocument(doc), {
    transport: fake.transport,
    entropy: createTestEntropy(),
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
    expect(missions.querySelector('[data-mission-id="m1"] .chip-favorite')).not.toBeNull();
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
    fake.acknowledge(sent.cid, 'intent-1');
    await flush();
    expect(mustQuery(pending, `[data-cid="${sent.cid}"]`).getAttribute('data-phase')).toBe(
      'acknowledged',
    );
    fake.apply(sent.cid, { kept: 'k1' });
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
    const card = mustQuery(missions, '[data-mission-id="m1"]');
    mustQuery(card, '[data-action="resume"]').click();
    await flush();
    expect(fake.lastOf('ResumeMission').payload).toEqual({ missionId: 'm1', mode: 'full' });
    // Live missions do not offer resume.
    expect(
      mustQuery(missions, '[data-mission-id="m2"]').querySelector('[data-action="resume"]'),
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
    fake.apply(undo.cid, { undid: 'msg.undo.restored' });
    await flush();
    const live = mustQuery(doc.body, '[data-live-region]');
    expect(live.textContent).toBe(copyOf('msg.undo.restored'));
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
      ops: [{ kind: 'upsert', key: 'm9', record: { missionId: 'm9', name: 'X', state: 'parked' } }],
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
          key: 'm3',
          record: { missionId: 'm3', name: 'New arrival', state: 'parked', tabCount: 1 },
        },
      ],
    });
    await flush();
    expect(section(doc, 'missions').textContent).toContain('New arrival');
    unmount();
  });

  it('RecoveryAvailable renders the recovery card with severity-driven copy', async () => {
    const { doc, fake, unmount } = mount();
    await settleBoot(fake);
    fake.emitStream('RecoveryAvailable', { bootReportId: 'b1', severity: 'clean-abnormal' });
    await flush();
    const card = mustQuery(doc.body, '[data-card="recovery"]');
    expect(card.getAttribute('data-severity')).toBe('clean-abnormal');
    expect(card.textContent).toContain(copyOf('msg.recovery.updated'));
    fake.emitStream('RecoveryAvailable', { bootReportId: 'b2', severity: 'loss-risk' });
    await flush();
    expect(mustQuery(doc.body, '[data-card="recovery"]').textContent).toContain(
      'Everything is safe',
    );
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
