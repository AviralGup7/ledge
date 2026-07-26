// E3-APP · Composition-root runtime law tests: the post-boot runtime assembles the
// whole application graph from boot truth (memory/dexie stubs per EES §9.16),
// dispatch routes wire vs internal by registry membership, a dead boot never yields
// a half-booted runtime.
import { describe, expect, it } from 'vitest';
import { CONTRACT_V } from '@/application/contracts/envelope.js';
import type { WireStreamMessage } from '@/application/hub/outbox/index.js';
import { openEngine, testId } from '@/infrastructure/journal/core/testkit.js';
import { createMemoryStorageEngine } from '@/infrastructure/storage/memory/memory-engine.js';
import { composeBackgroundGraph } from '@/roots/bg-root.js';
import { makeFakeSnapshots, makeFakeTabs, makeFakeWindows } from './services.testkit.js';

const BAD_ENTROPY = (): Uint8Array => {
  throw new Error('entropy dead');
};

const envelope = (name: string, kind: 'command' | 'query', payload: unknown, cid: string) => ({
  v: CONTRACT_V,
  kind,
  name,
  cid: cid as never,
  senderContext: 'guardian' as const,
  payload,
  contractHash: 'h-runtime',
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
};

const makeRuntime = async () => {
  const engine = await openEngine();
  const fakeTabs = makeFakeTabs();
  const fakeWindows = makeFakeWindows(fakeTabs);
  const published: WireStreamMessage[] = [];
  const graph = composeBackgroundGraph({
    storage: engine,
    runtime: {
      tabs: fakeTabs,
      windows: fakeWindows,
      snapshots: makeFakeSnapshots(),
      publish: (m) => published.push(m),
    },
  });
  const runtime = await graph.runtime;
  if (!runtime.ok) throw new Error(`runtime failed: ${runtime.error.code}`);
  return { graph, runtime: runtime.value, fakeTabs, fakeWindows, published, engine };
};

describe('E3-APP runtime — post-boot composition law', () => {
  it('resolves after boot and serves a wire command through the whole composed graph', async () => {
    const g = await makeRuntime();
    const cid = testId(90_001);
    const answer = g.runtime.dispatch(
      envelope('StartMission', 'command', { name: 'ship' }, cid),
      'zone0',
    ) as { outcome: string };
    expect(answer.outcome).toBe('ack');
    const terminal = await g.runtime.wire.terminalOf(cid);
    expect(terminal.result.ok).toBe(true);
    if (!terminal.result.ok) return;
    const value = terminal.result.value as { missionId: string; windowId: number };
    expect(value.missionId.length).toBe(26);
    expect(g.fakeWindows.createdLog().length).toBe(1); // C2: browser window created first
    await flush();
    const names = g.published.map((m) => m.name);
    expect(names).toContain('CommandApplied');
    expect(names).toContain('ViewDelta');
    expect(names).toContain('HeartbeatUpdate');
    await g.engine.close();
  });

  it('a boot failure fails the runtime identically (never a half-booted graph)', async () => {
    const graph = composeBackgroundGraph({
      storage: createMemoryStorageEngine(),
      randomBytes: BAD_ENTROPY,
    });
    const boot = await graph.boot;
    expect(boot.ok).toBe(false);
    const runtime = await graph.runtime;
    expect(runtime.ok).toBe(false);
    if (boot.ok || runtime.ok) return;
    expect(runtime.error.code).toBe(boot.error.code);
    await graph.storage.close();
  });

  it('internal Tier-2 dispatch routes by registry membership (never the wire registry)', async () => {
    const g = await makeRuntime();
    const cid = testId(90_002);
    const answer = g.runtime.dispatch(
      envelope('GetActivity', 'query', { limit: 3 }, cid),
      'zone0',
    ) as { outcome: string };
    expect(answer.outcome).toBe('ack');
    const terminal = await g.runtime.internal.terminalOf(cid);
    expect(terminal.result.ok).toBe(true);
    if (!terminal.result.ok) return;
    expect(Array.isArray(terminal.result.value)).toBe(true);
    // Proving the boundary: the WIRE dispatcher refuses to serve the internal name.
    const wireDirect = g.runtime.wire.dispatch(
      envelope('GetActivity', 'query', {}, testId(90_003)),
      'zone0',
    );
    expect(wireDirect.outcome).toBe('ignored');
    await g.engine.close();
  });

  it('the wired import seam answers honest typed refusals through the composed graph', async () => {
    // E5-T05 moved the level: the importer is root-composed (WP5), so the pre-E5
    // "unwired seam → E_CAPABILITY" law no longer applies at the graph — a request
    // without a bytes transport gets the adapter's typed refusal instead. Truly
    // unwired seams still refuse E_CAPABILITY (service-level law, proven in
    // system-prefs-portability.test.ts).
    const g = await makeRuntime();
    const cid = testId(90_004);
    g.runtime.dispatch(
      envelope('ImportPreviewRequest', 'command', { fileMeta: { name: 'a.json', size: 1 } }, cid),
      'zone0',
    );
    const terminal = await g.runtime.wire.terminalOf(cid);
    expect(terminal.result.ok).toBe(false);
    if (terminal.result.ok) return;
    expect(terminal.result.error.code).toBe('E_FORMAT_UNKNOWN'); // 'import-bytes'
    await g.engine.close();
  });
});
