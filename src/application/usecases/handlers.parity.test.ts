// E3-APP · Closed-world parity law (EES §2.6/§3.3, ADR-010/033). The contracts
// registry freezes which wire names EXIST; the handler registries record which names
// this build SERVES. Both directions are CI-gated here: a v1 command/query name
// without a handler is red; a handler without a contracts name is red. Tier-2 internal
// commands (Spec §5.12 redo, activity/history, favorites/pin/topic) never ride the wire
// — they are served by a disjoint internal registry parity-checked against the
// code-declared catalog below, and wire ∩ internal = ∅.
import { describe, expect, it } from 'vitest';
import { MESSAGE_REGISTRY } from '../contracts/message.registry.js';
import {
  INTERNAL_COMMANDS,
  INTERNAL_QUERIES,
  WIRE_COMMANDS,
  WIRE_QUERIES,
} from './handlers.js';

const v1Names = (kind: 'command' | 'query'): readonly string[] =>
  Object.entries(MESSAGE_REGISTRY)
    .filter(([, spec]) => spec.kind === kind && spec.availability === 'v1')
    .map(([name]) => name)
    .sort();

const INTERNAL_COMMAND_CATALOG: readonly string[] = [
  'OpenTabs',
  'CloseTabs',
  'Redo',
  'CorrectTopic',
  'SetFavorite',
  'SetPinned',
];
const INTERNAL_QUERY_CATALOG: readonly string[] = ['GetActivity', 'GetHistory'];

/** §3.3 notes law: confirm-gated / irreversible / §10-R9 ambiguity commands. */
const NEVER_AUTO_RETRY_WIRE: readonly string[] = [
  'MergeMissions', // C11 confirm-gated
  'DeleteEntity', // C15 irreversible-class
  'EmptyTrash', // C17 irreversible
  'Undo', // C18 + §10-R9 ambiguity law
  'ForgetEverything', // C25 irreversible
];
/** §2.6 hub law: heavy sweeps ride the maintenance lane. */
const MAINTENANCE_LANE_WIRE: readonly string[] = ['RescueScanNow'];

const names = (registrations: readonly { readonly name: string }[]): readonly string[] =>
  registrations.map((r) => r.name);

describe('E3-APP parity law — wire commands (closed world both ways)', () => {
  it('every v1 command name in contracts is served by exactly one handler', () => {
    expect(names(WIRE_COMMANDS).slice().sort()).toEqual(v1Names('command'));
  });

  it('every wire handler name exists in contracts as a v1 command', () => {
    for (const name of names(WIRE_COMMANDS)) {
      const spec = MESSAGE_REGISTRY[name];
      expect(spec, `handler serves unknown wire command "${name}"`).toBeDefined();
      expect(spec?.kind).toBe('command');
      expect(spec?.availability).toBe('v1');
    }
  });
});

describe('E3-APP parity law — wire queries (closed world both ways)', () => {
  it('every v1 query name in contracts is served by exactly one handler', () => {
    expect(names(WIRE_QUERIES).slice().sort()).toEqual(v1Names('query'));
  });

  it('every wire query handler name exists in contracts as a v1 query', () => {
    for (const name of names(WIRE_QUERIES)) {
      const spec = MESSAGE_REGISTRY[name];
      expect(spec, `handler serves unknown wire query "${name}"`).toBeDefined();
      expect(spec?.kind).toBe('query');
      expect(spec?.availability).toBe('v1');
    }
  });
});

describe('E3-APP parity law — internal registries (Tier-2; never on the wire)', () => {
  it('internal commands ⇔ declared catalog', () => {
    expect(names(INTERNAL_COMMANDS).slice().sort()).toEqual(
      INTERNAL_COMMAND_CATALOG.slice().sort(),
    );
  });

  it('internal queries ⇔ declared catalog', () => {
    expect(names(INTERNAL_QUERIES).slice().sort()).toEqual(
      INTERNAL_QUERY_CATALOG.slice().sort(),
    );
  });

  it('wire ∩ internal = ∅ (no internal name ever leaks onto the wire)', () => {
    const wire = new Set([...names(WIRE_COMMANDS), ...names(WIRE_QUERIES)]);
    for (const name of [...names(INTERNAL_COMMANDS), ...names(INTERNAL_QUERIES)]) {
      expect(wire.has(name), `internal name "${name}" collides with a wire name`).toBe(false);
    }
    for (const internal of [...INTERNAL_COMMAND_CATALOG, ...INTERNAL_QUERY_CATALOG]) {
      expect(MESSAGE_REGISTRY[internal], `internal name "${internal}" leaked into contracts`).toBe(
        undefined,
      );
    }
  });
});

describe('E3-APP parity law — lanes and retry classes (§2.6/§3.3)', () => {
  it('neverAutoRetry classes match the §3.3 notes exactly', () => {
    const wire = WIRE_COMMANDS.filter((r) => r.neverAutoRetry === true).map((r) => r.name);
    expect(wire.slice().sort()).toEqual(NEVER_AUTO_RETRY_WIRE.slice().sort());
    const internal = INTERNAL_COMMANDS.filter((r) => r.neverAutoRetry === true).map(
      (r) => r.name,
    );
    expect(internal).toEqual(['Redo']);
  });

  it('maintenance lane is the closed sweep set; everything else is interactive-default', () => {
    const maintenance = WIRE_COMMANDS.filter((r) => r.lane !== undefined).map((r) => r.name);
    expect(maintenance.slice().sort()).toEqual(MAINTENANCE_LANE_WIRE.slice().sort());
    for (const registration of WIRE_COMMANDS) {
      if (MAINTENANCE_LANE_WIRE.includes(registration.name)) {
        expect(registration.lane).toBe('maintenance');
      } else {
        expect(registration.lane ?? 'interactive').toBe('interactive');
      }
    }
  });

  it('registration names are unique within each registry', () => {
    const seen = new Set<string>();
    for (const name of [
      ...names(WIRE_COMMANDS),
      ...names(WIRE_QUERIES),
      ...names(INTERNAL_COMMANDS),
      ...names(INTERNAL_QUERIES),
    ]) {
      expect(seen.has(name), `duplicate registration "${name}"`).toBe(false);
      seen.add(name);
    }
  });
});
