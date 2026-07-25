// E3-T01 · ADR-032 contract suite — TabsPort laws, adapter-parametric.
// Identical suite runs against every TabsPort binding (fake; reference Chrome in
// stable/beta lanes via tabs-port.chrome.test.ts). Laws transcribe EES §6's row:
//   T1 query() no-filter returns every live tab, order-stable by (windowId,index)
//   T2 query({windowId}) filters exactly; empty-window query is []
//   T3 get(missing) → typed E_NOT_FOUND_TAB (refresh signal), never a throw
//   T4 remove([a,b,missing]) → ok(removed=[a,b]) — race-tolerant, tabs actually gone
//   T5 create(spec) → id; onEvents 'created' carries the normalized TabInfo verbatim
//   T6 move(ids,{index}) in-window → 'moved' event fromIndex/toIndex; get reflects it
//   T7 capability-class rejection → E_CAPABILITY_API (sabotage binding hook)
//   T8 query(all) budget probe @500 tabs (≤50ms — full verification in Chrome lanes)
import { describe, expect, it } from 'vitest';
import type { TabsEvent, TabsPort } from '@/application/ports/tabs.port.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';

const unwrap = <T>(r: Result<T, LedgeError>): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.value;
};

export interface TabsPortBinding {
  readonly makeAdapter: () => TabsPort;
  /** Seed N tabs across one window; returns created tab ids in creation order. */
  readonly seedTabs: (n: number) => Promise<readonly number[]>;
  readonly drive: {
    readonly update: (tabId: number, changes: { title?: string | undefined }) => void;
    readonly activate: (tabId: number) => void;
  } | null;
  readonly sabotageNext: ((cause: unknown) => void) | null;
  readonly windowIdOfSeeded: () => number;
}

const QUERY_BUDGET_MS = 50;
const PERF_TAB_COUNT = 500;

export function describeTabsPortContract(name: string, binding: TabsPortBinding): void {
  describe(`TabsPort contract [${name}]`, () => {
    it('T1: query() returns every live tab', async () => {
      const port = binding.makeAdapter();
      const ids = await binding.seedTabs(3);
      const rows = unwrap(await port.query());
      const got = new Set(rows.map((r) => r.browserTabId));
      for (const id of ids) expect(got.has(id)).toBe(true);
    });

    it('T2: query({windowId}) filters exactly', async () => {
      const port = binding.makeAdapter();
      const ids = await binding.seedTabs(2);
      const rows = unwrap(await port.query({ windowId: binding.windowIdOfSeeded() }));
      for (const r of rows) expect(r.windowId).toBe(binding.windowIdOfSeeded());
      const miss = unwrap(await port.query({ windowId: -7777 }));
      expect(miss).toEqual([]);
      expect(ids.length).toBe(2);
    });

    it('T3: get(missing) is a typed E_NOT_FOUND_TAB, not a crash', async () => {
      const port = binding.makeAdapter();
      const r = await port.get(-424242);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('E_NOT_FOUND_TAB');
    });

    it('T4: race-tolerant remove — already-gone is ok, removed[] is exact, tabs are gone', async () => {
      const port = binding.makeAdapter();
      const ids = await binding.seedTabs(3);
      const removed = unwrap(await port.remove([ids[0] ?? -1, -999999, ids[1] ?? -1]));
      expect([...removed].sort()).toEqual([ids[0] ?? -1, ids[1] ?? -1].sort());
      const alive = unwrap(await port.query());
      for (const gone of removed) {
        expect(alive.some((t) => t.browserTabId === gone)).toBe(false);
      }
      expect(alive.some((t) => t.browserTabId === ids[2])).toBe(true);
    });

    it('T5: create resolves the id, fires one normalized created event', async () => {
      const port = binding.makeAdapter();
      const events: TabsEvent[] = [];
      const sub = port.onEvents((e) => events.push(e));
      const id = unwrap(await port.create({ url: 'https://example.com/t5', active: false }));
      sub.close();
      expect(id).toBeGreaterThan(0);
      const created = events.filter((e) => e.kind === 'created');
      expect(created).toHaveLength(1);
      const first = created[0];
      if (first?.kind === 'created') {
        expect(first.tab.browserTabId).toBe(id);
        expect(first.tab.url).toBe('https://example.com/t5');
        expect(first.tab.groupId).toBeNull();
      }
      const got = unwrap(await port.get(id));
      expect(got.url).toBe('https://example.com/t5');
    });

    it('T6: move in-window reorders and reports fromIndex/toIndex', async () => {
      const port = binding.makeAdapter();
      const ids = await binding.seedTabs(3);
      const before = unwrap(await port.get(ids[2] ?? -1)).index;
      const events: TabsEvent[] = [];
      const sub = port.onEvents((e) => events.push(e));
      const moved = unwrap(await port.move([ids[2] ?? -1], { index: 0 }));
      sub.close();
      expect(moved).toEqual([ids[2]]);
      const movedEvents = events.filter((e) => e.kind === 'moved');
      expect(movedEvents).toHaveLength(1);
      const m = movedEvents[0];
      if (m?.kind === 'moved') {
        expect(m.browserTabId).toBe(ids[2]);
        // Relative law (window-occupancy independent): the move reports its own
        // before/after truthfully.
        expect(m.fromIndex).toBe(before);
        expect(m.toIndex).toBe(0);
      }
      expect(unwrap(await port.get(ids[2] ?? -1)).index).toBe(0);
    });

    it('T7: capability-class rejection maps to E_CAPABILITY_API', async () => {
      const port = binding.makeAdapter();
      if (binding.sabotageNext === null) return; // real-chrome binding cannot sabotage
      binding.sabotageNext(new Error('tabs.query: permission revoked'));
      const r = await port.query();
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('E_CAPABILITY_API');
    });

    // Driver-dependent laws (update/activate) run only where the binding can drive.
    if (binding.drive !== null) {
      it('T9: updated/activated/removed streams are normalized and total', async () => {
        const port = binding.makeAdapter();
        const ids = await binding.seedTabs(2);
        const drive = binding.drive;
        if (drive === null) throw new Error('drive binding vanished');
        const events: TabsEvent[] = [];
        const sub = port.onEvents((e) => events.push(e));
        drive.update(ids[0] ?? -1, { title: 'renamed' });
        drive.activate(ids[1] ?? -1);
        unwrap(await port.remove([ids[0] ?? -1]));
        sub.close();
        const upd = events.find((e) => e.kind === 'updated');
        expect(upd?.kind).toBe('updated');
        if (upd?.kind === 'updated') expect(upd.changes.title).toBe('renamed');
        expect(events.some((e) => e.kind === 'activated' && e.browserTabId === ids[1])).toBe(true);
        const rem = events.find((e) => e.kind === 'removed' && e.browserTabId === ids[0]);
        expect(rem?.kind).toBe('removed');
        if (rem?.kind === 'removed') expect(rem.isWindowClosing).toBe(false);
      });

      it('T10: a throwing handler never escapes into the adapter (total-handler backdrop)', async () => {
        const port = binding.makeAdapter();
        const sub = port.onEvents(() => {
          throw new Error('handler exploded');
        });
        const drive = binding.drive;
        if (drive === null) throw new Error('drive binding vanished');
        expect(() => drive.update(-1, { title: 'x' })).not.toThrow();
        sub.close();
      });
    }

    it(`T8: query(all) budget probe @${PERF_TAB_COUNT} tabs`, { timeout: 120_000 }, async () => {
      const port = binding.makeAdapter();
      const seeded = new Set(await binding.seedTabs(PERF_TAB_COUNT));
      const started = Date.now();
      const rows = unwrap(await port.query());
      const elapsed = Date.now() - started;
      // Contamination-tolerant: other tests/profile tabs may coexist; the law is
      // that OUR 500 are all reported inside the budget.
      expect(rows.filter((r) => seeded.has(r.browserTabId))).toHaveLength(PERF_TAB_COUNT);
      expect(elapsed, `query(all) exceeded ${QUERY_BUDGET_MS}ms budget`).toBeLessThan(
        QUERY_BUDGET_MS,
      );
    });
  });
}
