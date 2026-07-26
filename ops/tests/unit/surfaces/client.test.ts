// E4 · Wire client suite — the surface's only channel to authority. Laws under test:
// §3.1 envelope shape out; two-phase R1 honesty (acknowledged-pending until Applied);
// exactly-one terminal; ack-rejection → terminal failure; ack≠terminal correlation;
// §3.5 stream routing/filtering; watermark bookkeeping; TTL sweep + PENDING_CAP
// eviction; dispose semantics (subscription detach, pending resolution).
import { describe, expect, it } from 'vitest';
import { computeContractHash } from '@/application/contracts/index.js';
import {
  createWireClient,
  type WireClient,
  WIRE_STREAMS,
} from '@/surfaces/components/session/client.js';
import {
  createClockEntropy,
  createFakeTransport,
  createTestEntropy,
  flush,
} from './fake-transport.js';

const ULID_SHAPE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

const makeClient = (
  context: 'guardian' | 'overlay' | 'quiet' = 'guardian',
  transport = createFakeTransport(),
): { client: WireClient; fake: ReturnType<typeof createFakeTransport> } => {
  const client = createWireClient({
    context,
    transport: transport.transport,
    entropy: createTestEntropy(),
  });
  return { client, fake: transport };
};

describe('E4 client · envelopes out', () => {
  it('commands ride the frozen envelope shape with context + contract hash', async () => {
    const { client, fake } = makeClient('guardian');
    const op = client.command('ParkTab', { browserTabId: 7 });
    const env = fake.lastOf('ParkTab');
    expect(env.v).toBe(1);
    expect(env.kind).toBe('command');
    expect(env.cid).toMatch(ULID_SHAPE);
    expect(env.cid).toBe(op.cid);
    expect(env.senderContext).toBe('guardian');
    expect(env.payload).toEqual({ browserTabId: 7 });
    expect(env.contractHash).toBe(computeContractHash());
    fake.apply(env.cid, { kept: 'k1' });
    await flush();
  });

  it('queries are kind:"query" and correlation ids are unique per send', () => {
    const { client, fake } = makeClient('overlay');
    const first = client.query('GetBootstrap', { surface: 'overlay' });
    const second = client.query('SearchQuery', { q: 'a' });
    expect(fake.sent[0]?.kind).toBe('query');
    expect(fake.sent[1]?.kind).toBe('query');
    expect(first.cid).not.toBe(second.cid);
    expect(fake.lastOf('GetBootstrap').payload).toEqual({ surface: 'overlay' });
  });

  it('an explicit contractHash overrides the computed one (dual-read seam)', () => {
    const fake = createFakeTransport();
    const client = createWireClient({
      context: 'quiet',
      transport: fake.transport,
      entropy: createTestEntropy(),
      contractHash: 'fixed-test-hash',
    });
    client.command('Undo', {});
    expect(fake.lastOf('Undo').contractHash).toBe('fixed-test-hash');
    expect(client.contractHash).toBe('fixed-test-hash');
  });
});

describe('E4 client · two-phase honesty (R1)', () => {
  it('ack resolves synchronously, terminal only via CommandApplied stream', async () => {
    const { client, fake } = makeClient();
    const op = client.command('ParkTab', { browserTabId: 1 });
    const ack = await op.ack;
    expect(ack).toEqual({ outcome: 'ack' });
    // Pending between ack and terminal — the no-optimistic-truth window (R1).
    expect(client.pending()).toHaveLength(1);
    expect(client.pending()[0]?.phase).toBe('sent');
    fake.apply(op.cid, { kept: 'k9' });
    const terminal = await op.terminal;
    expect(terminal).toEqual({ ok: true, value: { kept: 'k9' }, cancelled: false });
    expect(client.pending()).toHaveLength(0);
  });

  it('CommandAck moves the pending row to acknowledged and records intentId', async () => {
    const { client, fake } = makeClient();
    const op = client.command('ParkWindow', { windowId: 3 });
    await flush();
    fake.acknowledge(op.cid, 'intent-01');
    const [pending] = client.pending();
    expect(pending?.phase).toBe('acknowledged');
    expect(pending?.intentId).toBe('intent-01');
    fake.apply(op.cid);
    await op.terminal;
  });

  it('CommandFailed resolves the terminal with the wire error envelope', async () => {
    const { client, fake } = makeClient();
    const op = client.command('ParkAll', {});
    await flush();
    fake.fail(op.cid, {
      code: 'E_CAPABILITY',
      retryable: false,
      messageKey: 'msg.error.capability',
      recoveryKey: 'msg.recover.update',
    });
    const terminal = await op.terminal;
    expect(terminal.ok).toBe(false);
    if (!terminal.ok) {
      expect(terminal.error.code).toBe('E_CAPABILITY');
      expect(terminal.error.messageKey).toBe('msg.error.capability');
    }
  });

  it('a duplicate terminal for the same cid is a no-op (exactly-one stands)', async () => {
    const { client, fake } = makeClient();
    const op = client.command('Undo', {});
    await flush();
    fake.apply(op.cid, { undid: 'msg.undo.done' });
    fake.apply(op.cid, { undid: 'bogus' });
    const terminal = await op.terminal;
    expect(terminal.ok && terminal.value).toEqual({ undid: 'msg.undo.done' });
  });

  it('terminals for unknown cids are ignored (no cross-talk)', async () => {
    const { client, fake } = makeClient();
    const op = client.command('StartMission', { name: 'x' });
    await flush();
    fake.apply('01DIFFERENTCID000000000000');
    expect(client.pending()).toHaveLength(1);
    fake.apply(op.cid);
    await op.terminal;
  });
});

describe('E4 client · ack failure modes', () => {
  it('rejected ack resolves terminal failed with the dispatch error', async () => {
    const { client, fake } = makeClient();
    fake.respondWith(() => ({
      outcome: 'rejected',
      error: {
        code: 'E_SCHEMA',
        messageKey: 'msg.error.schema',
        recoveryKey: 'msg.recover.report',
      },
    }));
    const op = client.command('ParkTab', { browserTabId: 2 });
    const ack = await op.ack;
    expect(ack.outcome).toBe('rejected');
    const terminal = await op.terminal;
    expect(terminal.ok).toBe(false);
    if (!terminal.ok) expect(terminal.error.code).toBe('E_SCHEMA');
    expect(client.pending()).toHaveLength(0);
  });

  it('ignored ack resolves terminal failed with the output-malformed copy', async () => {
    const { client, fake } = makeClient();
    fake.respondWith(() => ({ outcome: 'ignored', reason: 'no service worker' }));
    const op = client.command('Undo', {});
    expect((await op.ack).outcome).toBe('ignored');
    const terminal = await op.terminal;
    expect(terminal.ok).toBe(false);
    if (!terminal.ok) expect(terminal.error.code).toBe('E_OUTPUT_MALFORMED');
  });

  it('transport unreachable resolves terminal failed with the capability copy', async () => {
    const { client, fake } = makeClient();
    fake.failNextSend();
    const op = client.command('StartMission', {});
    expect((await op.ack).outcome).toBe('unreachable');
    const terminal = await op.terminal;
    expect(terminal.ok).toBe(false);
    if (!terminal.ok) expect(terminal.error.code).toBe('E_CAPABILITY');
    expect(client.pending()).toHaveLength(0);
  });

  it('malformed ack payloads parse to unreachable (never a throw)', async () => {
    const { client, fake } = makeClient();
    fake.respondWith(() => 'garbage');
    const op = client.command('Undo', {});
    expect((await op.ack).outcome).toBe('unreachable');
    await op.terminal;
  });

  it('malformed wire errors degrade to E_FORMAT_UNKNOWN (never a throw)', async () => {
    const { client, fake } = makeClient();
    const op = client.command('Undo', {});
    await flush();
    fake.fail(op.cid, 'not-an-object');
    const terminal = await op.terminal;
    expect(terminal.ok).toBe(false);
    if (!terminal.ok) expect(terminal.error.code).toBe('E_FORMAT_UNKNOWN');
  });
});

describe('E4 client · stream routing & filtering', () => {
  it('subscribers receive only the 13 frozen stream names on the v1 stream kind', async () => {
    const { client, fake } = makeClient();
    const seen: string[] = [];
    const detach = client.subscribe({ onAny: (name) => seen.push(name) });
    fake.emitStream('HeartbeatUpdate', { keptCount: 2 });
    fake.emitStream('NotAStream', {});
    fake.emitRaw({ v: 999, kind: 'stream', name: 'HeartbeatUpdate', payload: {} });
    fake.emitRaw({ v: 1, kind: 'command', name: 'HeartbeatUpdate', payload: {} });
    fake.emitRaw('garbage');
    await flush();
    expect(seen).toEqual(['HeartbeatUpdate']);
    detach();
    fake.emitStream('HeartbeatUpdate', { keptCount: 3 });
    expect(seen).toHaveLength(1);
  });

  it('per-name handlers fire with payloads; every frozen name routes', async () => {
    const { client, fake } = makeClient();
    const seen = new Set<string>();
    const handlers = Object.fromEntries(
      WIRE_STREAMS.map((name) => [name, () => seen.add(name)]),
    ) as Parameters<WireClient['subscribe']>[0];
    client.subscribe(handlers);
    for (const name of WIRE_STREAMS) fake.emitStream(name, {});
    await flush();
    expect(seen.size).toBe(WIRE_STREAMS.length);
  });

  it('onAny fires alongside the specific handler', () => {
    const { client, fake } = makeClient();
    const order: string[] = [];
    client.subscribe({
      onAny: (name) => order.push(`any:${name}`),
      ViewDelta: () => order.push('specific:delta'),
    });
    fake.emitStream('ViewDelta', { view: 'missions', watermark: 1, ops: [] });
    expect(order).toEqual(['any:ViewDelta', 'specific:delta']);
  });
});

describe('E4 client · watermark bookkeeping (§3.5 gap law)', () => {
  it('first frame sets the base; +1 advances; equal is duplicate; jumps are gaps', () => {
    const { client } = makeClient();
    expect(client.noteWatermark('missions', 5)).toBe('ok');
    expect(client.noteWatermark('missions', 5)).toBe('duplicate');
    expect(client.noteWatermark('missions', 6)).toBe('ok');
    expect(client.noteWatermark('missions', 9)).toBe('gap');
    expect(client.noteWatermark('missions', 4)).toBe('gap'); // regression
    expect(client.watermarkOf('missions')).toBe(6);
  });

  it('views track independently; resetWatermarks re-bases after a rejoin', () => {
    const { client } = makeClient();
    expect(client.noteWatermark('missions', 3)).toBe('ok');
    expect(client.noteWatermark('tabs', 10)).toBe('ok');
    expect(client.watermarkOf('tabs')).toBe(10);
    client.resetWatermarks({ missions: 12 });
    expect(client.watermarkOf('missions')).toBe(12);
    expect(client.watermarkOf('tabs')).toBeUndefined();
  });
});

describe('E4 client · memory law & dispose', () => {
  it('pending ops older than the TTL fail-closed on the next send sweep', async () => {
    const fake = createFakeTransport();
    const { entropy, clock } = createClockEntropy();
    const client = createWireClient({ context: 'guardian', transport: fake.transport, entropy });
    const stale = client.command('ParkTab', { browserTabId: 1 });
    await flush();
    clock.advance(600_001);
    const fresh = client.command('Undo', {}); // the sweep happens on send
    const staleTerminal = await stale.terminal;
    expect(staleTerminal.ok).toBe(false);
    if (!staleTerminal.ok) expect(staleTerminal.error.code).toBe('E_DURABILITY_TIMEOUT');
    expect(client.pending().map((p) => p.cid)).toEqual([fresh.cid]);
    fake.apply(fresh.cid);
    await fresh.terminal;
  });

  it('the pending ledger is capped: oldest unsettled fails closed, newest is kept', async () => {
    const fake = createFakeTransport();
    const client = createWireClient({
      context: 'guardian',
      transport: fake.transport,
      entropy: createTestEntropy(),
    });
    const first = client.command('StartMission', {});
    for (let i = 0; i < 64; i += 1) client.command('Undo', {});
    const firstTerminal = await first.terminal;
    expect(firstTerminal.ok).toBe(false);
    expect(client.pending()).toHaveLength(64);
  });

  it('dispose resolves every pending op, detaches transport, silences streams', async () => {
    const fake = createFakeTransport();
    const client = createWireClient({
      context: 'guardian',
      transport: fake.transport,
      entropy: createTestEntropy(),
    });
    const op = client.command('ParkTab', { browserTabId: 4 });
    const seen: string[] = [];
    client.subscribe({ onAny: (name) => seen.push(name) });
    await flush();
    expect(fake.listenerCount()).toBe(1);
    client.dispose();
    const terminal = await op.terminal;
    expect(terminal.ok).toBe(false);
    expect(fake.listenerCount()).toBe(0);
    fake.emitStream('HeartbeatUpdate', { keptCount: 1 });
    expect(seen).toEqual([]);
    expect(client.pending()).toEqual([]);
  });
});
