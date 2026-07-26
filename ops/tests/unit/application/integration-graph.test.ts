// E3-APP · Dependency-graph integration: wire envelope → contracts validation →
// command bus → public services → truth engine → projections → outbox → §3.5 streams.
// This suite proves the COMPOSITION law (UI ⇄ Application ⇄ Domain ⇄ Infrastructure,
// never sideways) with production code end-to-end; only chrome/transport are fakes.
import { describe, expect, it } from 'vitest';
import { CONTRACT_V } from '@/application/contracts/envelope.js';
import { createAppEventBus } from '@/application/hub/dispatch/app-events.js';
import { createDispatcher, type Dispatcher } from '@/application/hub/dispatch/dispatcher.js';
import { createRingLogSink } from '@/application/hub/dispatch/log.js';
import { createHandlerRegistry } from '@/application/hub/dispatch/registry.js';
import { createOutbox, type WireStreamMessage } from '@/application/hub/outbox/index.js';
import { WIRE_COMMANDS, WIRE_QUERIES } from '@/application/usecases/handlers.js';
import type { AppServices } from '@/application/usecases/index.js';
import type { ViewDeltaFrame } from '@/application/ports/projection-engine.port.js';
import {
  browserTabIdOf,
  liveTabPlan,
  makeServices,
  testId,
  type ServicesHarness,
} from './services.testkit.js';

const FLUSH_ROUNDS = 6;
const flush = async (): Promise<void> => {
  for (let i = 0; i < FLUSH_ROUNDS; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
};

interface Graph {
  readonly h: ServicesHarness;
  readonly dispatcher: Dispatcher;
  readonly published: readonly WireStreamMessage[];
  readonly frames: readonly ViewDeltaFrame[];
}

const makeGraph = async (): Promise<Graph> => {
  const bus = createAppEventBus();
  const published: WireStreamMessage[] = [];
  const frames: ViewDeltaFrame[] = [];
  let servicesRef: AppServices | null = null;
  const outbox = createOutbox({
    bus,
    publish: (m) => published.push(m),
    heartbeat: async () => {
      const r = await servicesRef?.queries.heartbeat();
      return r !== undefined && r.ok
        ? { ok: true as const, value: r.value }
        : { ok: false as const };
    },
    now: () => 1_785_800_000_000,
  });
  outbox.start();
  const h = await makeServices({
    onFrame: (f) => {
      frames.push(f);
      outbox.onDelta(f);
    },
  });
  servicesRef = h.services;
  const dispatcher = createDispatcher<AppServices>({
    registry: createHandlerRegistry({ commands: WIRE_COMMANDS, queries: WIRE_QUERIES }),
    services: h.services,
    logSink: createRingLogSink(),
    events: bus,
  });
  return { h, dispatcher, published, frames };
};

const envelope = (name: string, kind: 'command' | 'query', payload: unknown, cid: string) => ({
  v: CONTRACT_V,
  kind,
  name,
  cid: cid as never,
  senderContext: 'guardian' as const,
  payload,
  contractHash: 'h-integration',
});

describe('E3-APP integration — the whole graph on one command', () => {
  it('ParkTab wire flow: ack stream → applied → view deltas → post-applied heartbeat', async () => {
    const g = await makeGraph();
    const bt = browserTabIdOf(1);
    g.h.fakeTabs.seedLive(bt);
    await g.h.seed([liveTabPlan(1)]);

    const cid = testId(80_001);
    const answer = g.dispatcher.dispatch(
      envelope('ParkTab', 'command', { browserTabId: bt }, cid),
      'zone0',
    );
    expect(answer.outcome).toBe('ack');
    const terminal = await g.dispatcher.terminalOf(cid);
    expect(terminal.result.ok).toBe(true);
    await flush();

    const names = g.published.map((m) => m.name);
    // §3.5 two-phase family: accepted-pending rides BEFORE the terminal.
    expect(names).toContain('CommandAck');
    expect(names).toContain('CommandApplied');
    const ack = g.published.find((m) => m.name === 'CommandAck');
    expect(ack?.payload['cid']).toBe(cid);
    expect(typeof ack?.payload['intentId']).toBe('string');
    expect(names.indexOf('CommandAck')).toBeLessThan(names.indexOf('CommandApplied'));
    // Applied result is the §3.3 C3 shape ({kept: id}).
    const applied = g.published.find((m) => m.name === 'CommandApplied');
    expect((applied?.payload['result'] as { kept: string }).kept).toBe(
      '00000000000000000000231861',
    );
    // Projection frames flowed as ViewDelta streams (missions + tabs views touched).
    const views = g.published.filter((m) => m.name === 'ViewDelta').map((m) => m.payload['view']);
    expect(new Set(views)).toEqual(new Set(['missions', 'tabs', 'sessions']));
    // R10: the heartbeat recomputed AFTER the applied terminal.
    expect(names).toContain('HeartbeatUpdate');
    expect(names.lastIndexOf('HeartbeatUpdate')).toBeGreaterThan(names.indexOf('CommandApplied'));
    const hb = g.published.findLast((m) => m.name === 'HeartbeatUpdate')?.payload;
    expect(hb?.['keptCount']).toBe(1);
    expect(hb?.['liveRecoverable']).toBe(0);
    // No family streams invented for park (registry purity).
    expect(names).not.toContain('ImportProgress');
    expect(names).not.toContain('ExportProgress');
  });

  it('wire-shape firewall: malformed envelopes are rejected before any service call', async () => {
    const g = await makeGraph();
    const cid = testId(80_002);
    const bad = g.dispatcher.dispatch({ garbage: true }, 'zone0');
    expect(bad.outcome).toBe('rejected');
    const badPayload = g.dispatcher.dispatch(
      envelope('ParkTab', 'command', { browserTabId: 'not-a-number' }, cid),
      'zone0',
    );
    expect(badPayload.outcome).toBe('rejected');
    const badName = g.dispatcher.dispatch(envelope('NotACommand', 'command', {}, cid), 'zone0');
    expect(badName.outcome).toBe('ignored'); // unknown-but-valid names: ignored (§3.1 total law)
    await flush();
    const names = g.published.map((m) => m.name);
    expect(names).not.toContain('CommandApplied');
  });

  it('cid resend law (§3.3): the SAME envelope twice answers one terminal, one truth write', async () => {
    const g = await makeGraph();
    const bt = browserTabIdOf(2);
    g.h.fakeTabs.seedLive(bt);
    await g.h.seed([liveTabPlan(2)]);
    const wire = envelope('ParkTab', 'command', { browserTabId: bt }, testId(80_003));
    const first = g.dispatcher.dispatch(wire, 'zone0');
    expect(first.outcome).toBe('ack');
    await g.dispatcher.terminalOf(testId(80_003));
    const second = g.dispatcher.dispatch(wire, 'zone0');
    // §3.3 resend law: the dedupe cache answers 'ack' with the RECORDED terminal
    // republished — truth is written exactly once, never re-executed.
    expect(second.outcome).toBe('ack');
    await flush();
    const parkEvents = (await g.h.events()).filter((e) => e.type === 'ParkIntentAccepted');
    expect(parkEvents.length).toBe(1);
    const applied = g.published.filter((m) => m.name === 'CommandApplied');
    expect(applied.length).toBe(2); // same terminal replayed for the resend
  });

  it('queries ride the query bus: GetBootstrap answers with the DTO (no journal writes)', async () => {
    const g = await makeGraph();
    await g.h.seed([
      liveTabPlan(1),
      {
        type: 'MissionFormed',
        payload: { missionId: testId(80_004), name: 'q', namedBy: 'user', tabIds: [] },
      },
    ]);
    const cid = testId(80_005);
    const before = (await g.h.events()).length;
    const answer = g.dispatcher.dispatch(
      envelope('GetBootstrap', 'query', { surface: 'guardian' }, cid),
      'zone0',
    );
    expect(answer.outcome).toBe('ack');
    const terminal = await g.dispatcher.terminalOf(cid);
    expect(terminal.result.ok).toBe(true);
    if (!terminal.result.ok) return;
    const view = terminal.result.value as { missions: readonly { name: string }[] };
    expect(view.missions.map((m) => m.name)).toContain('q');
    expect((await g.h.events()).length).toBe(before);
  });
});
