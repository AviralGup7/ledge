// E4 · Contract compatibility suite — the load-bearing boundary proof. It scans the
// SURFACE SOURCE for every wire interaction and checks it against the frozen law:
//   · every client.command/query('Name') literal exists in MESSAGE_REGISTRY (v1) or
//     the Tier-2 internal roster served by the SW (handlers.js — imported, never
//     duplicated as literals)
//   · every literal PAYLOAD passed at those call sites validates against the
//     registry payload spec (no shape drift between surface and validator)
//   · every subscribe key + client-side WIRE_STREAMS entry is one of the 13 frozen
//     stream names in the registry
//   · sender contexts the surfaces stamp are inside the frozen SENDER_CONTEXTS enum
// A surface construct that drifts from the wire law fails CI HERE, at review time,
// never at runtime in a user profile.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MESSAGE_REGISTRY,
  SENDER_CONTEXTS,
  validateObject,
  type SchemaSpec,
} from '@/application/contracts/index.js';
import { INTERNAL_COMMANDS, INTERNAL_QUERIES } from '@/application/usecases/handlers.js';
import { WIRE_STREAMS } from '@/surfaces/components/session/client.js';

const GUARDIAN = readFileSync('src/surfaces/guardian/guardian.ts', 'utf8');
const OVERLAY = readFileSync('src/surfaces/overlay/overlay.ts', 'utf8');
const QUIET = readFileSync('src/surfaces/quiet-page/quiet.ts', 'utf8');
const CLIENT = readFileSync('src/surfaces/components/session/client.ts', 'utf8');
const SURFACE_SOURCES: Readonly<Record<string, string>> = {
  guardian: GUARDIAN,
  overlay: OVERLAY,
  quiet: QUIET,
};

// Direct client calls + the surfaces' thin wrappers (runCommand → client.command,
// loadQuery → client.query) — the wrappers are per-file plumbing, not a law seam.
const CALL_PATTERN = /(client\.command|client\.query|runCommand|loadQuery)\(\s*'([^']+)'/g;

interface WireCall {
  readonly surface: string;
  readonly kind: 'command' | 'query';
  readonly name: string;
}

const scanCalls = (): readonly WireCall[] => {
  const calls: WireCall[] = [];
  for (const [surface, source] of Object.entries(SURFACE_SOURCES)) {
    for (const match of source.matchAll(CALL_PATTERN)) {
      const fn = match[1];
      const name = match[2];
      if (fn === undefined || name === undefined) continue;
      const kind = fn === 'client.query' || fn === 'loadQuery' ? 'query' : 'command';
      calls.push({ surface, kind, name });
    }
  }
  return calls;
};

const INTERNAL_NAMES_BY_KIND: Readonly<Record<'command' | 'query', readonly string[]>> = {
  command: INTERNAL_COMMANDS.map((registration) => registration.name),
  query: INTERNAL_QUERIES.map((registration) => registration.name),
};

const v1Spec = (name: string) => {
  const spec = MESSAGE_REGISTRY[name];
  if (spec === undefined || spec.availability !== 'v1') return undefined;
  return spec;
};

describe('E4 compat · every wire name resolves against the frozen world', () => {
  const calls = scanCalls();

  it('the scan found every surface wire call (sanity floor, never green-by-absence)', () => {
    expect(calls.length).toBeGreaterThanOrEqual(20);
    for (const surface of ['guardian', 'overlay', 'quiet']) {
      expect(
        calls.some((c) => c.surface === surface),
        `${surface} must appear in the scan`,
      ).toBe(true);
    }
  });

  it('every called name is a v1 registry name or a served internal Tier-2 name', () => {
    for (const call of calls) {
      const registry = v1Spec(call.name);
      const internal = INTERNAL_NAMES_BY_KIND[call.kind].includes(call.name);
      expect(
        registry !== undefined || internal,
        `${call.surface}: ${call.name} is neither a v1 registry ${call.kind} nor an internal one`,
      ).toBe(true);
    }
  });

  it('registry-called names are dispatched under the registry-declared wire kind', () => {
    for (const call of calls) {
      const spec = v1Spec(call.name);
      if (spec === undefined) continue; // internal Tier-2: kind asserted below
      expect(
        spec.kind,
        `${call.name}: surface sends '${call.kind}' but the registry declares '${spec.kind}'`,
      ).toBe(call.kind);
    }
  });

  it('internal-called names never collide with the wire registry (parity law)', () => {
    const wireNames = new Set(
      Object.entries(MESSAGE_REGISTRY)
        .filter(([, spec]) => spec.availability === 'v1')
        .map(([name]) => name),
    );
    for (const name of [...INTERNAL_NAMES_BY_KIND.command, ...INTERNAL_NAMES_BY_KIND.query]) {
      expect(wireNames.has(name), `${name} leaks into the wire world`).toBe(false);
    }
  });
});

describe('E4 compat · surface payloads validate against the registry specs', () => {
  // The literal payloads at each call site, transcribed 1:1 from the scanned source
  // (dynamic ids stand in as spec-typed fixtures — the point is SHAPE, not values).
  // ULID-shaped fixtures: the registry's 'id' fields validate the frozen id shape,
  // so stand-ins must be shape-valid (values are inert — shape is the point).
  const ID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const ID_B = '01BX5ZZKBKACTAV9WEVGEMMVRY';
  const ID_C = '01C6GQDCC7G5B0R8KJRDBB1KYZ';
  const PAYLOADS: Readonly<Record<string, unknown>> = {
    ParkTab: { browserTabId: 11 },
    ParkGroup: { groupId: 7 },
    ParkWindow: { windowId: 1 },
    ParkAll: {},
    ResumeMission: { missionId: ID_A, mode: 'full' },
    StartMission: { name: 'A mission' },
    Undo: {},
    FirstRunIngest: {},
    // E6-T01 · W7 pair (the quiet card's put-back + report fetch).
    RestoreBootSession: { bootReportId: ID_A },
    GetBootstrap: { surface: 'guardian' },
    GetBootReport: {},
    PeekOpenTabs: {},
    SearchQuery: { q: 'query', scope: 'all', limit: 20 },
    GetLibrary: { filter: { state: 'archived' } },
    GetMissionDetail: { missionId: ID_A },
    GetRecentlyClosed: {},
    GetTrash: {},
    GetHealth: {},
    RestoreRecentlyClosed: { ids: [ID_A], target: 'new' },
    RestoreFromTrash: { kind: 'mission', id: ID_A },
    EmptyTrash: { confirm: true },
    DeleteEntity: { kind: 'mission', id: ID_A },
    RenameMission: { missionId: ID_A, name: 'Renamed' },
    MergeMissions: { fromId: ID_A, intoId: ID_B },
    SplitMission: { tabIds: [ID_C] },
    ArchiveMission: { missionId: ID_A },
    ConcludeMission: { missionId: ID_A },
    MoveTabs: { tabIds: [ID_A], toMissionId: ID_B },
    SetSetting: { key: 'trash.retentionDays', value: 30 },
    ImportPreviewRequest: { fileMeta: { name: 'f.html', size: 100 } },
    ImportCommit: { previewId: ID_B, dedupeMode: 'skip' },
    ExportRequest: { scope: 'all', formats: ['json', 'html', 'md'] },
    RescueScanNow: { mode: 'tail' },
    RepairRebuild: { scope: 'all' },
    ExportDiagnostics: {},
    CorrectTopic: { subjectId: ID_A, value: 'focus' },
    SetFavorite: { entityKind: 'mission', id: ID_A, favor: false },
    GetActivity: { limit: 50 },
    GetHistory: { limit: 50 },
  };

  it('every scanned registry name has a transcribed payload here (no blind spots)', () => {
    for (const call of scanCalls()) {
      if (v1Spec(call.name) === undefined) continue;
      expect(PAYLOADS[call.name], `missing payload fixture for ${call.name}`).toBeDefined();
    }
  });

  it('every transcribed payload passes the frozen validator', () => {
    for (const [name, payload] of Object.entries(PAYLOADS)) {
      const spec = v1Spec(name);
      if (spec === undefined) continue; // internal names have Tier-2 contracts instead
      const result = validateObject(
        spec.payload as SchemaSpec,
        payload as Record<string, unknown>,
        { message: name, field: 'payload' },
        0,
      );
      expect(
        result.ok,
        `${name} payload fails the registry spec: ${result.ok ? '' : result.error.code}`,
      ).toBe(true);
    }
  });

  it('the empty-payload commands still validate (optional-field law)', () => {
    for (const name of ['ParkAll', 'Undo', 'FirstRunIngest', 'ExportDiagnostics']) {
      const spec = v1Spec(name);
      expect(spec).toBeDefined();
      if (spec !== undefined) {
        expect(
          validateObject(spec.payload as SchemaSpec, {}, { message: name, field: 'payload' }, 0).ok,
        ).toBe(true);
      }
    }
  });
});

describe('E4 compat · error copy triangulation (the F1 gate)', () => {
  // ERROR_MAP is the frozen law for what messageKey/recoveryKey a wire error may
  // carry; error-map-lint (CI) enforces catalog↔map parity. This suite extends the
  // reach: the pairs the surface LAYER itself emits for locally discovered failures
  // (unreachable SW, TTL expiry, ledger eviction, malformed wire errors) must be
  // ERROR_MAP-honest pairs, so surfaces never render copy the map disowns.
  const ERROR_MAP = readFileSync('src/shared-kernel/result/error.catalog.ts', 'utf8');
  const CATALOG_KEYS = new Set(flattenKeys(readCatalog()));

  function readCatalog(): unknown {
    return JSON.parse(readFileSync('src/surfaces/components/copy/catalog.json', 'utf8')) as unknown;
  }

  function flattenKeys(node: unknown, prefix = '', out: string[] = []): readonly string[] {
    if (typeof node === 'object' && node !== null) {
      for (const [k, v] of Object.entries(node)) flattenKeys(v, `${prefix}${k}.`, out);
    } else if (typeof node === 'string') {
      out.push(prefix.slice(0, -1));
    }
    return out;
  }

  it('every error code the client can synthesize maps to its ERROR_MAP pair', () => {
    const pairs: Readonly<Record<string, readonly [string, string]>> = {
      E_CAPABILITY: ['msg.error.capability', 'msg.recover.retry'],
      E_DURABILITY_TIMEOUT: ['msg.error.durability', 'msg.recover.retry'],
      E_OUTPUT_MALFORMED: ['msg.error.output', 'msg.recover.retry'],
    };
    for (const [code, [messageKey, recoveryKey]] of Object.entries(pairs)) {
      expect(ERROR_MAP, `${code} must exist in ERROR_MAP`).toContain(`${code}:`);
      expect(ERROR_MAP, `${code} messageKey law`).toContain(`messageKey: '${messageKey}'`);
      expect(ERROR_MAP, `${code} recoveryKey law`).toContain(`recoveryKey: '${recoveryKey}'`);
      expect(CATALOG_KEYS.has(messageKey), `${messageKey} in catalog`).toBe(true);
      expect(CATALOG_KEYS.has(recoveryKey), `${recoveryKey} in catalog`).toBe(true);
    }
  });

  it('the client emits those honest pairs at its synthetic sites (source law)', () => {
    expect(CLIENT).toContain("messageKey: 'msg.error.capability'");
    expect(CLIENT).toContain("messageKey: 'msg.error.durability'");
    expect(CLIENT).toContain("messageKey: 'msg.error.output'");
    expect(CLIENT).toContain("recoveryKey: 'msg.recover.retry'");
    expect(CLIENT).toContain("recoveryKey: 'msg.recover.wait'");
    expect(CLIENT).toContain("recoveryKey: 'msg.recover.restart'");
    // Disowned copy patterns must not regrow.
    expect(CLIENT).not.toContain("messageKey: 'msg.error.sent'");
  });

  it('every msg.error.*/msg.recover.* key in the catalog is ERROR_MAP-referenced', () => {
    // Mirror of the CI lint's orphan rule, kept here so the surface suite alone
    // catches a copy-key drift before CI does.
    for (const key of CATALOG_KEYS) {
      if (!key.startsWith('msg.error.') && !key.startsWith('msg.recover.')) continue;
      expect(ERROR_MAP, `orphan copy: ${key}`).toContain(`'${key}'`);
    }
  });
});

describe('E4 compat · streams & contexts', () => {
  it('client WIRE_STREAMS is exactly the registry stream family (all 13)', () => {
    const registryStreams = Object.entries(MESSAGE_REGISTRY)
      .filter(([, spec]) => spec.kind === 'stream')
      .map(([name]) => name)
      .sort();
    expect([...WIRE_STREAMS].sort()).toEqual(registryStreams);
    expect(WIRE_STREAMS).toHaveLength(13);
  });

  it('every subscribe key in surface source is a frozen stream name', () => {
    const subscribeBlock = /client\.subscribe\(\{([\s\S]*?)\}\)/g;
    const frozen = new Set<string>(WIRE_STREAMS);
    for (const [surface, source] of Object.entries(SURFACE_SOURCES)) {
      for (const block of source.matchAll(subscribeBlock)) {
        const body = block[1] ?? '';
        const keys = [...body.matchAll(/^\s*([A-Z][A-Za-z]+):/gm)].map((m) => m[1]);
        expect(keys.length, `${surface} subscribes to no streams — scan drift`).toBeGreaterThan(0);
        for (const key of keys) {
          expect(
            key !== undefined && frozen.has(key),
            `${surface} subscribes to unknown stream ${key}`,
          ).toBe(true);
        }
      }
    }
  });

  it('the client rejects non-frozen stream names (closed world at runtime too)', () => {
    expect(CLIENT).toContain("'stream'");
    // The routing gate: v === CONTRACT_V, kind === 'stream', name in WIRE_STREAMS.
    expect(CLIENT).toMatch(/includes\(name\)/);
  });

  it('every sender context a surface stamps is inside the frozen enum', () => {
    const frozen = new Set<string>(SENDER_CONTEXTS);
    for (const [surface, source] of Object.entries(SURFACE_SOURCES)) {
      const match = /const \w+_CONTEXT: SenderContext = '([a-z]+)'/.exec(source);
      expect(match, `${surface} stamps no context — scan drift`).not.toBeNull();
      expect(frozen.has(match?.[1] ?? ''), `${surface} context ${match?.[1]}`).toBe(true);
    }
  });

  it('surfaces subscribe with detach handles and dispose them (no floating subs)', () => {
    for (const [surface, source] of Object.entries(SURFACE_SOURCES)) {
      expect(source, `${surface} must capture the subscribe detach handle`).toContain(
        'detachStreams',
      );
      expect(source, `${surface} must call detachStreams in unmount`).toMatch(
        /unmount:[\s\S]*detachStreams\(\)/,
      );
    }
  });
});
