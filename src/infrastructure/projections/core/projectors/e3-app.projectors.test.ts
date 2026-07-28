// E3-APP · Projector growth laws — tabs store truth (LIVE|KEPT|TRASH), mission
// lifecycle stamps (parked/trash/purged/concluded/resumed), R2 close-race finality,
// R1 kept-stamps-post-completion. Drives the V1 engine over a fresh memory store.
import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import {
  DEV_A,
  makeProjections,
  missionId,
  seedJournal,
  storeSnapshot,
  tabId,
  testId,
} from '../../testkit.js';

const WALL = 1_700_000_000_000;
const EVENT_ID_FIXTURE_BASE = 55_000;
const INTENT_ID_FIXTURE_BASE = 66_000;

const intentFixtureId = (n: number): string => testId(INTENT_ID_FIXTURE_BASE + n);

const ev = (seq: number, type: string, payload: Record<string, unknown>): EventEnvelope => ({
  eventId: testId(EVENT_ID_FIXTURE_BASE + seq) as EventEnvelope['eventId'],
  hlc: { seq, lamport: seq, deviceId: DEV_A, wallClock: WALL + seq },
  type,
  payload,
  producerContext: 'sw',
});

const observedEnv = (seq: number, tab: number): EventEnvelope =>
  ev(seq, 'TabObserved', {
    ledgeTabId: tabId(tab),
    browserTabId: 500 + tab,
    windowId: 42,
    url: `https://example.com/${String(tab)}`,
    urlCanon: `example.com/${String(tab)}`,
    canonRulesV: 1,
    title: `Tab ${String(tab)}`,
    domain: 'example.com',
    ts: WALL + seq,
  });

const rowOf = async (
  h: Awaited<ReturnType<typeof makeProjections>>,
  store: 'missions' | 'tabs',
  key: string,
) => {
  const rows = await storeSnapshot(h, store);
  return rows.find((r) => r['missionId'] === key || r['ledgeTabId'] === key);
};

describe('tabs store projector — lifecycle state law', () => {
  it('TabObserved forms LIVE rows; TabClosedExternal removes live rows only', async () => {
    const h = await makeProjections();
    await seedJournal(h, [observedEnv(1, 1)]);
    const applied = await h.projections.applyFromJournal(DEV_A);
    expect(applied.ok).toBe(true);
    const live = await rowOf(h, 'tabs', tabId(1));
    expect(live?.['state']).toBe('live');
    expect(live?.['title']).toBe('Tab 1');

    await seedJournal(h, [ev(2, 'TabClosedExternal', { ledgeTabId: tabId(1), closedAt: WALL })]);
    await h.projections.applyFromJournal(DEV_A);
    expect(await rowOf(h, 'tabs', tabId(1))).toBeUndefined();
    await h.engine.close();
  });

  it('park flow: assignment stamps KEPT only at completion; close-race keeps the row', async () => {
    const h = await makeProjections();
    const intent = intentFixtureId(1);
    await seedJournal(h, [
      observedEnv(1, 1),
      ev(2, 'MissionFormed', {
        missionId: missionId(1),
        name: 'parked-shell',
        namedBy: 'user',
        tabIds: [tabId(1)],
        provenance: 'park',
      }),
      ev(3, 'ParkIntentAccepted', {
        intentId: intent,
        scope: { missionId: missionId(1), tabIds: [tabId(1)], groupStyles: [], snapshotId: 's1' },
        issuedAt: 1,
      }),
    ]);
    await h.projections.applyFromJournal(DEV_A);
    // ack-band: membership true, state still LIVE (R1 — kept is post-Applied only).
    let tab = await rowOf(h, 'tabs', tabId(1));
    expect(tab?.['missionId']).toBe(missionId(1));
    expect(tab?.['state']).toBe('live');
    const mission = await rowOf(h, 'missions', missionId(1));
    expect(mission?.['state']).toBe('parked');
    expect(mission?.['parkIntentId']).toBe(intent);

    // Completion batch: per-tab assignment (the KEPT stamp) + the terminal marker.
    await seedJournal(h, [
      ev(4, 'TabAssigned', { tabId: tabId(1), missionId: missionId(1) }),
      ev(5, 'TabsParked', { intentId: intent, secured: 1 }),
    ]);
    await h.projections.applyFromJournal(DEV_A);
    tab = await rowOf(h, 'tabs', tabId(1));
    expect(tab?.['state']).toBe('kept');

    // §10-R2 race: the park-initiated chrome close lands LATE — the KEPT row survives.
    await seedJournal(h, [ev(6, 'TabClosedExternal', { ledgeTabId: tabId(1), closedAt: WALL })]);
    await h.projections.applyFromJournal(DEV_A);
    tab = await rowOf(h, 'tabs', tabId(1));
    expect(tab?.['state']).toBe('kept');
    await h.engine.close();
  });

  it('trash/restore/purge drives tab state TRASH→KEPT→gone', async () => {
    const h = await makeProjections();
    await seedJournal(h, [
      observedEnv(1, 1),
      ev(2, 'TabAssigned', { tabId: tabId(1), missionId: missionId(1) }),
    ]);
    await h.projections.applyFromJournal(DEV_A);
    await seedJournal(h, [
      ev(3, 'EntityTrashed', {
        kind: 'tab',
        id: tabId(1),
        inverseAtom: { kind: 'restore-tab', payload: {}, label: 'msg.undo.trashed-tab' },
        deletedAt: 9,
      }),
    ]);
    await h.projections.applyFromJournal(DEV_A);
    let tab = await rowOf(h, 'tabs', tabId(1));
    expect(tab?.['state']).toBe('trash');
    expect(tab?.['deletedAt']).toBe(9);

    await seedJournal(h, [
      ev(4, 'TrashRestored', { kind: 'tab', id: tabId(1), resolvedMissionId: missionId(2) }),
    ]);
    await h.projections.applyFromJournal(DEV_A);
    tab = await rowOf(h, 'tabs', tabId(1));
    expect(tab?.['state']).toBe('kept');
    expect(tab?.['missionId']).toBe(missionId(2));
    expect(tab?.['deletedAt']).toBeNull();

    await seedJournal(h, [
      ev(5, 'EntityTrashed', {
        kind: 'tab',
        id: tabId(1),
        inverseAtom: { kind: 'restore-tab', payload: {}, label: 'msg.undo.trashed-tab' },
        deletedAt: 10,
      }),
      ev(6, 'TrashPurged', { kind: 'tab', id: tabId(1), purgedAt: 11, purgeEpoch: 3 }),
    ]);
    await h.projections.applyFromJournal(DEV_A);
    expect(await rowOf(h, 'tabs', tabId(1))).toBeUndefined();
    await h.engine.close();
  });
});

describe('missions view growth — lifecycle stamps', () => {
  it('trash/restore stamps state; purge removes the row; conclude sets the flag', async () => {
    const h = await makeProjections();
    await seedJournal(h, [
      ev(1, 'MissionFormed', {
        missionId: missionId(1),
        name: 'one',
        namedBy: 'user',
        tabIds: [],
      }),
    ]);
    await h.projections.applyFromJournal(DEV_A);

    await seedJournal(h, [
      ev(2, 'EntityTrashed', {
        kind: 'mission',
        id: missionId(1),
        inverseAtom: { kind: 'restore-mission', payload: {}, label: 'msg.undo.trashed-mission' },
        deletedAt: 7,
      }),
    ]);
    await h.projections.applyFromJournal(DEV_A);
    let mission = await rowOf(h, 'missions', missionId(1));
    expect(mission?.['state']).toBe('trash');
    expect(mission?.['deletedAt']).toBe(7);

    await seedJournal(h, [
      ev(3, 'TrashRestored', {
        kind: 'mission',
        id: missionId(1),
        resolvedMissionId: missionId(1),
      }),
    ]);
    await h.projections.applyFromJournal(DEV_A);
    mission = await rowOf(h, 'missions', missionId(1));
    expect(mission?.['state']).toBe('live');
    expect(mission?.['deletedAt']).toBeNull();

    await seedJournal(h, [
      ev(4, 'MissionConcluded', { missionId: missionId(1), outcomeNote: 'done' }),
      ev(5, 'MissionArchived', { missionId: missionId(1) }),
      ev(6, 'EntityTrashed', {
        kind: 'mission',
        id: missionId(1),
        inverseAtom: { kind: 'restore-mission', payload: {}, label: 'msg.undo.trashed-mission' },
        deletedAt: 8,
      }),
      ev(7, 'TrashPurged', { kind: 'mission', id: missionId(1), purgedAt: 9, purgeEpoch: 1 }),
    ]);
    await h.projections.applyFromJournal(DEV_A);
    expect(await rowOf(h, 'missions', missionId(1))).toBeUndefined();
    await h.engine.close();
  });

  it('MissionResumed re-opens with the mapped window binding (§6.5 state=OPEN)', async () => {
    const h = await makeProjections();
    await seedJournal(h, [
      ev(1, 'MissionFormed', {
        missionId: missionId(1),
        name: 'one',
        namedBy: 'user',
        tabIds: [tabId(1)],
      }),
      ev(2, 'ParkIntentAccepted', {
        intentId: intentFixtureId(2),
        scope: { missionId: missionId(1), tabIds: [tabId(1)], groupStyles: [], snapshotId: 's1' },
        issuedAt: 1,
      }),
    ]);
    await h.projections.applyFromJournal(DEV_A);
    expect((await rowOf(h, 'missions', missionId(1)))?.['state']).toBe('parked');

    await seedJournal(h, [
      ev(3, 'MissionResumed', {
        missionId: missionId(1),
        mode: 'full',
        restoredMapping: { windowId: 77, tabs: [{ tabId: tabId(1), browserTabId: 900 }] },
      }),
    ]);
    await h.projections.applyFromJournal(DEV_A);
    const mission = await rowOf(h, 'missions', missionId(1));
    expect(mission?.['state']).toBe('live');
    expect(mission?.['windowBinding']).toBe(77);
    expect(mission?.['parkIntentId']).toBeNull();

    await seedJournal(h, [
      ev(4, 'WindowClosedExternal', { windowId: 77, missionId: missionId(1), closedAt: WALL }),
    ]);
    await h.projections.applyFromJournal(DEV_A);
    expect((await rowOf(h, 'missions', missionId(1)))?.['windowBinding']).toBeNull();
    await h.engine.close();
  });

  it('first-run formation assigns membership WITHOUT a kept stamp (tabs stay LIVE)', async () => {
    const h = await makeProjections();
    await seedJournal(h, [
      observedEnv(1, 1),
      ev(2, 'MissionFormed', {
        missionId: missionId(1),
        name: 'example.com',
        namedBy: 'system',
        tabIds: [tabId(1)],
        provenance: 'first-run',
      }),
    ]);
    await h.projections.applyFromJournal(DEV_A);
    const tab = await rowOf(h, 'tabs', tabId(1));
    expect(tab?.['missionId']).toBe(missionId(1));
    expect(tab?.['state']).toBe('live');
    await h.engine.close();
  });

  it('E8-T10 · MissionConcluded persists the outcome note (W12 memory material; note-less re-conclude preserves)', async () => {
    const h = await makeProjections();
    await seedJournal(h, [
      ev(1, 'MissionFormed', {
        missionId: missionId(1),
        name: 'one',
        namedBy: 'user',
        tabIds: [],
      }),
    ]);
    await h.projections.applyFromJournal(DEV_A);
    // Noted conclude: the note lands WITH the flag in the same patch.
    await seedJournal(h, [
      ev(2, 'MissionConcluded', { missionId: missionId(1), outcomeNote: 'chose Acme' }),
      ev(3, 'MissionArchived', { missionId: missionId(1) }),
    ]);
    await h.projections.applyFromJournal(DEV_A);
    let mission = await rowOf(h, 'missions', missionId(1));
    expect(mission?.['concluded']).toBe(true);
    expect(mission?.['outcomeNote']).toBe('chose Acme');
    // Note-LESS re-conclude: no note key ⇒ the prior note survives (a
    // re-conclude is not a wipe; correction always arrives WITH a note).
    await seedJournal(h, [ev(4, 'MissionConcluded', { missionId: missionId(1) })]);
    await h.projections.applyFromJournal(DEV_A);
    mission = await rowOf(h, 'missions', missionId(1));
    expect(mission?.['outcomeNote']).toBe('chose Acme');
    // Corrected conclude: a NEW note replaces, verbatim.
    await seedJournal(h, [
      ev(5, 'MissionConcluded', {
        missionId: missionId(1),
        outcomeNote: 'chose Acme — reasons noted',
      }),
    ]);
    await h.projections.applyFromJournal(DEV_A);
    mission = await rowOf(h, 'missions', missionId(1));
    expect(mission?.['outcomeNote']).toBe('chose Acme — reasons noted');
    await h.engine.close();
  });
});
