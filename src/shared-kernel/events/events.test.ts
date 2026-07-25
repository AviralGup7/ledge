// E1-T07 · completion criteria: registry fixtures + upcast goldens + unknown-type passthrough.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  auditUpcastChain,
  EVENT_REGISTRY,
  isKnownEventType,
  upcastEvent,
  validatePayload,
  type StoredEvent,
} from './index.js';

interface Fixture {
  name: string;
  expect: 'current' | 'upcasted' | 'preserved-unknown' | 'error';
  errorCode?: string;
  stored: StoredEvent;
}
const fixtures = (
  JSON.parse(readFileSync('ops/fixtures/events/events.golden.json', 'utf8')) as {
    fixtures: Fixture[];
  }
).fixtures;

describe('E1-T07 registry completeness (EES §4 table)', () => {
  it('declares exactly the 31 concrete v1 types of the locked event table', () => {
    expect(Object.keys(EVENT_REGISTRY)).toHaveLength(31);
  });

  it('every row is schemaV:1 with producer, consumers and a field table', () => {
    for (const [type, spec] of Object.entries(EVENT_REGISTRY)) {
      expect(spec.schemaV, type).toBe(1);
      expect(spec.producer.length, type).toBeGreaterThan(0);
      expect(spec.consumers.length, type).toBeGreaterThan(0);
      expect(Object.keys(spec.fields).length, type).toBeGreaterThan(0);
    }
  });

  it('v2-reserved types are deliberately absent (frozen at Tier-4 harness)', () => {
    for (const reserved of ['RuleCreated', 'RemoteEventsApplied', 'DeviceRegistered']) {
      expect(isKnownEventType(reserved), reserved).toBe(false);
    }
  });

  it('registry self-audit: v1 chain has zero upcast gaps', () => {
    expect(auditUpcastChain()).toEqual({ ok: true, value: [] });
  });
});

describe('E1-T07 golden fixtures (ops/fixtures/events)', () => {
  for (const f of fixtures) {
    it(`[${f.expect}] ${f.name}`, () => {
      const outcome = upcastEvent(f.stored);
      if (f.expect === 'error') {
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.error.code).toBe(f.errorCode);
        return;
      }
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.value.status).toBe(f.expect);
      if (f.expect === 'preserved-unknown' && outcome.value.status === 'preserved-unknown') {
        // Passthrough law: raw bytes come back untouched (nothing stripped, nothing invented).
        expect(outcome.value.raw).toBe(f.stored);
      }
    });
  }
});

describe('E1-T07 forward tolerance spot-checks (ADR-033)', () => {
  it('unknown extra fields are preserved by validation (never stripped)', () => {
    const r = validatePayload('TabUpdated', {
      ledgeTabId: '01J2C0N0000000000000000002',
      changes: { title: 'x' },
      inventedInV2: 'keep me',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value['inventedInV2']).toBe('keep me');
  });

  it('unknown type id validates as E_FORMAT_UNKNOWN when payload-validated directly', () => {
    const r = validatePayload('Nope', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('E_FORMAT_UNKNOWN');
  });
});
