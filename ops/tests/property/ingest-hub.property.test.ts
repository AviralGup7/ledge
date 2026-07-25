// E2-T05 property suite — randomized chrome-observation scripts (created / updated /
// activated / removed / moved / attached / windows / groups / restart) against a pure
// model of the §4 mapping laws. Laws proved per script, after every flush:
//   1. stream goodness   — every envelope is a valid §4 catalog row with a valid id;
//                          seqs are contiguous from 1; lamports never decrease.
//   2. model equivalence — the durable stream equals the model's expected stream,
//                          type-for-type and (browserTabId → ledgeTabId)-for-id:
//                          nothing lost, nothing duplicated, nothing reordered.
//   3. identity law      — exactly one TabObserved per browserTabId across restarts;
//                          one browserTabId never maps to two ledgeTabIds.
//   4. temporal law      — a tab's TabUpdated/TabActivated/TabClosedExternal never
//                          precede its TabObserved; closes are final within the
//                          stream the model says are possible.
//   5. restart law       — instance death anywhere loses nothing durable; the
//                          respawned hub hydrates identity from the journal and the
//                          combined stream still matches the model.
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { TabInfo } from '@/application/ports/tabs.port.js';
import type { JournalReadEvent } from '@/application/ports/journal.port.js';
import type { IngestCounters } from '@/application/hub/ingest/index.js';
import { isId } from '@/shared-kernel/identity/index.js';
import { DEV_A } from '@/infrastructure/journal/core/testkit.js';
import { validatePayload } from '@/shared-kernel/events/index.js';
import { makeWorld, type IngestWorld } from '../unit/ingest/testkit.js';

/**
 * Counters are per-INSTANCE truth (unit law B18): a respawned hub counts only its
 * own appends. The cross-restart invariant is therefore the SUM over lifetimes —
 * every mapping decision is counted exactly once across hub instances, never lost
 * to instance death, never double-counted by the respawn.
 */
const ZERO_COUNTERS: IngestCounters = {
  observed: 0,
  updated: 0,
  activated: 0,
  closed: 0,
  windowsClosed: 0,
  groupsChanged: 0,
  skippedUnknownTab: 0,
};

const mergeCounters = (a: IngestCounters, b: IngestCounters): IngestCounters => ({
  observed: a.observed + b.observed,
  updated: a.updated + b.updated,
  activated: a.activated + b.activated,
  closed: a.closed + b.closed,
  windowsClosed: a.windowsClosed + b.windowsClosed,
  groupsChanged: a.groupsChanged + b.groupsChanged,
  skippedUnknownTab: a.skippedUnknownTab + b.skippedUnknownTab,
});

type Op =
  | { readonly kind: 'created'; readonly n: number; readonly group: boolean }
  | { readonly kind: 'updated'; readonly n: number; readonly change: 'title' | 'url' | 'none' }
  | { readonly kind: 'activated'; readonly n: number }
  | { readonly kind: 'removed'; readonly n: number }
  | { readonly kind: 'moved'; readonly n: number }
  | { readonly kind: 'attached'; readonly n: number }
  | { readonly kind: 'windowRemoved' }
  | { readonly kind: 'windowCreated' }
  | { readonly kind: 'windowFocus' }
  | { readonly kind: 'groupChanged'; readonly g: number }
  | { readonly kind: 'restart' };

const TAB_POOL = 12;
const SCRIPT_MAX = 40;
const PROPERTY_TIMEOUT_MS = 600_000;

const opArb: fc.Arbitrary<Op> = fc
  .tuple(
    fc.integer({ min: 1, max: TAB_POOL }),
    fc.integer({ min: 1, max: 3 }),
    fc.boolean(),
    fc.constantFrom('title', 'url', 'none' as const),
  )
  .chain(([n, g, gr, change]) =>
    fc.constantFrom(
      { kind: 'created', n, group: gr } as const,
      { kind: 'created', n, group: gr } as const, // weighted: births dominate a session
      { kind: 'updated', n, change } as const,
      { kind: 'updated', n, change } as const,
      { kind: 'updated', n, change: 'none' } as const,
      { kind: 'activated', n } as const,
      { kind: 'removed', n } as const,
      { kind: 'moved', n } as const,
      { kind: 'attached', n } as const,
      { kind: 'windowRemoved' } as const,
      { kind: 'windowCreated' } as const,
      { kind: 'windowFocus' } as const,
      { kind: 'groupChanged', g } as const,
      { kind: 'restart' } as const,
    ),
  );

/** The pure mapping model — §4 laws replayed without hub machinery. */
interface Model {
  /** browserTabId → identity slot (ledgeTabId alias is filled from the stream). */
  readonly known: Map<number, { closed: boolean }>;
  /** Expected durable stream, in order (ledger aliases resolved at compare time). */
  readonly expected: { readonly type: string; readonly tab: number | null }[];
  readonly counts: {
    observed: number;
    updated: number;
    activated: number;
    closed: number;
    windowsClosed: number;
    groupsChanged: number;
    skippedUnknownTab: number;
  };
}

const freshModel = (): Model => ({
  known: new Map(),
  expected: [],
  counts: {
    observed: 0,
    updated: 0,
    activated: 0,
    closed: 0,
    windowsClosed: 0,
    groupsChanged: 0,
    skippedUnknownTab: 0,
  },
});

const applyOp = (model: Model, op: Op): void => {
  switch (op.kind) {
    case 'created': {
      const slot = model.known.get(op.n);
      if (slot === undefined) {
        model.known.set(op.n, { closed: false });
        model.expected.push({ type: 'TabObserved', tab: op.n });
        model.counts.observed += 1;
        return;
      }
      // Restart race law: re-created known tab supersedes via TabUpdated —
      // never a second TabObserved.
      slot.closed = false;
      model.expected.push({ type: 'TabUpdated', tab: op.n });
      model.counts.updated += 1;
      return;
    }
    case 'updated': {
      const slot = model.known.get(op.n);
      if (slot === undefined || slot.closed) {
        model.counts.skippedUnknownTab += 1;
        return;
      }
      if (op.change === 'none') return; // empty-change noise: mapped, counted as nothing
      model.expected.push({ type: 'TabUpdated', tab: op.n });
      model.counts.updated += 1;
      return;
    }
    case 'activated': {
      const slot = model.known.get(op.n);
      if (slot === undefined || slot.closed) {
        model.counts.skippedUnknownTab += 1;
        return;
      }
      model.expected.push({ type: 'TabActivatedObserved', tab: op.n });
      model.counts.activated += 1;
      return;
    }
    case 'removed': {
      const slot = model.known.get(op.n);
      if (slot === undefined || slot.closed) {
        model.counts.skippedUnknownTab += 1;
        return;
      }
      slot.closed = true;
      model.expected.push({ type: 'TabClosedExternal', tab: op.n });
      model.counts.closed += 1;
      return;
    }
    case 'moved':
    case 'attached':
      return; // §4 has no row — silent window tracking only
    case 'windowRemoved':
      model.expected.push({ type: 'WindowClosedExternal', tab: null });
      model.counts.windowsClosed += 1;
      return;
    case 'windowCreated':
    case 'windowFocus':
      return; // no v1 catalog row
    case 'groupChanged':
      model.expected.push({ type: 'GroupChanged', tab: null });
      model.counts.groupsChanged += 1;
      return;
    case 'restart':
      return; // durability boundary — the stream must be indifferent to it
  }
};

/** Drive one op into the hub through the port-typed surfaces. */
const driveOp = async (
  w: IngestWorld,
  op: Op,
  urls: Record<number, string | undefined>,
  windowSerial: { value: number },
  lifetime: { counters: IngestCounters },
): Promise<IngestWorld> => {
  const world = w;
  switch (op.kind) {
    case 'created': {
      const tab: TabInfo = {
        ...world.tab(op.n, urls[op.n] ?? `https://w${op.n}.example/page`),
        groupId: op.group ? 7 : null,
      };
      await world.hub.handleTabsEvent(world.createdEvent(tab));
      return world;
    }
    case 'updated': {
      if (op.change === 'none') {
        await world.hub.handleTabsEvent({
          kind: 'updated',
          browserTabId: op.n,
          windowId: 1,
          changes: {},
        });
        return world;
      }
      if (op.change === 'title') {
        await world.hub.handleTabsEvent({
          kind: 'updated',
          browserTabId: op.n,
          windowId: 1,
          changes: { title: `renamed ${op.n}` },
        });
        return world;
      }
      urls[op.n] = `https://w${op.n}.example/moved-${op.n}`;
      await world.hub.handleTabsEvent({
        kind: 'updated',
        browserTabId: op.n,
        windowId: 1,
        changes: { url: urls[op.n] ?? '' },
      });
      return world;
    }
    case 'activated':
      await world.hub.handleTabsEvent({ kind: 'activated', browserTabId: op.n, windowId: 1 });
      return world;
    case 'removed':
      await world.hub.handleTabsEvent({
        kind: 'removed',
        browserTabId: op.n,
        windowId: 1,
        isWindowClosing: false,
      });
      return world;
    case 'moved':
      await world.hub.handleTabsEvent({
        kind: 'moved',
        browserTabId: op.n,
        windowId: 1,
        fromIndex: 0,
        toIndex: 1,
      });
      return world;
    case 'attached':
      await world.hub.handleTabsEvent({
        kind: 'attached',
        browserTabId: op.n,
        windowId: 1,
        newIndex: 0,
      });
      return world;
    case 'windowRemoved': {
      windowSerial.value += 1;
      await world.hub.handleWindowsEvent({ kind: 'removed', windowId: 900 + windowSerial.value });
      return world;
    }
    case 'windowCreated': {
      windowSerial.value += 1;
      const win = {
        windowId: 900 + windowSerial.value,
        focused: false,
        state: 'normal',
        type: 'normal',
      };
      await world.hub.handleWindowsEvent({ kind: 'created', window: win });
      return world;
    }
    case 'windowFocus':
      await world.hub.handleWindowsEvent({ kind: 'focus-changed', windowId: 1 });
      return world;
    case 'groupChanged':
      await world.hub.handleGroupChanged({ groupId: op.g, name: `g${op.g}`, color: 'blue' });
      return world;
    case 'restart': {
      // Instance death at the durability boundary: flush what is pending, then
      // respawn against the SAME storage and require hydration continuity.
      await world.hub.flush();
      // B18 law: per-instance counters retire with the instance — bank them
      // before the respawn so the cross-lifetime sum can be asserted.
      lifetime.counters = mergeCounters(lifetime.counters, world.hub.counters());
      const respawned = await makeWorld(world.storage);
      const hyd = await respawned.hub.hydrate();
      expect(hyd.ok).toBe(true);
      return respawned;
    }
  }
};

/** Raw event feed for a full restart — durable device stream, seq-ordered. */
const rawEvents = async (w: IngestWorld): Promise<readonly JournalReadEvent[]> => {
  const read = await w.journal.readRange({ deviceId: DEV_A, fromSeq: 0 });
  if (!read.ok) throw new Error(`readRange: ${read.error.code}`);
  return read.value.events;
};

describe('E2-T05 hub ingest — property laws over randomized sessions', () => {
  it('case volume really flows (step-marker sanity — guards against silent short-circuits)', () => {
    let executions = 0;
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 4 }), (script) => {
        executions += script.length;
      }),
    );
    // numRuns × ≥1 op each — if the runner ever short-circuits, this goes red.
    expect(executions).toBeGreaterThanOrEqual(200);
  });

  it(
    'scripted sessions produce a model-equal, well-formed, restart-proof stream',
    { timeout: PROPERTY_TIMEOUT_MS },
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(opArb, { minLength: 1, maxLength: SCRIPT_MAX }),
          async (script) => {
            let world = await makeWorld();
            const model = freshModel();
            const urls: Record<number, string | undefined> = {};
            const windowSerial = { value: 0 };
            const lifetime = { counters: ZERO_COUNTERS };

            for (const op of script) {
              applyOp(model, op);
              world = await driveOp(world, op, urls, windowSerial, lifetime);
            }
            const flush = await world.hub.flush();
            expect(flush.ok).toBe(true);

            const stream = await rawEvents(world);
            const byTab = new Map<number, string>(); // browserTabId → ledgeTabId
            const seenTimeline = new Map<number, { observed: boolean; closed: boolean }>();
            let prevLamport = 0;

            // Laws 1+2: well-formed stream, exactly the model's stream.
            expect(stream.length).toBe(model.expected.length);
            for (let i = 0; i < stream.length; i += 1) {
              const row = stream[i];
              const want = model.expected[i];
              expect(row).toBeDefined();
              expect(want).toBeDefined();
              if (row === undefined || want === undefined) continue;
              expect(row.seq).toBe(i + 1); // contiguous from 1
              const env = row.envelope;
              expect(isId(env.eventId)).toBe(true);
              const valid = validatePayload(env.type, env.payload);
              expect(valid.ok).toBe(true);
              expect(env.hlc.lamport).toBeGreaterThanOrEqual(prevLamport);
              prevLamport = env.hlc.lamport;
              expect(env.type).toBe(want.type);

              const payload: unknown = env.payload;
              expect(typeof payload).toBe('object');
              if (typeof payload !== 'object' || payload === null) continue;
              const rec = payload as Record<string, unknown>;

              if (want.type === 'TabObserved') {
                expect(rec['browserTabId']).toBe(want.tab);
                // Law 3: one TabObserved per browserTabId, one ledgeTabId per tab.
                expect(byTab.has(want.tab as number)).toBe(false);
                const ledgeTabId = rec['ledgeTabId'];
                expect(typeof ledgeTabId).toBe('string');
                byTab.set(want.tab as number, ledgeTabId as string);
                seenTimeline.set(want.tab as number, { observed: true, closed: false });
                continue;
              }
              if (want.type === 'TabUpdated' || want.type === 'TabActivatedObserved') {
                // Law 4: references resolve to THIS tab's minted identity and
                // never precede its TabObserved. (A 'created'-supersede is the
                // one TabUpdated whose identity was minted in the same batch.)
                const ledgeTabId = rec['ledgeTabId'];
                expect(ledgeTabId).toBe(byTab.get(want.tab as number));
                const line = seenTimeline.get(want.tab as number);
                expect(line?.observed).toBe(true);
                continue;
              }
              if (want.type === 'TabClosedExternal') {
                // Law 4 (R2 shape): closes land after the tab's observation row.
                const ledgeTabId = rec['ledgeTabId'];
                expect(ledgeTabId).toBe(byTab.get(want.tab as number));
                const line = seenTimeline.get(want.tab as number);
                expect(line?.observed).toBe(true);
                expect(line?.closed).toBe(false); // closes are final in-stream
                seenTimeline.set(want.tab as number, { observed: true, closed: true });
                continue;
              }
              if (want.type === 'WindowClosedExternal') {
                expect(typeof rec['windowId']).toBe('number');
                continue;
              }
              if (want.type === 'GroupChanged') {
                expect(typeof rec['groupId']).toBe('number');
              }
            }

            // Law 3b: the cross-lifetime SUM of per-instance counters equals the
            // model's decision counts exactly — no decision lost to instance
            // death, none double-counted by a respawn (B18's ownership law).
            const counters = mergeCounters(lifetime.counters, world.hub.counters());
            expect(counters.observed).toBe(model.counts.observed);
            expect(counters.updated).toBe(model.counts.updated);
            expect(counters.activated).toBe(model.counts.activated);
            expect(counters.closed).toBe(model.counts.closed);
            expect(counters.windowsClosed).toBe(model.counts.windowsClosed);
            expect(counters.groupsChanged).toBe(model.counts.groupsChanged);
            expect(counters.skippedUnknownTab).toBe(model.counts.skippedUnknownTab);

            // Law 5: a post-script respawn sees the identical durable truth.
            const respawned = await makeWorld(world.storage);
            const hyd = await respawned.hub.hydrate();
            expect(hyd.ok).toBe(true);
            if (hyd.ok) {
              expect(hyd.value.durableThrough).toBe(stream.length);
              expect(hyd.value.identities).toBe(model.known.size);
            }
          },
        ),
      );
    },
  );
});
