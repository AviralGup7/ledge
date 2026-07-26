// E4-FIX-01 · Boundary-validator self-pin (audit F2). The fake transport validates
// every send against the frozen registry at the boundary; this suite proves the
// ratchet itself can never rot green-by-absence — a validator that stops throwing
// fails HERE.
import { describe, expect, it } from 'vitest';
import { CONTRACT_V } from '@/application/contracts/index.js';
import { createFakeTransport, type SentEnvelope } from './fake-transport.js';

const envelope = (over: Partial<SentEnvelope>): SentEnvelope => ({
  v: CONTRACT_V,
  kind: 'command',
  name: 'ParkTab',
  cid: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  senderContext: 'guardian',
  payload: { browserTabId: 11 },
  contractHash: 'test-hash',
  ...over,
});

describe('E4 testkit · boundary validator (every send is registry-checked, fail-fast)', () => {
  it('a spec-honest envelope passes silently (recorded, acked)', async () => {
    const fake = createFakeTransport();
    const ack = await fake.transport.send(envelope({}));
    expect(ack).toEqual({ outcome: 'ack' });
    expect(fake.lastOf('ParkTab').payload).toEqual({ browserTabId: 11 });
  });

  it('a payload that violates the registry shape throws synchronously, naming the spec failure', () => {
    const fake = createFakeTransport();
    // ResumeMission without required mode — the exact E4-era trap class.
    const bad = envelope({
      name: 'ResumeMission',
      payload: { missionId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
    });
    expect(() => fake.transport.send(bad)).toThrowError(/ResumeMission.*registry spec/);
  });

  it('wire-kind parity is enforced (a command sent as a query throws)', () => {
    const fake = createFakeTransport();
    expect(() => fake.transport.send(envelope({ kind: 'query' }))).toThrowError(
      /ParkTab.*registry declares 'command'/,
    );
  });

  it('an unknown name throws; a served internal Tier-2 name passes', async () => {
    const fake = createFakeTransport();
    expect(() => fake.transport.send(envelope({ name: 'TeleportTabs' }))).toThrowError(
      /TeleportTabs.*neither a v1 registry name nor a served internal name/,
    );
    const internal = envelope({
      name: 'OpenTabs',
      payload: { tabIds: ['01ARZ3NDEKTSV4RRFFQ69G5FAV'] },
    });
    await expect(fake.transport.send(internal)).resolves.toEqual({ outcome: 'ack' });
  });

  it('a senderContext outside the frozen enum throws', () => {
    const fake = createFakeTransport();
    expect(() => fake.transport.send(envelope({ senderContext: 'sidepanel' }))).toThrowError(
      /senderContext 'sidepanel'/,
    );
  });
});
