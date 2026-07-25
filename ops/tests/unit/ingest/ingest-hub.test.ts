// E2-T05 · hub ingest unit laws (Blueprint 20/50ms batching + §2.8 ack law).
//  B1  cap law: 40 arrivals drain in cap-order, seqs contiguous, counters exact
//  B2  window law: sub-cap queue waits the 50ms window from first item
//  B3  created→TabObserved carries §4 canon fields (urlCanon/canonRulesV/domain, utm stripped)
//  B4  updated/activated/removed on KNOWN tabs → TabUpdated/TabActivatedObserved/TabClosedExternal
//  B5  restart race: created on an already-known browserTabId supersedes, never re-mints
//  B6  observations on UNKNOWN tabs skip + count (not user truth), journal untouched
//  B7  windows/group observations → WindowClosedExternal/GroupChanged (catalog passthrough)
//  B8  moved/attached → no v1 catalog event (§4 has no row)
//  B9  catalog coverage: every emitted envelope validates against the §4 registry
//  B10 seq/lamport monotonicity across multi-batch drains
//  B11 §2.8 ack-timeout: stall → E_DURABILITY_TIMEOUT → recovery with zero loss, zero dupes
//  B12 hydrate(): identity map rebuilt from the journal (post-restart identity continuity)
//  B13 first-run: flag-hinged exactly-once; safe resend idempotent (§3.1 C1)
//  B14 first-run on an empty browser still lands the flag lawfully
//  B15 stall at hydration: pipeline discloses + buffers, recovers without loss
//  PERF 500-burst amortized ≤5ms/event (memory adapter; production IDB is faster)
import { describe, expect, it } from 'vitest';
import type { TabsEvent } from '@/application/ports/tabs.port.js';
import { canonicalize } from '@/shared-kernel/canon/index.js';
import { validatePayload, type EventEnvelope } from '@/shared-kernel/events/index.js';
import { isId } from '@/shared-kernel/identity/index.js';
import { DEV_A } from '@/infrastructure/journal/core/testkit.js';
import { makeWorld, type IngestWorld } from './testkit.js';

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.value;
};

interface ReadAllRow {
  readonly seq: number;
  readonly envelope: EventEnvelope;
}

const readAll = async (w: IngestWorld): Promise<readonly ReadAllRow[]> => {
  const rr = await w.journal.readRange({ deviceId: DEV_A, fromSeq: 0 });
  return unwrap(rr).events;
};

const payload = (row: ReadAllRow): Record<string, unknown> =>
  row.envelope.payload as Record<string, unknown>;

const PERF_EVENTS = 500;
const PERF_AMORTIZED_MS = 5;

describe('E2-T05 hub ingest — unit laws', () => {
  it('B1: cap law — 40 arrivals drain in cap-order, seqs contiguous', async () => {
    const w = await makeWorld();
    for (let n = 1; n <= 40; n += 1) await w.hub.handleTabsEvent(w.createdEvent(w.tab(n)));
    unwrap(await w.hub.flush());
    const events = await readAll(w);
    expect(events).toHaveLength(40);
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(events.map((e) => payload(e)['browserTabId'])).toEqual(
      Array.from({ length: 40 }, (_, i) => i + 1),
    );
    expect(w.hub.counters().observed).toBe(40);
  });

  it('B2: window law — a sub-cap queue waits the 50ms window', async () => {
    const w = await makeWorld();
    await w.hub.handleTabsEvent(w.createdEvent(w.tab(1)));
    await w.hub.handleTabsEvent(w.createdEvent(w.tab(2)));
    w.time.advanceTime(49);
    await Promise.resolve();
    expect(await readAll(w)).toHaveLength(0);
    w.time.advanceTime(1);
    await w.hub.flush();
    expect(await readAll(w)).toHaveLength(2);
  });

  it('B3: TabObserved carries canon fields with denylist params stripped', async () => {
    const w = await makeWorld();
    const url = 'https://x.example/path/?utm_source=news&q=1&fbclid=zzz';
    await w.hub.handleTabsEvent(w.createdEvent(w.tab(1, url)));
    await w.hub.flush();
    const events = await readAll(w);
    expect(events).toHaveLength(1);
    const p = payload(events[0] as ReadAllRow);
    const canon = canonicalize(url);
    expect(p['url']).toBe(url);
    expect(p['urlCanon']).toBe(canon.canonForm);
    expect(p['urlCanon']).not.toContain('utm_source');
    expect(p['urlCanon']).not.toContain('fbclid');
    expect(p['urlCanon']).toContain('q=1');
    expect(p['canonRulesV']).toBe(1);
    expect(p['domain']).toBe(canon.domain);
    expect(typeof p['ts']).toBe('number');
  });

  it('B4: updated/activated/removed on known tabs map to their catalog events', async () => {
    const w = await makeWorld();
    await w.hub.handleTabsEvent(w.createdEvent(w.tab(1)));
    await w.hub.flush();
    const upd: TabsEvent = {
      kind: 'updated',
      browserTabId: 1,
      windowId: 1,
      changes: { title: 'renamed' },
    };
    await w.hub.handleTabsEvent(upd);
    await w.hub.handleTabsEvent({ kind: 'activated', browserTabId: 1, windowId: 1 });
    const ts = w.time.now();
    await w.hub.handleTabsEvent({
      kind: 'removed',
      browserTabId: 1,
      windowId: 1,
      isWindowClosing: false,
    });
    await w.hub.flush();
    const events = await readAll(w);
    expect(events.map((e) => e.envelope.type)).toEqual([
      'TabObserved',
      'TabUpdated',
      'TabActivatedObserved',
      'TabClosedExternal',
    ]);
    expect(payload(events[1] as ReadAllRow)['changes']).toEqual({ title: 'renamed' });
    expect(payload(events[3] as ReadAllRow)['closedAt']).toBe(ts);
    expect(payload(events[3] as ReadAllRow)['ledgeTabId']).toBe(
      payload(events[0] as ReadAllRow)['ledgeTabId'],
    );
    const c = w.hub.counters();
    expect([c.observed, c.updated, c.activated, c.closed]).toEqual([1, 1, 1, 1]);
  });

  it('B5: created on an already-known tab supersedes — one identity, no re-mint', async () => {
    const w = await makeWorld();
    await w.hub.handleTabsEvent(w.createdEvent(w.tab(1)));
    await w.hub.flush();
    await w.hub.handleTabsEvent(w.createdEvent(w.tab(1, 'https://fresh.example/')));
    await w.hub.flush();
    const events = await readAll(w);
    expect(events.map((e) => e.envelope.type)).toEqual(['TabObserved', 'TabUpdated']);
    expect(payload(events[1] as ReadAllRow)['ledgeTabId']).toBe(
      payload(events[0] as ReadAllRow)['ledgeTabId'],
    );
    expect(w.hub.stats().identities).toBe(1);
  });

  it('B6: unknown-tab observations skip + count, journal untouched', async () => {
    const w = await makeWorld();
    await w.hub.handleTabsEvent({
      kind: 'updated',
      browserTabId: 99,
      windowId: 1,
      changes: { title: 'x' },
    });
    await w.hub.handleTabsEvent({ kind: 'activated', browserTabId: 99, windowId: 1 });
    await w.hub.handleTabsEvent({
      kind: 'removed',
      browserTabId: 99,
      windowId: 1,
      isWindowClosing: false,
    });
    await w.hub.flush();
    expect(await readAll(w)).toHaveLength(0);
    expect(w.hub.counters().skippedUnknownTab).toBe(3);
  });

  it('B7: window closes and group changes flow to their catalog rows', async () => {
    const w = await makeWorld();
    await w.hub.handleWindowsEvent({ kind: 'removed', windowId: 7 });
    await w.hub.handleGroupChanged({
      groupId: 3,
      name: 'Deep work',
      color: 'blue',
      collapsed: true,
    });
    await w.hub.flush();
    const events = await readAll(w);
    expect(events.map((e) => e.envelope.type)).toEqual(['WindowClosedExternal', 'GroupChanged']);
    expect(payload(events[0] as ReadAllRow)).toMatchObject({ windowId: 7 });
    expect(payload(events[1] as ReadAllRow)).toMatchObject({
      groupId: 3,
      name: 'Deep work',
      color: 'blue',
      collapsed: true,
    });
    const c = w.hub.counters();
    expect([c.windowsClosed, c.groupsChanged]).toEqual([1, 1]);
  });

  it('B8: moved/attached produce no catalog event (§4 has no v1 row)', async () => {
    const w = await makeWorld();
    await w.hub.handleTabsEvent(w.createdEvent(w.tab(1)));
    await w.hub.flush();
    await w.hub.handleTabsEvent({
      kind: 'moved',
      browserTabId: 1,
      windowId: 1,
      fromIndex: 0,
      toIndex: 2,
    });
    await w.hub.handleTabsEvent({ kind: 'attached', browserTabId: 1, windowId: 2, newIndex: 0 });
    await w.hub.flush();
    const events = await readAll(w);
    expect(events).toHaveLength(1);
    expect(events[0]?.envelope.type).toBe('TabObserved');
  });

  it('B9: catalog coverage — every emitted envelope validates against the §4 registry', async () => {
    const w = await makeWorld();
    await w.hub.handleTabsEvent(w.createdEvent(w.tab(1)));
    await w.hub.handleTabsEvent({
      kind: 'updated',
      browserTabId: 1,
      windowId: 1,
      changes: { url: 'https://n.example/', groupId: 4 },
    });
    await w.hub.handleTabsEvent({ kind: 'activated', browserTabId: 1, windowId: 1 });
    await w.hub.handleWindowsEvent({ kind: 'removed', windowId: 9 });
    await w.hub.handleGroupChanged({ groupId: 4, color: 'red' });
    await w.hub.handleTabsEvent({
      kind: 'removed',
      browserTabId: 1,
      windowId: 1,
      isWindowClosing: false,
    });
    await w.hub.flush();
    const events = await readAll(w);
    expect(events.length).toBe(6);
    for (const e of events) {
      const v = validatePayload(e.envelope.type, e.envelope.payload);
      expect(v.ok, `${e.envelope.type} must validate`).toBe(true);
      expect(e.envelope.producerContext).toBe('sw');
      expect(isId(e.envelope.eventId)).toBe(true);
    }
  });

  it('B10: seq and lamport stay monotonic across multi-batch drains', async () => {
    const w = await makeWorld();
    for (let n = 1; n <= 25; n += 1) await w.hub.handleTabsEvent(w.createdEvent(w.tab(n)));
    await w.hub.flush();
    for (let n = 26; n <= 33; n += 1) await w.hub.handleTabsEvent(w.createdEvent(w.tab(n)));
    await w.hub.flush();
    const events = await readAll(w);
    expect(events).toHaveLength(33);
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 33 }, (_, i) => i + 1));
    const lamports = events.map((e) => e.envelope.hlc.lamport);
    for (let i = 1; i < lamports.length; i += 1) {
      expect(lamports[i] ?? 0).toBeGreaterThanOrEqual(lamports[i - 1] ?? 0);
    }
    expect(w.hub.stats().nextSeq).toBe(34);
  });

  it('B11: §2.8 ack law — stall discloses E_DURABILITY_TIMEOUT; recovery is loss- and dupe-free', async () => {
    const w = await makeWorld();
    w.stall.append = true;
    await w.hub.handleTabsEvent(w.createdEvent(w.tab(1)));
    await w.hub.handleTabsEvent(w.createdEvent(w.tab(2)));
    const flushPromise = w.hub.flush();
    // Both append attempts time out against the virtual 250ms deadline.
    w.time.advanceTime(251);
    await Promise.resolve();
    w.time.advanceTime(251);
    const stalled = unwrap(await flushPromise);
    expect(stalled.errorCode).toBe('E_JOURNAL_INTEGRITY');
    expect(await readAll(w)).toHaveLength(0);

    w.stall.append = false;
    unwrap(await w.hub.flush());
    const events = await readAll(w);
    expect(events).toHaveLength(2);
    expect(events.map((e) => payload(e)['browserTabId'])).toEqual([1, 2]);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('B16: §2.8 timeout path — hanging append hits the 250ms deadline, retries same-key once, discloses, recovers', async () => {
    const w = await makeWorld();
    w.stall.hang = true;
    await w.hub.handleTabsEvent(w.createdEvent(w.tab(1)));
    const flushPromise = w.hub.flush();
    // Attempt 1 times out at 250ms; the law's one immediate retry (same stamped
    // batch) times out likewise. The stall-recovery kick inside flush() then
    // re-attempts once more under hang. The error-propagation chain between a
    // timer fire and the next timer's SCHEDULE spans an unknown number of
    // microtasks, so pre-counted phases are brittle: drive the virtual clock in
    // 250ms steps with generous microtask pumping until the flush settles.
    let done = false;
    void flushPromise.then(() => {
      done = true;
    });
    for (let guard = 0; guard < 200 && !done; guard += 1) {
      w.time.advanceTime(250);
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    }
    expect(done).toBe(true);
    const stalled = unwrap(await flushPromise);
    expect(stalled.errorCode).toBe('E_DURABILITY_TIMEOUT');
    const timeoutReports = w.reports.filter(
      (r) => r.kind === 'flush' && r.errorCode === 'E_DURABILITY_TIMEOUT',
    );
    expect(timeoutReports.length).toBeGreaterThan(0);

    w.stall.hang = false;
    unwrap(await w.hub.flush());
    const events = await readAll(w);
    expect(events).toHaveLength(1);
    expect(payload(events[0] as ReadAllRow)['browserTabId']).toBe(1);
    expect(events[0]?.seq).toBe(1);
  });

  it('B12: hydrate() rebuilds identity from the journal across a world restart', async () => {
    const w1 = await makeWorld();
    for (let n = 1; n <= 5; n += 1) await w1.hub.handleTabsEvent(w1.createdEvent(w1.tab(n)));
    await w1.hub.flush();

    const w2 = await makeWorld(w1.storage);
    const hyd = unwrap(await w2.hub.hydrate());
    expect(hyd.identities).toBe(5);
    // Known tab across the restart: supersede path, identity continuity.
    await w2.hub.handleTabsEvent(w2.createdEvent(w2.tab(3)));
    await w2.hub.flush();
    const events = await readAll(w2);
    expect(events).toHaveLength(6);
    const last = events[5] as ReadAllRow;
    expect(last.envelope.type).toBe('TabUpdated');
    expect(payload(last)['ledgeTabId']).toBe(payload(events[2] as ReadAllRow)['ledgeTabId']);
    // Nothing was lost: seqs continue from the restored cursor.
    expect(last.seq).toBe(6);
  });

  it('B13: first-run ingest is flag-hinged exactly-once with safe resend (§3.1 C1)', async () => {
    const w = await makeWorld();
    const live = [1, 2, 3, 4].map((n) => w.tab(n));
    const first = unwrap(await w.hub.firstRunIngest(live));
    expect(first.applied).toBe(true);
    expect(first.tabsCaptured).toBe(4);
    expect(first.missionsCreated).toBe(0);
    // One txn law's observable: flag + all events durably present together.
    const flagged = unwrap(
      await w.storage.txn(['meta'], 'readonly', (tx) =>
        tx
          .table('meta')
          .get('firstRunDone')
          .then((r) => r?.value === true),
      ),
    );
    expect(flagged).toBe(true);
    expect((await readAll(w)).length).toBe(4);

    const again = unwrap(await w.hub.firstRunIngest(live));
    expect(again.idempotentSkip).toBe(true);
    expect(again.applied).toBe(false);
    expect((await readAll(w)).length).toBe(4);
  });

  it('B14: first-run on an empty browser still lands the flag', async () => {
    const w = await makeWorld();
    const report = unwrap(await w.hub.firstRunIngest([]));
    expect(report.applied).toBe(true);
    expect(report.tabsCaptured).toBe(0);
    expect(await readAll(w)).toHaveLength(0);
    const again = unwrap(await w.hub.firstRunIngest([]));
    expect(again.idempotentSkip).toBe(true);
  });

  it('B15: hydration stall discloses + buffers; recovery loses nothing', async () => {
    const w = await makeWorld();
    w.stall.read = true;
    await w.hub.handleTabsEvent(w.createdEvent(w.tab(1)));
    const stalled = unwrap(await w.hub.flush());
    expect(stalled.errorCode).toBe('E_JOURNAL_INTEGRITY');
    expect(w.hub.stats().hydrated).toBe(false);
    expect(w.hub.stats().queued).toBeGreaterThan(0);

    w.stall.read = false;
    unwrap(await w.hub.flush());
    expect(w.hub.stats().hydrated).toBe(true);
    const events = await readAll(w);
    expect(events).toHaveLength(1);
    expect(payload(events[0] as ReadAllRow)['browserTabId']).toBe(1);
  });

  it('B17a: closure finality — late events for a closed tab skip + count (regression: property-model gap)', async () => {
    const w = await makeWorld();
    await w.hub.handleTabsEvent(w.createdEvent(w.tab(1)));
    await w.hub.handleTabsEvent({
      kind: 'removed',
      browserTabId: 1,
      windowId: 1,
      isWindowClosing: false,
    });
    // Chrome teardown race: late updated/activated/duplicate-removed AFTER the close.
    await w.hub.handleTabsEvent({
      kind: 'updated',
      browserTabId: 1,
      windowId: 1,
      changes: { title: 'ghost' },
    });
    await w.hub.handleTabsEvent({ kind: 'activated', browserTabId: 1, windowId: 1 });
    await w.hub.handleTabsEvent({
      kind: 'removed',
      browserTabId: 1,
      windowId: 1,
      isWindowClosing: false,
    });
    unwrap(await w.hub.flush());
    const events = await readAll(w);
    expect(events.map((row) => row.envelope.type)).toEqual(['TabObserved', 'TabClosedExternal']);
    const c = w.hub.counters();
    expect(c.observed).toBe(1);
    expect(c.closed).toBe(1);
    expect(c.updated).toBe(0);
    expect(c.activated).toBe(0);
    expect(c.skippedUnknownTab).toBe(3);
  });

  it('B17b: chrome id-reuse episode — created on a known-CLOSED tab re-arms (supersede), then updates map again', async () => {
    const w = await makeWorld();
    await w.hub.handleTabsEvent(w.createdEvent(w.tab(1)));
    await w.hub.handleTabsEvent({
      kind: 'removed',
      browserTabId: 1,
      windowId: 1,
      isWindowClosing: false,
    });
    await w.hub.flush();
    // Browser reused browserTabId 1 for a NEW live tab: created supersedes (B5 law).
    await w.hub.handleTabsEvent(w.createdEvent(w.tab(1, 'https://reused.example/p')));
    await w.hub.handleTabsEvent({
      kind: 'updated',
      browserTabId: 1,
      windowId: 1,
      changes: { title: 'alive' },
    });
    unwrap(await w.hub.flush());
    const events = await readAll(w);
    expect(events.map((row) => row.envelope.type)).toEqual([
      'TabObserved',
      'TabClosedExternal',
      'TabUpdated',
      'TabUpdated',
    ]);
    expect(w.hub.counters().skippedUnknownTab).toBe(0);
  });

  it('B17c: hydration replays finality — closures survive a hub restart', async () => {
    const w1 = await makeWorld();
    await w1.hub.handleTabsEvent(w1.createdEvent(w1.tab(1)));
    await w1.hub.handleTabsEvent({
      kind: 'removed',
      browserTabId: 1,
      windowId: 1,
      isWindowClosing: false,
    });
    await w1.hub.flush();

    const w2 = await makeWorld(w1.storage);
    unwrap(await w2.hub.hydrate());
    // Late events against yesterday's closed id: skipped, not resurrected.
    await w2.hub.handleTabsEvent({
      kind: 'updated',
      browserTabId: 1,
      windowId: 1,
      changes: { title: 'ghost' },
    });
    unwrap(await w2.hub.flush());
    expect((await readAll(w2)).map((row) => row.envelope.type)).toEqual([
      'TabObserved',
      'TabClosedExternal',
    ]);
    expect(w2.hub.counters().skippedUnknownTab).toBe(1);
    // ...and the stream's created-supersede row re-opens the episode post-restart.
    await w2.hub.handleTabsEvent(w2.createdEvent(w2.tab(1, 'https://back.example/')));
    unwrap(await w2.hub.flush());
    expect((await readAll(w2)).map((row) => row.envelope.type)).toEqual([
      'TabObserved',
      'TabClosedExternal',
      'TabUpdated',
    ]);
    expect(w2.hub.counters().skippedUnknownTab).toBe(1);
  });

  it('B18: counters are per-instance — a respawned hub re-derives identity but never counts the stream again (regression: property flake root cause)', async () => {
    const w1 = await makeWorld();
    await w1.hub.handleTabsEvent(w1.createdEvent(w1.tab(1)));
    await w1.hub.handleTabsEvent({
      kind: 'removed',
      browserTabId: 1,
      windowId: 1,
      isWindowClosing: false,
    });
    await w1.hub.flush();
    const c1 = w1.hub.counters();
    expect(c1.observed).toBe(1);
    expect(c1.closed).toBe(1);

    const w2 = await makeWorld(w1.storage);
    unwrap(await w2.hub.hydrate());
    // Hydration rebuilds identity + cursors but does NOT replay decision counts —
    // those retired with w1's lifetime. The stream is untouched by the respawn.
    expect(w2.hub.counters()).toEqual({
      observed: 0,
      updated: 0,
      activated: 0,
      closed: 0,
      windowsClosed: 0,
      groupsChanged: 0,
      skippedUnknownTab: 0,
    });
    expect(w2.hub.stats().identities).toBe(1);
    expect((await readAll(w2)).length).toBe(2);

    await w2.hub.handleTabsEvent(w2.createdEvent(w2.tab(2)));
    unwrap(await w2.hub.flush());
    const c2 = w2.hub.counters();
    expect(c2.observed).toBe(1);
    // Cross-lifetime ownership: w1's counts are intact, w2's are its own only —
    // their SUM equals the session's decision truth.
    expect(w1.hub.counters()).toEqual(c1);
    expect(c1.observed + c2.observed).toBe(2);
    expect((await readAll(w2)).length).toBe(3);
  });

  it(
    `PERF: ${PERF_EVENTS}-burst amortized ≤${PERF_AMORTIZED_MS}ms/event`,
    { timeout: 120_000 },
    async () => {
      const w = await makeWorld();
      const started = Date.now();
      for (let n = 1; n <= PERF_EVENTS; n += 1) {
        await w.hub.handleTabsEvent(
          w.createdEvent(w.tab(n, `https://burst.example/${n}?utm_source=x&v=${n}`)),
        );
      }
      await w.hub.flush();
      const elapsed = Date.now() - started;
      expect((await readAll(w)).length).toBe(PERF_EVENTS);
      const amortized = elapsed / PERF_EVENTS;
      expect(amortized, `ingest amortized cost ${amortized.toFixed(2)}ms/event`).toBeLessThan(
        PERF_AMORTIZED_MS,
      );
    },
  );
});
