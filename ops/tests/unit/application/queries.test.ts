// E3-APP · Read-side contract (R10 heartbeat, bootstrap/library detail, trash sweep,
// keyword search with the Tier-3-absent freshness law 'fallback', activity merger).
// Queries are read-ONLY over projected views — no journal writes, no browser calls.
import { describe, expect, it } from 'vitest';
import {
  browserTabIdOf,
  browserWindowIdOf,
  ledgeTabIdOf,
  liveTabPlan,
  makeServices,
  mustOk,
  testId,
  type SeedPlan,
} from './services.testkit.js';

const missionIdOf = (n: number): string => testId(40_000 + n);

const missionPlan = (m: number, name: string, tabNums: readonly number[]): SeedPlan => ({
  type: 'MissionFormed',
  payload: {
    missionId: missionIdOf(m),
    name,
    namedBy: 'user',
    tabIds: tabNums.map(ledgeTabIdOf),
  },
});

const assignedPlan = (n: number, m: number): SeedPlan => ({
  type: 'TabAssigned',
  payload: { tabId: ledgeTabIdOf(n), missionId: missionIdOf(m) },
});

describe('E3-APP queries — R10 heartbeat + bootstrap hygiene', () => {
  it('heartbeat counts KEPT across all missions and LIVE recoverable (R10)', async () => {
    const h = await makeServices();
    await h.seed([
      liveTabPlan(1),
      liveTabPlan(2),
      liveTabPlan(3),
      missionPlan(1, 'a', [1]),
      assignedPlan(1, 1),
    ]);
    const hb = await mustOk(h.services.queries.heartbeat());
    expect(hb.keptCount).toBe(1);
    expect(hb.liveRecoverable).toBe(2);
    expect(typeof hb.asOf).toBe('number');
  });

  it('bootstrap lists non-trash missions (activity-desc), recent closes, and trashCount', async () => {
    const h = await makeServices();
    await h.seed([
      liveTabPlan(1),
      liveTabPlan(2),
      missionPlan(1, 'alpha', [1]),
      missionPlan(2, 'beta', [2]),
      {
        type: 'EntityTrashed',
        payload: {
          kind: 'tab',
          id: ledgeTabIdOf(2),
          inverseAtom: { type: 'restore-tab', tabId: ledgeTabIdOf(2) },
          deletedAt: 1_785_400_110_000,
        },
      },
    ]);
    const boot = await mustOk(h.services.queries.getBootstrap({ surface: 'sidepanel' }));
    expect(boot.missions.length).toBe(2);
    const names = boot.missions.map((m) => m.name);
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
    expect(boot.trashCount).toBe(1);

    // Trashing the second mission removes it from the bootstrap library.
    await mustOk(
      h.services.trash.deleteEntity({ kind: 'mission', id: missionIdOf(1) }, h.ctxOf(1).ctx),
    );
    const after = await mustOk(h.services.queries.getBootstrap({ surface: 'sidepanel' }));
    expect(after.missions.map((m) => m.name)).toEqual(['beta']);
    expect(after.trashCount).toBe(3); // mission + its member tab + the seeded one
  });

  it('queries are read-only: zero journal writes and zero browser calls', async () => {
    const h = await makeServices();
    await h.seed([liveTabPlan(1), missionPlan(1, 'ro', [1])]);
    const before = (await h.events()).length;
    await mustOk(h.services.queries.heartbeat());
    await mustOk(h.services.queries.getBootstrap({ surface: 'x' }));
    await mustOk(h.services.queries.getLibrary({ sort: 'alpha' }));
    await mustOk(h.services.queries.getTrash());
    await mustOk(h.services.queries.search({ q: 'site' }));
    await mustOk(h.services.queries.peekOpenTabs({}));
    expect((await h.events()).length).toBe(before);
    expect(h.fakeTabs.removedLog().length + h.fakeTabs.createdLog().length).toBe(0);
    expect(h.fakeWindows.createdLog().length).toBe(0);
  });
});

describe('E3-APP queries — search fallback law + detail/trash sweeps', () => {
  it('search is multi-term AND over kept|live rows and discloses freshness fallback', async () => {
    const h = await makeServices();
    await h.seed([
      liveTabPlan(1, { title: 'Alpha Research doc' }),
      liveTabPlan(2, { title: 'Alpha beta gamma' }),
      missionPlan(1, 'work', [1]),
      assignedPlan(1, 1),
    ]);
    const single = await mustOk(h.services.queries.search({ q: 'alpha' }));
    expect(single.freshness).toBe('fallback'); // Tier-3 index absent — honest disclosure
    expect(single.results.length).toBe(2);

    // AND law: every term must match the same row.
    const conjunct = await mustOk(h.services.queries.search({ q: 'alpha research' }));
    expect(conjunct.results.length).toBe(1);
    expect(conjunct.results[0]?.title).toBe('Alpha Research doc');
    expect(conjunct.results[0]?.state).toBe('kept');

    const empty = await mustOk(h.services.queries.search({ q: 'zzz-not-present' }));
    expect(empty.results.length).toBe(0);
  });

  it('getTrash sweeps trashed tabs+missions with parent names, newest first', async () => {
    const h = await makeServices();
    await h.seed([liveTabPlan(1), missionPlan(1, 'bin', [1])]);
    await mustOk(
      h.services.trash.deleteEntity({ kind: 'mission', id: missionIdOf(1) }, h.ctxOf(2).ctx),
    );
    const trash = await mustOk(h.services.queries.getTrash());
    expect(trash.entries.length).toBe(2);
    const kinds = trash.entries.map((e) => e.kind).sort();
    expect(kinds).toEqual(['mission', 'tab']);
  });

  it('getMissionDetail joins mission + member tabs (artifacts are honest-empty v1)', async () => {
    const h = await makeServices();
    await h.seed([liveTabPlan(1), missionPlan(1, 'detail', [1])]);
    const detail = await mustOk(h.services.queries.getMissionDetail({ missionId: missionIdOf(1) }));
    expect(detail.mission.name).toBe('detail');
    expect(detail.tabs.length).toBe(1);
    // memory_artifacts has NO v1 projector (registry growth follow-up) — reads stay
    // honest-empty rather than fabricating topics.
    expect(detail.artifacts).toEqual([]);

    const missing = await h.services.queries.getMissionDetail({ missionId: missionIdOf(90) });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe('E_DOMAIN_LEGALITY');
  });

  it('peekOpenTabs is browser-side truth (the port read, never the tab rows)', async () => {
    const h = await makeServices();
    h.fakeTabs.seedLive(browserTabIdOf(1));
    h.fakeTabs.seedLive(browserTabIdOf(2));
    const open = await mustOk(h.services.queries.peekOpenTabs({}));
    expect(open.length).toBe(2);
    expect(open.map((t) => t.browserTabId).sort()).toEqual(
      [browserTabIdOf(1), browserTabIdOf(2)].sort(),
    );
    // Window-scoped peek narrows by the fake-window law bucket.
    const scoped = await mustOk(
      h.services.queries.peekOpenTabs({ windowId: browserWindowIdOf(1) }),
    );
    expect(scoped.every((t) => t.windowId === browserWindowIdOf(1))).toBe(true);
  });

  it('getActivity merges recent trash/latest, honoring the limit clamp', async () => {
    const h = await makeServices();
    await h.seed([liveTabPlan(1), liveTabPlan(2), liveTabPlan(3), missionPlan(1, 'm', [1])]);
    await mustOk(
      h.services.trash.deleteEntity({ kind: 'tab', id: ledgeTabIdOf(2) }, h.ctxOf(3).ctx),
    );
    const activity = await mustOk(h.services.queries.getActivity({ limit: 5 }));
    expect(activity.length).toBeGreaterThan(0);
    expect(activity.length).toBeLessThanOrEqual(5);
  });
});

describe('E6 · getHealth — diagnostics registry dump (seam wired by default in the harness)', () => {
  it('answers the §12 probe rows, the ring timeline, and a null lastBundle pre-export', async () => {
    const h = await makeServices();
    await mustOk(
      h.services.system.rescueScanNow({ mode: 'tail', consoleAuthorized: false }, h.ctxOf(60).ctx),
    );
    const dump = (await mustOk(h.services.queries.getHealth())) as {
      registryV: number;
      probes: { name: string; wired: boolean; status: string }[];
      lastBundle: unknown;
      recentRing: { kind: string; msg: string }[];
      asOf: number;
    };
    expect(dump.registryV).toBe(1);
    // Catalog-complete: the ten §12 probes + the lifecycle probe.
    expect(dump.probes.length).toBe(11);
    expect(dump.probes[10]?.name).toBe('diag-selftest');
    // The scan row the service wrote rides the unified-ring timeline.
    const scanRows = dump.recentRing.filter((r) => r.kind === 'scan');
    expect(scanRows.length).toBe(1);
    expect(scanRows[0]?.msg).toBe('scan-tail');
    expect(dump.lastBundle).toBeNull();
    expect(typeof dump.asOf).toBe('number');
  });

  it('after ExportDiagnostics the dump carries lastBundle metadata + json (download gesture lane)', async () => {
    const h = await makeServices();
    const out = await mustOk(
      h.services.system.exportDiagnostics({ includeAddresses: true }, h.ctxOf(61).ctx),
    );
    const dump = (await mustOk(h.services.queries.getHealth())) as {
      lastBundle: {
        bundleId: string;
        size: number;
        includeAddresses: boolean;
        json: string;
      } | null;
    };
    expect(dump.lastBundle?.bundleId).toBe(out.bundleId);
    expect(dump.lastBundle?.includeAddresses).toBe(true);
    expect(dump.lastBundle?.size).toBe(dump.lastBundle?.json.length);
    const doc = JSON.parse(dump.lastBundle?.json ?? '{}') as {
      bundleId?: string;
      schemaV?: number;
    };
    expect(doc.bundleId).toBe(out.bundleId);
    expect(doc.schemaV).toBe(1);
  });
});
