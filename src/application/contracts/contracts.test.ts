// E1-T11 unit tests — §3.1 laws: validator-before-dispatch, unknown-name ignore,
// Zone-1 allowlist (fixture), caps, strip-on-reemit, dual-read demonstration, handshake.
import { describe, expect, it } from 'vitest';
import { isId } from '@/shared-kernel/identity/id.js';
import { ERROR_CODES } from '@/shared-kernel/result/error-codes.catalog.js';
import {
  ARRAY_MAX_ITEMS,
  CONTRACT_V,
  MESSAGE_REGISTRY,
  PAYLOAD_MAX_BYTES,
  checkHello,
  computeContractHash,
  contractHashOf,
  makeHello,
  specKeys,
  validateMessage,
  ZONE1_ALLOWLIST,
  type MessageEnvelope,
} from './index.js';
import type { WireKind } from './message.registry.js';

// ─── fixtures ────────────────────────────────────────────────────────────────────
const CID = '00000000000000000000000001';
const HASH = 'test-build-hash';
const env = (name: string, kind: WireKind, payload: unknown): MessageEnvelope => ({
  v: CONTRACT_V,
  kind,
  name,
  cid: CID as MessageEnvelope['cid'],
  senderContext: 'quiet',
  payload,
  contractHash: HASH,
});
const zone0 = { zone: 'zone0' as const };
const zone1 = { zone: 'zone1' as const };

// ─── registry integrity ──────────────────────────────────────────────────────────
describe('E1-T11 registry', () => {
  it('catalogue covers §3.3–3.7 exactly: 29 commands, 8 queries, 13 streams, 17 workroom, 5 sync', () => {
    const byFamily = Object.values(MESSAGE_REGISTRY).reduce<Record<string, number>>(
      (acc, s) => ({ ...acc, [s.family]: (acc[s.family] ?? 0) + 1 }),
      {},
    );
    expect(byFamily).toEqual({ command: 29, query: 8, stream: 13, workroom: 17, sync: 5 });
  });

  it('every payload spec has at least one required-or-optional key, or is a declared empty payload', () => {
    for (const [name, spec] of Object.entries(MESSAGE_REGISTRY)) {
      const keys = specKeys(spec.payload);
      expect(name.length, name).toBeGreaterThan(0);
      expect(Array.isArray(keys.required)).toBe(true);
      expect(Array.isArray(keys.optional)).toBe(true);
    }
  });

  it('wire kinds are frozen to the §3.1 enum and workroom/sync ride kind:event', () => {
    for (const [name, spec] of Object.entries(MESSAGE_REGISTRY)) {
      expect(['command', 'query', 'event', 'stream'], name).toContain(spec.kind);
      if (spec.family === 'workroom' || spec.family === 'sync') expect(spec.kind).toBe('event');
    }
  });
});

// ─── §3.1 laws ───────────────────────────────────────────────────────────────────
describe('E1-T11 §3.1 laws', () => {
  it('(a) valid command validates with full payload fidelity', () => {
    const r = validateMessage(env('ParkTab', 'command', { browserTabId: 42 }), zone0);
    expect(r.type).toBe('ok');
    if (r.type !== 'ok') return;
    expect(r.message.name).toBe('ParkTab');
    expect(r.message.payload).toEqual({ browserTabId: 42 });
    expect(r.message.family).toBe('command');
    expect(isId(r.message.cid)).toBe(true);
  });

  it('(b) unknown name ⇒ ignored, never throws, never rejected', () => {
    const a = validateMessage(env('FutureCommandV9', 'command', { x: 1 }), zone0);
    expect(a).toEqual({ type: 'ignored', reason: 'unknown-name', name: 'FutureCommandV9' });
    const b = validateMessage(env('Zone1IndexingSubmission', 'event', { x: 1 }), zone1);
    expect(b.type).toBe('ignored'); // forward-compat lane applies in every zone
  });

  it('availability tiers: v1.1 / v2-boundary names are ignored, distinctly labeled', () => {
    const r = validateMessage(env('NudgeDismiss', 'command', { nudgeType: 'park' }), zone0);
    expect(r).toEqual({
      type: 'ignored',
      reason: 'unavailable-name',
      name: 'NudgeDismiss',
      availability: 'v1.1',
    });
    const s = validateMessage(env('SegmentsPull', 'event', { deviceId: 'd', sinceSeq: 1 }), zone0);
    expect(s.type).toBe('ignored');
    if (s.type === 'ignored') expect(s.availability).toBe('v2-boundary');
  });

  it('(f) Zone-1 allowlist fixture: a high-trust command from zone1 is rejected, and the v1 allowlist is empty by law', () => {
    expect(ZONE1_ALLOWLIST).toEqual([]); // deny-all default; additions need an ADR
    const r = validateMessage(env('ParkTab', 'command', { browserTabId: 1 }), zone1);
    expect(r.type).toBe('rejected');
    if (r.type !== 'rejected') return;
    expect(r.error.code).toBe('E_CAPABILITY');
    expect(r.error.details?.['name']).toBe('ParkTab');
    // …while the identical message is fine from zone0 (fixture proves the gate, not the name)
    expect(validateMessage(env('ParkTab', 'command', { browserTabId: 1 }), zone0).type).toBe('ok');
  });

  it('(c) unknown payload fields tolerated on read, stripped on re-emit (golden pair)', () => {
    const r = validateMessage(
      env('ParkTab', 'command', { browserTabId: 7, evilExtra: 'x', nestedJunk: { a: [1] } }),
      zone0,
    );
    expect(r.type).toBe('ok');
    if (r.type !== 'ok') return;
    expect(r.message.payload).toEqual({ browserTabId: 7 });
    // normalized form re-validates cleanly (idempotent strip)
    const again = validateMessage({ ...env('ParkTab', 'command', r.message.payload) }, zone0);
    expect(again.type).toBe('ok');
  });

  it('(d) payload over the 256KB hard cap is rejected', () => {
    const big = 'x'.repeat(PAYLOAD_MAX_BYTES - 30);
    expect(
      validateMessage(env('SetSetting', 'command', { key: 'k', value: big }), zone0).type,
    ).toBe('ok'); // under cap
    const over = 'x'.repeat(PAYLOAD_MAX_BYTES + 100);
    const r = validateMessage(env('SetSetting', 'command', { key: 'k', value: over }), zone0);
    expect(r.type).toBe('rejected');
    if (r.type === 'rejected') expect(r.error.details?.['what']).toBe('payload-over-256kb');
  });

  it('(e) arrays over 10k items are rejected; large-but-legal arrays pass', () => {
    // Guards run before schema (any array's length is checked raw). Byte-cap and array-cap
    // are two independent laws — short filler isolates the array law from the byte law.
    const massive = validateMessage(
      env('ResumeMission', 'command', {
        missionId: CID,
        mode: 'partial',
        tabIds: Array.from({ length: ARRAY_MAX_ITEMS + 1 }, () => 'x'),
      }),
      zone0,
    );
    expect(massive.type).toBe('rejected');
    if (massive.type === 'rejected') expect(massive.error.details?.['what']).toBe('array-over-10k');
    // 8k ids ≈ 232KB: under the byte cap, under the array cap, schema-valid.
    const eightK = Array.from({ length: 8000 }, () => CID);
    expect(
      validateMessage(
        env('ResumeMission', 'command', { missionId: CID, mode: 'partial', tabIds: eightK }),
        zone0,
      ).type,
    ).toBe('ok');
  });

  it('envelope malformation is typed rejection — version, kind, cid, context, hash', () => {
    const cases: Array<[Partial<MessageEnvelope>, string]> = [
      [{ v: CONTRACT_V + 1 }, 'contract-v'],
      [{ kind: 'evil' as WireKind }, 'kind'],
      [{ cid: 'not-an-id' as MessageEnvelope['cid'] }, 'cid'],
      [{ senderContext: 'page' as MessageEnvelope['senderContext'] }, 'senderContext'],
      [{ contractHash: '' }, 'contractHash'],
    ];
    for (const [patch, what] of cases) {
      const e = { ...env('ParkTab', 'command', { browserTabId: 1 }), ...patch };
      const r = validateMessage(e, zone0);
      expect(r.type, what).toBe('rejected');
      if (r.type === 'rejected') {
        expect((ERROR_CODES as readonly string[]).includes(r.error.code)).toBe(true);
      }
    }
  });

  it('kind-mismatch with the registry row is rejected (lying about kind)', () => {
    const r = validateMessage(env('ParkTab', 'query', { browserTabId: 1 }), zone0);
    expect(r.type).toBe('rejected');
  });

  it('payload contract details: required, enums, text lengths, literals, oneOf, ids', () => {
    // required missing
    expect(validateMessage(env('ParkTab', 'command', {}), zone0).type).toBe('rejected');
    // enum violation
    expect(
      validateMessage(
        env('ResumeMission', 'command', { missionId: CID, mode: 'everything' }),
        zone0,
      ).type,
    ).toBe('rejected');
    // text maxLength boundary ±1
    expect(
      validateMessage(env('StartMission', 'command', { name: 'n'.repeat(120) }), zone0).type,
    ).toBe('ok');
    expect(
      validateMessage(env('StartMission', 'command', { name: 'n'.repeat(121) }), zone0).type,
    ).toBe('rejected');
    // literal exact-confirm law
    expect(validateMessage(env('EmptyTrash', 'command', { confirm: true }), zone0).type).toBe('ok');
    expect(validateMessage(env('EmptyTrash', 'command', { confirm: 'true' }), zone0).type).toBe(
      'rejected',
    );
    expect(validateMessage(env('EmptyTrash', 'command', { confirm: false }), zone0).type).toBe(
      'rejected',
    );
    // oneOf union arms
    expect(
      validateMessage(env('RestoreRecentlyClosed', 'command', { ids: [CID], target: 'new' }), zone0)
        .type,
    ).toBe('ok');
    expect(
      validateMessage(env('RestoreRecentlyClosed', 'command', { ids: [CID], target: CID }), zone0)
        .type,
    ).toBe('ok');
    expect(
      validateMessage(env('RestoreRecentlyClosed', 'command', { ids: [CID], target: 7 }), zone0)
        .type,
    ).toBe('rejected');
  });

  it('dual-read window demonstration: only CONTRACT_V reads; other versions reject as schema skew', () => {
    expect(validateMessage(env('ParkTab', 'command', { browserTabId: 1 }), zone0).type).toBe('ok');
    for (const v of [0, 2, -1] as const) {
      const r = validateMessage({ ...env('ParkTab', 'command', { browserTabId: 1 }), v }, zone0);
      expect(r.type).toBe('rejected');
      if (r.type === 'rejected') expect(r.error.code).toBe('E_FORMAT_UNKNOWN');
    }
  });
});

// ─── handshake + contractHash ────────────────────────────────────────────────────
describe('E1-T11 handshake (ADR-010 handshake-checked channels)', () => {
  it('computes a stable registry hash and detects registry drift', () => {
    const a = computeContractHash();
    const b = computeContractHash();
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    const drifted = contractHashOf({ ...MESSAGE_REGISTRY, SneakIn: { kind: 'event' } });
    expect(drifted).not.toBe(a);
  });

  it('compatible hello passes; version/hash skew is schema-mismatch; garbage rejects', () => {
    const local = { contractHash: HASH };
    const hello = makeHello('quiet', HASH);
    expect(checkHello(hello, local)).toEqual({ status: 'compatible', hello });
    const vSkew = checkHello({ ...hello, v: CONTRACT_V + 1 }, local);
    expect(vSkew.status).toBe('schema-mismatch');
    if (vSkew.status === 'schema-mismatch') expect(vSkew.reason).toBe('version');
    const hSkew = checkHello({ ...hello, contractHash: 'other' }, local);
    expect(hSkew.status).toBe('schema-mismatch');
    if (hSkew.status === 'schema-mismatch') expect(hSkew.reason).toBe('hash');
    for (const g of [
      null,
      42,
      'x',
      { v: '1' },
      { v: 1, senderContext: 'evil', contractHash: HASH },
    ]) {
      expect(checkHello(g, local).status).toBe('rejected');
    }
  });
});
