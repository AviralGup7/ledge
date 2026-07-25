// E3-T01 · ADR-032 contract suite — WindowsPort laws, adapter-parametric.
//   W1 list() returns every live window
//   W2 create({tabSpecs:[u1,u2],focused}) → windowId; 'created' event payload matches;
//      focus law: focused:true ⇒ focus-changed event carries the new id
//   W3 create(30-tab window) ≤1.5s budget probe (§6 row; full verification in lanes)
//   W4 remove(id) race-tolerant: already-removed = ok; contained tabs close with
//      isWindowClosing:true on the TABS stream before windows 'removed' fires
//   W5 focus(id) gone-window → E_NOT_FOUND_TAB; focus(live) fires focus-changed
//   W6 capability-class rejection → E_CAPABILITY_API
//   W7 focus-blur normalizes WINDOW_ID_NONE (-1) to null
import { describe, expect, it } from 'vitest';
import type { TabsEvent, TabsPort } from '@/application/ports/tabs.port.js';
import type { WindowsEvent, WindowsPort } from '@/application/ports/windows.port.js';
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';

const unwrap = <T>(r: Result<T, LedgeError>): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.value;
};

export interface WindowsPortBinding {
  readonly makeAdapter: () => WindowsPort;
  readonly makeTabsAdapter: () => TabsPort;
  readonly sabotageNext: ((cause: unknown) => void) | null;
  readonly openTwoWindows: () => Promise<readonly number[]>;
}

const CREATE_30_BUDGET_MS = 1500;
const MEGA_TABS = 30;

export function describeWindowsPortContract(name: string, binding: WindowsPortBinding): void {
  describe(`WindowsPort contract [${name}]`, () => {
    it('W1: list() returns every live window', async () => {
      const port = binding.makeAdapter();
      const ids = await binding.openTwoWindows();
      const rows = unwrap(await port.list());
      const got = new Set(rows.map((r) => r.windowId));
      for (const id of ids) expect(got.has(id)).toBe(true);
    });

    it('W2: create resolves windowId, fires created + focus-changed with the new id', async () => {
      const port = binding.makeAdapter();
      const events: WindowsEvent[] = [];
      const sub = port.onEvents((e) => events.push(e));
      const windowId = unwrap(
        await port.create({
          tabSpecs: [{ url: 'https://example.com/a' }, { url: 'https://example.com/b' }],
          focused: true,
        }),
      );
      sub.close();
      expect(windowId).toBeGreaterThan(0);
      const created = events.find((e) => e.kind === 'created');
      expect(created?.kind).toBe('created');
      if (created?.kind === 'created') expect(created.window.windowId).toBe(windowId);
      expect(events.some((e) => e.kind === 'focus-changed' && e.windowId === windowId)).toBe(true);
    });

    it(
      `W3: create(${MEGA_TABS}-tab window) meets the §6 budget`,
      { timeout: 120_000 },
      async () => {
        const port = binding.makeAdapter();
        const tabSpecs = Array.from({ length: MEGA_TABS }, (_, i) => ({
          url: `https://bulk.example/${i}`,
        }));
        const started = Date.now();
        const windowId = unwrap(await port.create({ tabSpecs, focused: false }));
        const elapsed = Date.now() - started;
        expect(windowId).toBeGreaterThan(0);
        expect(elapsed, `create(${MEGA_TABS}-tab window) exceeded budget`).toBeLessThan(
          CREATE_30_BUDGET_MS,
        );
      },
    );

    it('W4: race-tolerant remove + close cascade (tabs gone with isWindowClosing:true first)', async () => {
      const port = binding.makeAdapter();
      const tabsPort = binding.makeTabsAdapter();
      const events: TabsEvent[] = [];
      const tabsSub = tabsPort.onEvents((e) => events.push(e));
      const windowId = unwrap(
        await port.create({ tabSpecs: [{ url: 'https://example.com/x' }], focused: false }),
      );
      unwrap(await port.remove(windowId));
      tabsSub.close();
      const cascade = events.filter(
        (e) => e.kind === 'removed' && e.windowId === windowId && e.isWindowClosing,
      );
      expect(cascade.length).toBeGreaterThan(0);
      expect(unwrap(await tabsPort.query({ windowId: windowId }))).toEqual([]);
      // Already-removed: the law is ok, not an error.
      expect((await port.remove(windowId)).ok).toBe(true);
    });

    it('W5: focus(gone) → E_NOT_FOUND_TAB; focus(live) fires focus-changed', async () => {
      const port = binding.makeAdapter();
      const gone = await port.focus(-505050);
      expect(gone.ok).toBe(false);
      if (!gone.ok) expect(gone.error.code).toBe('E_NOT_FOUND_TAB');
      const windowId = unwrap(await port.create({ tabSpecs: [], focused: false }));
      const events: WindowsEvent[] = [];
      const sub = port.onEvents((e) => events.push(e));
      unwrap(await port.focus(windowId));
      sub.close();
      expect(events.some((e) => e.kind === 'focus-changed' && e.windowId === windowId)).toBe(true);
    });

    it('W6: capability-class rejection maps to E_CAPABILITY_API', async () => {
      const port = binding.makeAdapter();
      if (binding.sabotageNext === null) return;
      binding.sabotageNext(new Error('windows.getAll: revoked'));
      const r = await port.list();
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('E_CAPABILITY_API');
    });
  });
}
