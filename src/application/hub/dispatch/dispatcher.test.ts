// E3-APP · Dispatcher law suites — §2.6 hub invariants executed on real contracts:
// validation-before-dispatch, dedupe constancy (§3.3), lanes (interactive > maintenance),
// exactly-one-terminal-per-command, cancellation, progress, structured timing/log.
import { describe, expect, it } from 'vitest';
import { ledgeError, ok } from '@/shared-kernel/result/index.js';
import { CONTRACT_V } from '../../contracts/envelope.js';
import { createDispatcher } from './dispatcher.js';
import { createHandlerRegistry, commandOf, queryOf } from './registry.js';
import { createRingLogSink } from './log.js';
import { createCidDedupeCache } from './cid-dedupe.js';
import type { AppEvent } from './app-events.js';
import type { Handler, TerminalRecord } from './types.js';
import type { MessageZone } from '../../contracts/envelope.js';

const ZONE: MessageZone = 'zone0';
const HASH = 'test-build-hash';

const cidOf = (n: number) => `000000000000000000000000${String(n).padStart(2, '0')}`.slice(-26);

const envelope = (name: string, kind: 'command' | 'query', payload: unknown, cid: string) => ({
  v: CONTRACT_V,
  kind,
  name,
  cid: cid as never,
  senderContext: 'guardian',
  payload,
  contractHash: HASH,
});

const deferred = <T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (v: T) => void;
} => {
  let resolveFn: (v: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolveFn = res;
  });
  return { promise, resolve: (v) => resolveFn(v) };
};

const flush = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
};

interface FakeServices {
  readonly calls: string[];
  readonly barrier?: { readonly hold: () => Promise<string> } | undefined;
}

const rig = (
  commands: readonly ReturnType<typeof commandOf<FakeServices>>[],
  queries: readonly ReturnType<typeof queryOf<FakeServices>>[] = [],
  services: FakeServices = { calls: [] },
) => {
  const sink = createRingLogSink();
  const events: AppEvent[] = [];
  const dispatcher = createDispatcher<FakeServices>({
    registry: createHandlerRegistry({ commands, queries }),
    services,
    logSink: sink,
  });
  dispatcher.events.subscribe((e) => events.push(e));
  const terminalOf = (cid: string): Promise<TerminalRecord> => dispatcher.terminalOf(cid);
  return { dispatcher, sink, events, terminalOf };
};

describe('dispatcher (E3) — validation + routing laws', () => {
  it('executes a valid command: ack → applied terminal with timing + structured log', async () => {
    const handler: Handler<FakeServices> = async (ctx) => {
      ctx.services.calls.push(`ran:${ctx.message.name}`);
      return ok({ kept: '01' });
    };
    const rigState = rig([commandOf('ParkTab', handler)]);
    const cid = cidOf(1);
    const waiting = rigState.terminalOf(cid);
    const answer = rigState.dispatcher.dispatch(
      envelope('ParkTab', 'command', { browserTabId: 7 }, cid),
      ZONE,
    );
    expect(answer.outcome).toBe('ack');
    const terminal = await waiting;
    expect(terminal.result.ok).toBe(true);
    expect(terminal.durationMs).toBeGreaterThanOrEqual(0);
    expect(rigState.events.map((e) => e.type)).toEqual(['command-applied']);
    expect(rigState.sink.entries()).toHaveLength(1);
    expect(rigState.sink.entries()[0]?.outcome).toBe('applied');
    expect(rigState.sink.entries()[0]?.name).toBe('ParkTab');
  });

  it('unknown name is ignored (forward compat §3.1 b), never throws, never logs as failure', () => {
    const rigState = rig([commandOf('ParkTab', async () => ok({}))]);
    const answer = rigState.dispatcher.dispatch(
      envelope('FromTheFarFuture', 'command', {}, cidOf(2)),
      ZONE,
    );
    expect(answer.outcome).toBe('ignored');
  });

  it('v1.1 names are ignored as unavailable even when a handler is registered', async () => {
    let ran = 0;
    const { dispatcher } = rig([
      commandOf('NudgeDismiss', async () => {
        ran += 1;
        return ok({});
      }),
    ]);
    const answer = dispatcher.dispatch(
      envelope('NudgeDismiss', 'command', { nudgeType: 'x' }, cidOf(3)),
      ZONE,
    );
    expect(answer.outcome).toBe('ignored');
    await flush();
    expect(ran).toBe(0);
  });

  it('contracts-known but unserved name → ignored no-handler (closed world visibility)', () => {
    const { dispatcher } = rig([]);
    const answer = dispatcher.dispatch(envelope('ParkAll', 'command', {}, cidOf(4)), ZONE);
    expect(answer).toMatchObject({ outcome: 'ignored', reason: 'no-handler', name: 'ParkAll' });
  });

  it('malformed envelope and kind-mismatch are rejected, never dispatched', () => {
    const { dispatcher } = rig([commandOf('ParkTab', async () => ok({}))]);
    const bad = dispatcher.dispatch(
      {
        v: CONTRACT_V,
        kind: 'query',
        name: 'ParkTab',
        cid: cidOf(5),
        senderContext: 'guardian',
        payload: {},
        contractHash: HASH,
      },
      ZONE,
    );
    expect(bad.outcome).toBe('rejected');
    const invalid = dispatcher.dispatch('garbage', ZONE);
    expect(invalid.outcome).toBe('rejected');
  });

  it('event/stream wire kinds inbound are ignored silently', () => {
    const { dispatcher } = rig([]);
    const answer = dispatcher.dispatch(
      {
        v: CONTRACT_V,
        kind: 'stream',
        name: 'ViewDelta',
        cid: cidOf(6),
        senderContext: 'guardian',
        payload: { view: 'missions', watermark: 1, ops: [] },
        contractHash: HASH,
      },
      ZONE,
    );
    expect(answer.outcome).toBe('ignored');
  });
});

describe('dispatcher (E3) — dedupe · lanes · cancellation · progress · observability', () => {
  it('same cid resend replays the recorded terminal; handler runs exactly once (§3.3)', async () => {
    let runs = 0;
    const rigState = rig([
      commandOf('RenameMission', async () => {
        runs += 1;
        return ok({ oldName: 'a' });
      }),
    ]);
    const cid = cidOf(10);
    const waiting = rigState.terminalOf(cid);
    rigState.dispatcher.dispatch(
      envelope(
        'RenameMission',
        'command',
        { missionId: '00000000000000000000000009', name: 'b' },
        cid,
      ),
      ZONE,
    );
    const terminal = await waiting;
    expect(terminal.result.ok && (terminal.result.value as { oldName?: string }).oldName).toBe('a');
    const appliedBefore = rigState.events.length;
    const resent = rigState.dispatcher.dispatch(
      envelope(
        'RenameMission',
        'command',
        { missionId: '00000000000000000000000009', name: 'b' },
        cid,
      ),
      ZONE,
    );
    expect(resent.outcome).toBe('ack');
    await flush();
    expect(runs).toBe(1);
    expect(rigState.events.length).toBe(appliedBefore + 1); // terminal replayed exactly once
    expect(rigState.events.at(-1)).toMatchObject({ type: 'command-applied', cid });
  });

  it('dedupe cache expires with TTL (10-min law; injected TTL for the suite)', async () => {
    let runs = 0;
    let now = 1_000;
    const sink = createRingLogSink();
    const dispatcher = createDispatcher<FakeServices>({
      registry: createHandlerRegistry({
        commands: [
          commandOf('RenameMission', async () => {
            runs += 1;
            return ok({});
          }),
        ],
        queries: [],
      }),
      services: { calls: [] },
      logSink: sink,
      dedupe: createCidDedupeCache(50),
      now: () => now,
    });
    const cid = cidOf(11);
    const first = dispatcher.terminalOf(cid);
    dispatcher.dispatch(
      envelope(
        'RenameMission',
        'command',
        { missionId: '00000000000000000000000009', name: 'b' },
        cid,
      ),
      ZONE,
    );
    await first;
    now = 1_001;
    dispatcher.dispatch(
      envelope(
        'RenameMission',
        'command',
        { missionId: '00000000000000000000000009', name: 'b' },
        cid,
      ),
      ZONE,
    );
    await flush();
    expect(runs).toBe(1);
    now = 1_200; // past TTL
    const second = dispatcher.terminalOf(cid);
    dispatcher.dispatch(
      envelope(
        'RenameMission',
        'command',
        { missionId: '00000000000000000000000009', name: 'b' },
        cid,
      ),
      ZONE,
    );
    await second;
    expect(runs).toBe(2);
  });

  it('cancellation converts to a cancelled terminal + event; handler observed the token cooperatively', async () => {
    const gate = deferred<string>();
    const rigState = rig([
      commandOf('ExportRequest', async (ctx) => {
        ctx.progress({ stage: 1 });
        await gate.promise; // mid-flight window
        ctx.token.throwIfCancelled();
        ctx.progress({ stage: 2 });
        return ok({ exportId: 'e1' });
      }),
    ]);
    const cid = cidOf(12);
    const waiting = rigState.terminalOf(cid);
    rigState.dispatcher.dispatch(
      envelope('ExportRequest', 'command', { scope: 'all', formats: ['json'] }, cid),
      ZONE,
    );
    await flush();
    expect(rigState.dispatcher.cancel(cid)).toBe(true);
    gate.resolve('done');
    const terminal = await waiting;
    expect(terminal.cancelled).toBe(true);
    expect(terminal.result.ok).toBe(false);
    const types = rigState.events.map((e) => e.type);
    expect(types).toContain('progress');
    expect(types).toContain('command-cancelled');
    expect(types).not.toContain('command-applied');
  });

  it('progress stages publish monotonic even when the handler emits out of order', async () => {
    const rigState = rig([
      commandOf('FirstRunIngest', async (ctx) => {
        ctx.progress({ stage: 3 });
        ctx.progress({ stage: 1 });
        return ok({ missionsCreated: 1, tabsCaptured: 2 });
      }),
    ]);
    const cid = cidOf(13);
    const waiting = rigState.terminalOf(cid);
    rigState.dispatcher.dispatch(envelope('FirstRunIngest', 'command', {}, cid), ZONE);
    await waiting;
    const stages = rigState.events
      .filter((e) => e.type === 'progress')
      .map((e) => (e.type === 'progress' ? e.event.stage : -1));
    expect(stages).toEqual([3, 3]);
  });

  it('two-phase pending law: notifyPending publishes command-ack with intentId before applied', async () => {
    const rigState = rig([
      commandOf('ParkAll', async (ctx) => {
        ctx.notifyPending('INTENT1');
        return ok({ missions: 1, keptCount: 3 });
      }),
    ]);
    const cid = cidOf(14);
    const waiting = rigState.terminalOf(cid);
    rigState.dispatcher.dispatch(envelope('ParkAll', 'command', {}, cid), ZONE);
    await waiting;
    const types = rigState.events.map((e) => e.type);
    expect(types.indexOf('command-ack')).toBeLessThan(types.indexOf('command-applied'));
    expect(rigState.events[0]).toMatchObject({ type: 'command-ack', intentId: 'INTENT1' });
  });

  it('handler failure is mapped through the boundary (foreign exception → E_CAPABILITY, contained)', async () => {
    const rigState = rig([
      commandOf('ParkTab', async () => {
        throw new Error('RangeError: stack trace with internals /home/user/src/x.ts');
      }),
    ]);
    const cid = cidOf(15);
    const waiting = rigState.terminalOf(cid);
    rigState.dispatcher.dispatch(envelope('ParkTab', 'command', { browserTabId: 7 }, cid), ZONE);
    const terminal = await waiting;
    expect(terminal.result.ok).toBe(false);
    if (!terminal.result.ok) {
      expect(terminal.result.error.code).toBe('E_CAPABILITY');
      expect(JSON.stringify(terminal.result.error)).not.toContain('/home/user');
    }
  });

  it('typed failures keep catalog codes with operation stamping (details sanitized)', async () => {
    const rigState = rig([
      commandOf('RepairRebuild', async () => {
        return {
          ok: false as const,
          error: ledgeError('E_NOT_FOUND_TAB', { raw: 'scope-journal', tabId: 't1' }),
        };
      }),
    ]);
    const cid = cidOf(16);
    const waiting = rigState.terminalOf(cid);
    rigState.dispatcher.dispatch(envelope('RepairRebuild', 'command', { scope: 'all' }, cid), ZONE);
    const terminal = await waiting;
    expect(terminal.result.ok).toBe(false);
    if (!terminal.result.ok) {
      expect(terminal.result.error.code).toBe('E_NOT_FOUND_TAB');
      expect(terminal.result.error.details?.['raw']).toBeUndefined();
      expect(terminal.result.error.details?.['operation']).toBe('command:RepairRebuild');
    }
  });

  it('maintenance lane sheds under pressure while interactive is untouched', async () => {
    const gate = deferred<string>();
    const rigState = rig([
      commandOf(
        'RepairRebuild',
        async () => {
          await gate.promise;
          return ok({});
        },
        { lane: 'maintenance' },
      ),
      commandOf('RescueScanNow', async () => ok({ reportId: 'r' }), { lane: 'maintenance' }),
      commandOf('ParkTab', async () => ok({ kept: 'x' })),
    ]);
    const cidBusy = cidOf(17);
    const cidShed = cidOf(18);
    const cidInteractive = cidOf(19);
    const busyTerminal = rigState.terminalOf(cidBusy);
    rigState.dispatcher.dispatch(
      envelope('RepairRebuild', 'command', { scope: 'all' }, cidBusy),
      ZONE,
    );
    await flush();
    const shed = rigState.terminalOf(cidShed);
    rigState.dispatcher.dispatch(
      envelope('RescueScanNow', 'command', { mode: 'tail' }, cidShed),
      ZONE,
    );
    // interactive proceeds while maintenance is saturated
    const okInteractive = rigState.terminalOf(cidInteractive);
    rigState.dispatcher.dispatch(
      envelope('ParkTab', 'command', { browserTabId: 1 }, cidInteractive),
      ZONE,
    );
    const shedTerminal = await shed;
    expect(shedTerminal.result.ok).toBe(false);
    if (!shedTerminal.result.ok) expect(shedTerminal.result.error.code).toBe('E_RATE_LANESHED');
    expect((await okInteractive).result.ok).toBe(true);
    gate.resolve('unblock');
    await busyTerminal;
  });

  it('exactly-one-terminal even when the handler notified pending before throwing', async () => {
    const rigState = rig([
      commandOf('ParkAll', async (ctx) => {
        ctx.notifyPending('I9');
        throw new TypeError('boom');
      }),
    ]);
    const cid = cidOf(20);
    const waiting = rigState.terminalOf(cid);
    rigState.dispatcher.dispatch(envelope('ParkAll', 'command', {}, cid), ZONE);
    await waiting;
    expect(
      rigState.events.filter((e) => e.type === 'command-applied' || e.type === 'command-failed'),
    ).toHaveLength(1);
  });

  it('queries ride the interactive lane regardless and are answerable via terminalOf', async () => {
    const rigState = rig(
      [],
      [queryOf('GetHealth', async (ctx) => ok({ probes: [], ctx: ctx.message.senderContext }))],
    );
    const cid = cidOf(21);
    const waiting = rigState.terminalOf(cid);
    rigState.dispatcher.dispatch(envelope('GetHealth', 'query', {}, cid), ZONE);
    const terminal = await waiting;
    expect(terminal.lane).toBe('interactive');
    expect(terminal.result.ok).toBe(true);
    expect(rigState.sink.entries()[0]?.kind).toBe('query');
  });
});
