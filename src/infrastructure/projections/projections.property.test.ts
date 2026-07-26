// E2-T03 completion criterion as law: "Determinism property: same journal ⇒ identical
// models." Plus: resume-equivalence (chunk/kill boundaries invisible) and §3.5 delta
// faithfulness (frames alone reconstruct the stores).
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ViewDeltaFrame, ViewName } from '@/application/ports/projection-engine.port.js';
import type { EventEnvelope } from '@/shared-kernel/events/index.js';
import { stableStringify } from '@/shared-kernel/canon/index.js';
import { createV1ProjectionEngine } from './index.js';
import {
  DEV_A,
  assignedEnv,
  archivedEnv,
  closedEnv,
  formedEnv,
  makeProjections,
  movedEnv,
  renamedEnv,
  restoredEnv,
  seedJournal,
  storeSnapshot,
  type ProjectionHarness,
} from './testkit.js';

type Op =
  | { readonly kind: 'formed'; readonly m: number; readonly tabs: readonly number[] }
  | { readonly kind: 'renamed'; readonly m: number }
  | { readonly kind: 'assigned'; readonly t: number; readonly m: number }
  | { readonly kind: 'moved'; readonly t: number; readonly m: number; readonly from: number }
  | { readonly kind: 'archived'; readonly m: number }
  | { readonly kind: 'closed'; readonly t: number; readonly m: number }
  | { readonly kind: 'restored'; readonly t: number; readonly m: number };

const opArb: fc.Arbitrary<Op> = fc
  .tuple(fc.integer({ min: 1, max: 3 }), fc.integer({ min: 1, max: 6 }))
  .chain(([m, t]) =>
    fc.oneof(
      fc.subarray([1, 2, 3, 4, 5, 6]).map((tabs) => ({ kind: 'formed', m, tabs }) as const),
      fc.constant({ kind: 'renamed', m } as const),
      fc.constant({ kind: 'assigned', t, m } as const),
      fc.integer({ min: 1, max: 3 }).map((from) => ({ kind: 'moved', t, m, from }) as const),
      fc.constant({ kind: 'archived', m } as const),
      fc.constant({ kind: 'closed', t, m } as const),
      fc.constant({ kind: 'restored', t, m } as const),
    ),
  );

const streamOf = (ops: readonly Op[]): EventEnvelope[] =>
  ops.map((op, i) => {
    const seq = i + 1;
    switch (op.kind) {
      case 'formed':
        return formedEnv(seq, op.m, op.tabs);
      case 'renamed':
        return renamedEnv(seq, op.m, `name-${seq}`);
      case 'assigned':
        return assignedEnv(seq, op.t, op.m);
      case 'moved':
        return movedEnv(seq, op.t, op.m, op.from);
      case 'archived':
        return archivedEnv(seq, op.m);
      case 'closed':
        return closedEnv(seq, op.t, op.m);
      case 'restored':
        return restoredEnv(seq, op.t, op.m);
    }
  });

const snapshotPair = async (h: ProjectionHarness): Promise<string> =>
  stableStringify({
    missions: await storeSnapshot(h, 'missions'),
    recently_closed: await storeSnapshot(h, 'recently_closed'),
    sessions: await storeSnapshot(h, 'sessions'), // E2-T08: third v1 view
    tabs: await storeSnapshot(h, 'tabs'), // E3-APP: fourth v1 view
  });

/** Replay one delta stream onto empty shelves (§3.5 faithfulness harness). */
const replayFrames = (frames: readonly ViewDeltaFrame[]): string => {
  type ShelfName = 'missions' | 'recently_closed' | 'sessions' | 'tabs' | 'search_index';
  const stores: Record<ShelfName, Map<string, Record<string, unknown>>> = {
    missions: new Map(),
    recently_closed: new Map(),
    sessions: new Map(),
    tabs: new Map(),
    search_index: new Map(),
  };
  // E3-APP: fold is total over ViewName (growth-lawful — new views join the model);
  // patch pk addressing mirrors the engine's keyField law.
  const shelfNameOf = (view: ViewName): ShelfName =>
    view === 'recentlyClosed' ? 'recently_closed' : view === 'searchIndex' ? 'search_index' : view;
  const pkOf = (view: ViewName): string => {
    switch (view) {
      case 'missions':
        return 'missionId';
      case 'recentlyClosed':
        return 'entryId';
      case 'tabs':
        return 'ledgeTabId';
      case 'searchIndex':
        return 'token';
      default:
        return 'entryId';
    }
  };
  const shelfOf = (view: ViewName) => stores[shelfNameOf(view)];
  for (const frame of frames) {
    const store = shelfOf(frame.view);
    for (const op of frame.ops) {
      if (op.kind === 'upsert') store.set(op.key, { ...op.record });
      if (op.kind === 'remove') store.delete(op.key);
      if (op.kind === 'patch') {
        const cur = store.get(op.key) ?? {};
        store.set(op.key, { ...cur, ...op.fields, [pkOf(frame.view)]: op.key });
      }
    }
  }
  const asArray = (m: Map<string, Record<string, unknown>>) =>
    [...m.values()].sort((a, b) => (stableStringify(a) < stableStringify(b) ? -1 : 1));
  return stableStringify({
    missions: asArray(stores.missions),
    recently_closed: asArray(stores.recently_closed),
    sessions: asArray(stores.sessions),
    tabs: asArray(stores.tabs),
    search_index: asArray(stores.search_index),
  });
};

const PROJ_TIMEOUT_MS = 600_000;

describe('E2-T03 determinism law (completion criterion)', () => {
  it(
    'same journal ⇒ identical models, regardless of apply path (full, chunked, rebuilt)',
    { timeout: PROJ_TIMEOUT_MS },
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(opArb, { minLength: 1, maxLength: 24 }),
          fc.array(fc.integer({ min: 1, max: 8 }), { minLength: 1, maxLength: 4 }),
          async (ops, chunkSizes) => {
            const events = streamOf(ops);

            // Path A: journal ⇒ single applyFromJournal.
            const a = await makeProjections();
            await seedJournal(a, events);
            const ra = await a.projections.applyFromJournal(DEV_A);
            if (!ra.ok) throw new Error(`apply A failed: ${ra.error.code}`);
            const snapA = await snapshotPair(a);

            // Path B: same events ⇒ chunked apply with instance death between chunks.
            const b = await makeProjections();
            let idx = 0;
            let runner = b.projections;
            while (idx < events.length) {
              const size = chunkSizes[idx % chunkSizes.length] ?? 3;
              const slice = events.slice(idx, idx + size);
              const rb = await runner.apply(slice);
              if (!rb.ok) throw new Error(`apply B failed: ${rb.error.code}`);
              idx += slice.length;
              // ☠ SW death between chunks — a fresh engine resumes on watermarks.
              runner = createV1ProjectionEngine({
                engine: b.engine,
                journal: b.journal,
                onDelta: (f) => b.frames.push(f),
              });
            }
            const snapB = await snapshotPair(b);
            expect(snapB).toBe(snapA);

            // Path C: rebuilds of Path A reproduce it exactly.
            for (const view of ['missions', 'recentlyClosed'] as const) {
              const rebuilt = await a.projections.rebuild(view);
              if (!rebuilt.ok) throw new Error(`rebuild ${view} failed`);
            }
            expect(await snapshotPair(a)).toBe(snapA);

            // §3.5 delta faithfulness on Path B: frames alone rebuild the shelves.
            // (Frames are watermarked per commit; replaying them from empty must reach
            // the same models — the stream a surface would actually consume.)
            expect(replayFrames(b.frames)).toBe(replayFrames(a.frames));

            await a.engine.close();
            await b.engine.close();
          },
        ),
      );
    },
  );
});
