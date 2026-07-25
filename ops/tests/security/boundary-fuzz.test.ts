// E1-T11 · EES §8 security lane — boundary validator fuzz (PR-blocking).
// Laws proven, not commented: (1) TOTAL — validators never throw on any input, always
// return an explicit outcome; (2) every rejection carries a catalog error code with the
// §3.2 envelope; (3) an 'ok' payload's normalized form re-validates (strip idempotence);
// (4) no prototype pollution — '__proto__' keys never survive normalization;
// (5) the Zone-1 gate holds universally: with an empty v1 allowlist, NOTHING from a
// consented page context validates (ADR-010's "high-trust never from content contexts").
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@/shared-kernel/result/error-codes.catalog.js';
import {
  MESSAGE_REGISTRY,
  checkHello,
  validateMessage,
  type ValidationOutcome,
} from '@/application/contracts/index.js';

const CID = '00000000000000000000000001';
const KNOWN_NAMES = Object.keys(MESSAGE_REGISTRY);
const CONTEXTS = ['guardian', 'overlay', 'quiet', 'offscreen', 'sw'];
const KINDS = ['command', 'query', 'event', 'stream'];

/** Hostile-but-plausible envelope: every field optional, values from the full JSON space. */
const arbNearEnvelope = fc.record(
  {
    v: fc.oneof(fc.integer({ min: -1, max: 3 }), fc.string()),
    kind: fc.oneof(fc.constantFrom(...KINDS), fc.string()),
    name: fc.oneof(fc.constantFrom(...KNOWN_NAMES), fc.string()),
    cid: fc.oneof(fc.constant(CID), fc.string(), fc.integer({ min: 0, max: 9 })),
    senderContext: fc.oneof(fc.constantFrom(...CONTEXTS), fc.string()),
    payload: fc.anything(),
    contractHash: fc.oneof(fc.constant('testhash'), fc.string(), fc.integer({ min: 0, max: 9 })),
  },
  { requiredKeys: [] },
);

const OUTCOMES = ['ok', 'ignored', 'rejected'] as const;

const assertOutcomeHealthy = (r: ValidationOutcome): void => {
  expect(OUTCOMES).toContain(r.type);
  if (r.type === 'rejected') {
    const e = r.error;
    expect((ERROR_CODES as readonly string[]).includes(e.code)).toBe(true);
    expect(typeof e.retryable).toBe('boolean');
    expect(e.messageKey.startsWith('msg.')).toBe(true);
    expect(e.recoveryKey.startsWith('msg.recover.')).toBe(true);
  }
};

describe('boundary validator fuzz (EES §8 security)', () => {
  it('validateMessage is total over the full JSON value space', () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        const r = validateMessage(raw, { zone: 'zone0' });
        assertOutcomeHealthy(r);
      }),
    );
  });

  it('validateMessage is total over hostile near-envelopes', () => {
    fc.assert(
      fc.property(arbNearEnvelope, (raw) => {
        const r = validateMessage(raw, { zone: 'zone0' });
        assertOutcomeHealthy(r);
        if (r.type === 'ok') {
          // Strip law idempotence: normalized payload re-validates as-is.
          const again = validateMessage(
            {
              v: 1,
              kind: r.message.kind,
              name: r.message.name,
              cid: r.message.cid,
              senderContext: r.message.senderContext,
              payload: r.message.payload,
              contractHash: 'testhash',
            },
            { zone: 'zone0' },
          );
          expect(again.type).toBe('ok');
          if (again.type === 'ok') expect(again.message.payload).toEqual(r.message.payload);
          // No '__proto__' key ever survives normalization.
          expect(Object.keys(r.message.payload)).not.toContain('__proto__');
        }
      }),
    );
  });

  it('Zone-1 universal law: nothing validates from a page context while the allowlist is empty', () => {
    expect(
      validateMessage(
        {
          v: 1,
          kind: 'command',
          name: 'ParkTab',
          cid: CID,
          senderContext: 'quiet',
          payload: { browserTabId: 1 },
          contractHash: 'h',
        },
        { zone: 'zone1' },
      ).type,
    ).not.toBe('ok'); // seed case explicit
    fc.assert(
      fc.property(arbNearEnvelope, (raw) => {
        const r = validateMessage(raw, { zone: 'zone1' });
        expect(r.type).not.toBe('ok');
        assertOutcomeHealthy(r);
      }),
    );
  });

  it('prototype pollution never escapes validation', () => {
    const hostile = {
      v: 1,
      kind: 'command',
      name: 'ParkTab',
      cid: CID,
      senderContext: 'quiet',
      payload: JSON.parse('{ "__proto__": { "polluted": true }, "browserTabId": 3 }'),
      contractHash: 'h',
    };
    const r = validateMessage(hostile, { zone: 'zone0' });
    expect(r.type).toBe('ok');
    if (r.type === 'ok') {
      expect(Object.keys(r.message.payload)).toEqual(['browserTabId']);
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    }
    fc.assert(
      fc.property(arbNearEnvelope, (raw) => {
        validateMessage(raw, { zone: 'zone0' });
        expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
      }),
    );
  });

  it('checkHello is total over the full value space', () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        const r = checkHello(raw, { contractHash: 'local' });
        expect(['compatible', 'schema-mismatch', 'rejected']).toContain(r.status);
      }),
    );
  });
});
