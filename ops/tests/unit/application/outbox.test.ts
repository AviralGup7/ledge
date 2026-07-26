// E3-APP · Outbox law suite — wire-shape proof at the ONLY publish point.
import { describe, expect, it } from 'vitest';
import { createAppEventBus } from '@/application/hub/dispatch/app-events.js';
import { createOutbox, type WireStreamMessage } from '@/application/hub/outbox/index.js';
import { ledgeError } from '@/shared-kernel/result/index.js';
import { testId } from '@/infrastructure/journal/core/testkit.js';
import type { DeviceId } from '@/shared-kernel/identity/index.js';

/** Positioned frame marker (watermark scalar is a seq under the hood). */
const DEV_A_MARK = testId(66_000) as DeviceId;

const FLUSH_ROUNDS = 4;
const flush = async (): Promise<void> => {
  for (let i = 0; i < FLUSH_ROUNDS; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
};

const HB = { keptCount: 3, liveRecoverable: 7, asOf: 1_785_700_000_000 };

const makeOutbox = (
  heartbeatResult: () => Promise<{ ok: true; value: typeof HB } | { ok: false }> = () =>
    Promise.resolve({ ok: true, value: HB }),
) => {
  const bus = createAppEventBus();
  const published: WireStreamMessage[] = [];
  let heartbeatCalls = 0;
  const outbox = createOutbox({
    bus,
    publish: (m) => published.push(m),
    heartbeat: () => {
      heartbeatCalls += 1;
      return heartbeatResult();
    },
    now: () => 1_785_700_000_999,
  });
  const stop = outbox.start();
  return {
    bus,
    outbox,
    stop,
    published,
    heartbeatCalls: () => heartbeatCalls,
    names: () => published.map((m) => m.name),
  };
};

describe('E3-APP outbox — wire-shape proof at the ONLY publish point', () => {
  it('CommandAck rides only for canonical intent ids (two-phase law §3.5)', () => {
    const h = makeOutbox();
    h.bus.publish({
      type: 'command-ack',
      cid: testId(70_001),
      command: 'ParkTab',
      intentId: testId(70_002),
    });
    const ack = h.published.find((m) => m.name === 'CommandAck');
    expect(ack?.payload).toEqual({
      cid: testId(70_001),
      intentId: testId(70_002),
      state: 'accepted-pending',
    });

    // Synthetic family tokens (resume style) never reach the wire.
    const before = h.published.length;
    h.bus.publish({
      type: 'command-ack',
      cid: testId(70_003),
      command: 'ResumeMission',
      intentId: 'ResumeMission:some-mission',
    });
    expect(h.published.length).toBe(before);
  });

  it('command-applied emits CommandApplied (+ImportReady) and a POST-Applied heartbeat', async () => {
    const h = makeOutbox();
    h.bus.publish({
      type: 'command-applied',
      cid: testId(70_010),
      command: 'ImportPreviewRequest',
      result: { previewId: testId(70_011) },
    });
    await flush();
    const names = h.names();
    expect(names).toContain('CommandApplied');
    expect(names).toContain('ImportReady');
    expect(names).toContain('HeartbeatUpdate');
    // R10: the heartbeat computation is post-Applied — publish order proves it.
    expect(names.indexOf('CommandApplied')).toBeLessThan(names.lastIndexOf('HeartbeatUpdate'));
    const hb = h.published.findLast((m) => m.name === 'HeartbeatUpdate');
    expect(hb?.payload).toEqual({ keptCount: 3, liveRecoverable: 7, asOf: HB.asOf });
  });

  it('heartbeat recomputes coalesce: a burst costs one in-flight + one trailing scan', async () => {
    const h = makeOutbox();
    for (let i = 0; i < 5; i += 1) {
      h.bus.publish({
        type: 'command-applied',
        cid: testId(70_020 + i),
        command: 'RenameMission',
        result: {},
      });
    }
    await flush();
    expect(h.heartbeatCalls()).toBe(2); // 1 leader + 1 trailing (never 5 stampedes)
    const heartbeats = h.published.filter((m) => m.name === 'HeartbeatUpdate').length;
    expect(heartbeats).toBeGreaterThanOrEqual(1);
    expect(heartbeats).toBeLessThanOrEqual(2);
  });

  it('failed rides the flat §3.2 envelope; cancelled has no v1 wire carrier', () => {
    const h = makeOutbox();
    h.bus.publish({
      type: 'command-failed',
      cid: testId(70_030),
      command: 'ParkTab',
      error: ledgeError('E_DOMAIN_LEGALITY', { operation: 'park', reason: 'x' }),
    });
    const failed = h.published.find((m) => m.name === 'CommandFailed');
    expect((failed?.payload['error'] as { code: string }).code).toBe('E_DOMAIN_LEGALITY');
    expect(typeof (failed?.payload['error'] as { messageKey: string }).messageKey).toBe('string');
    const before = h.published.length;
    h.bus.publish({ type: 'command-cancelled', cid: testId(70_031), command: 'ParkTab' });
    expect(h.published.length).toBe(before);
  });

  it('validation failure drops into the sink — no malformed byte ever publishes', () => {
    const h = makeOutbox();
    // Watermark string (not number) ⇒ the frozen ViewDelta spec refuses it.
    h.bus.publish({
      type: 'view-delta',
      view: 'missions',
      watermark: 'NaN-ish' as unknown as number,
      ops: [],
    });
    expect(h.names()).not.toContain('ViewDelta');
    expect(h.outbox.drops().length).toBeGreaterThan(0);
  });
});

describe('E3-APP outbox — view deltas + resync + progress families', () => {
  it('ViewDelta clamps ops to the frozen max (500) and publishes per-view', () => {
    const h = makeOutbox();
    const ops = Array.from({ length: 620 }, (_, i) => ({
      kind: 'upsert' as const,
      key: `k${i}`,
      record: {},
    }));
    h.outbox.onDelta({
      view: 'missions',
      watermark: { deviceId: DEV_A_MARK, seq: 9, batchIndex: 0 },
      ops,
    });
    const delta = h.published.find((m) => m.name === 'ViewDelta');
    expect((delta?.payload['ops'] as readonly unknown[]).length).toBe(500);
    expect(delta?.payload['view']).toBe('missions');
    expect(delta?.payload['watermark']).toBe(9);
  });

  it('watermark regression per view emits ResyncRequired{schema} exactly at the regression', () => {
    const h = makeOutbox();
    h.outbox.onDelta({
      view: 'missions',
      watermark: { deviceId: DEV_A_MARK, seq: 10, batchIndex: 0 },
      ops: [],
    });
    h.outbox.onDelta({
      view: 'missions',
      watermark: { deviceId: DEV_A_MARK, seq: 4, batchIndex: 0 },
      ops: [],
    }); // rebuild replay
    h.outbox.onDelta({
      view: 'missions',
      watermark: { deviceId: DEV_A_MARK, seq: 5, batchIndex: 0 },
      ops: [],
    }); // steady again
    const resyncs = h.published.filter((m) => m.name === 'ResyncRequired');
    expect(resyncs.length).toBe(1);
    expect(resyncs[0]?.payload).toEqual({ reason: 'schema' });
  });

  it('progress maps to family streams only with canonical refs (registry purity)', () => {
    const h = makeOutbox();
    h.bus.publish({
      type: 'progress',
      event: { cid: testId(70_040), command: 'ImportCommit', stage: 4, ref: testId(70_041) },
    });
    const progress = h.published.find((m) => m.name === 'ImportProgress');
    expect(progress?.payload['previewId']).toBe(testId(70_041));
    expect((progress?.payload['progress'] as { stage: number }).stage).toBe(4);

    const before = h.published.length;
    h.bus.publish({
      type: 'progress',
      event: { cid: testId(70_042), command: 'ImportCommit', stage: 1 }, // no ref
    });
    h.bus.publish({
      type: 'progress',
      event: { cid: testId(70_043), command: 'ParkAll', stage: 10, ref: testId(70_044) }, // no family
    });
    expect(h.published.length).toBe(before);
  });

  it('ExportReady waits for the E5 fetch material (never half-emits)', () => {
    const h = makeOutbox();
    h.bus.publish({
      type: 'command-applied',
      cid: testId(70_050),
      command: 'ExportRequest',
      result: { exportId: testId(70_051) }, // plan-only: no fetchURL/manifest yet
    });
    expect(h.names()).not.toContain('ExportReady');
    h.bus.publish({
      type: 'command-applied',
      cid: testId(70_052),
      command: 'ExportRequest',
      result: { fetchURL: 'blob:x', manifestId: 'm-1', chunkChecksums: ['c1'] },
    });
    const ready = h.published.find((m) => m.name === 'ExportReady');
    expect(ready?.payload['fetchURL']).toBe('blob:x');
  });
});
