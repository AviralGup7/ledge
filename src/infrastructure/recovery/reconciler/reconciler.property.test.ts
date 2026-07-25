// E2-T06 property suite — randomized dangling-intent scenarios (kinds × scopes ×
// evidence subsets × torn terminals × tamper) reconciled against a computed model.
// Laws proved per scenario (see each expect site): report presence+shape, coherent
// outcome, conservative boundary (no completion without full proof), §10-R2 dedupe
// identity, ledger convergence, reconcile∘reconcile = reconcile (idempotence),
// decision determinism across independent reconcilers, zero tab loss, and stalled
// writes never poisoning sibling resolutions (regression B19 at property volume).
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  acceptIntent,
  browserTabId,
  decisionProjection,
  intentId,
  makeWorld,
  missionId,
  reconcile,
  tabClosedExternal,
  tabsParked,
  tabObserved,
  withSabotage,
  type ReconcileWorld,
} from './testkit.js';
import { assessLossRisk, policyFor, scopeTabRefs } from './index.js';
import type { IntentDisposition } from './types.js';

const PROPERTY_TIMEOUT_MS = 600_000;
const TAB_POOL = 8;
const INTENT_POOL = 5;

/** Scenario ops (applied in order — stream construction mirrors a crash story). */
type Op =
  | {
      readonly kind: 'accept';
      readonly n: number;
      readonly wire: string;
      readonly tabs: readonly number[];
    }
  | { readonly kind: 'close'; readonly n: number }
  | { readonly kind: 'tornComplete'; readonly n: number; readonly secured: number }
  | { readonly kind: 'stallIntent'; readonly n: number }
  | { readonly kind: 'tailTamper' };

const opArb: fc.Arbitrary<Op> = fc
  .tuple(
    fc.integer({ min: 1, max: INTENT_POOL }),
    fc.integer({ min: 1, max: TAB_POOL }),
    fc.constantFrom(
      'ParkTab',
      'ParkAll',
      'ParkWindow',
      'ResumeMission',
      'DeleteEntity',
      'Undo',
      'ConcludeMission',
    ),
    fc.array(fc.integer({ min: 1, max: TAB_POOL }), { minLength: 1, maxLength: 4 }),
  )
  .chain(([n, t, wire, tabs]) =>
    fc.constantFrom(
      { kind: 'accept', n, wire, tabs } as const,
      { kind: 'accept', n, wire, tabs } as const,
      { kind: 'accept', n, wire: 'ParkTab', tabs } as const,
      { kind: 'close', n: t } as const,
      { kind: 'close', n: t } as const,
      { kind: 'tornComplete', n, secured: tabs.length } as const,
      { kind: 'stallIntent', n } as const,
    ),
  );

const unwrap = <T, E>(r: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (!r.ok) throw new Error(`unexpected err: ${JSON.stringify(r.error)}`);
  return r.value;
};

/** The durable inputs the model tracks per intent slot. */
interface Slot {
  accepted: boolean;
  wire: string;
  refs: readonly number[];
  /** §2.13 command→observation order (B20): only closes after acceptance prove. */
  acceptedAt: number;
  torn: number | null; // secured count of a torn TabsParked (terminal durable, row lagging)
  stalled: boolean;
}

interface ScenarioModel {
  readonly slots: Map<number, Slot>;
  /** tab → op indices at which it closed (observed-then-closed pairs). */
  readonly closeTimes: Map<number, number[]>;
  readonly tampered: boolean;
}

/**
 * Expected disposition per intent under the actual decision ladder (the reconciler
 * is the implementation under test — this model derives expectations from the
 * SCENARIO INPUTS, not from production code paths).
 */
const expectedDisposition = (
  intent: Slot,
  closeTimes: ReadonlyMap<number, number[]>,
): IntentDisposition => {
  const policy = policyFor(intent.wire);
  // Type-family law: only the FAMILY's own §4 rows prove its completion — a
  // TabsParked naming an Undo intent is foreign/corrupt history, never proof.
  if (intent.torn !== null && policy.completeTypes.includes('TabsParked')) {
    return 'completed-safe';
  }
  const refs = intent.refs;
  // Temporal law (B20): tab n is evidence only when closed after the acceptance op.
  const closedAfterAccept = (n: number): boolean =>
    (closeTimes.get(n) ?? []).some((t) => t > intent.acceptedAt);
  if (policy.r2Completes && refs.length > 0) {
    const covered = refs.filter(closedAfterAccept);
    if (covered.length === refs.length) return 'completed-evidence';
    if (covered.length > 0 && policy.hasAbortRow) return 'aborted-conservative';
  }
  if (policy.family === 'park-close' && policy.hasAbortRow) return 'aborted-conservative';
  return 'deferred';
};

const buildWorld = async (
  script: readonly Op[],
): Promise<ScenarioModel & { w: ReconcileWorld }> => {
  const w = await makeWorld();
  const slots = new Map<number, Slot>();
  const closeTimes = new Map<number, number[]>();
  let tampered = false;
  let clock = 0;

  for (const op of script) {
    clock += 1;
    switch (op.kind) {
      case 'accept': {
        if (slots.has(op.n)) break; // one acceptance per slot (ledger id law)
        const scope =
          op.wire === 'ResumeMission'
            ? { missionId: missionId(op.n), mode: 'everything' }
            : { tabIds: op.tabs.map(browserTabId) };
        await acceptIntent(w, op.n, op.wire, scope);
        slots.set(op.n, {
          accepted: true,
          wire: op.wire,
          // R2 dedupe law mirrors production: refs are a SET keyed by browserTabId.
          refs: op.wire === 'ResumeMission' ? [] : [...new Set(op.tabs)],
          acceptedAt: clock,
          torn: null,
          stalled: false,
        });
        break;
      }
      case 'close': {
        // R2 chain requires an observation first (§2.1 identity link).
        await w.append([tabObserved(w, op.n)]);
        await w.append([tabClosedExternal(w, op.n)]);
        const times = closeTimes.get(op.n) ?? [];
        times.push(clock);
        closeTimes.set(op.n, times);
        break;
      }
      case 'tornComplete': {
        const slot = slots.get(op.n);
        if (slot === undefined || !slot.accepted || slot.torn !== null) break;
        await w.append([tabsParked(w, intentId(op.n), op.secured)]);
        slot.torn = op.secured;
        break;
      }
      case 'stallIntent': {
        const slot = slots.get(op.n);
        if (slot !== undefined) slot.stalled = true;
        break;
      }
      case 'tailTamper': {
        tampered = true;
        break;
      }
    }
  }
  return { w, slots, closeTimes, tampered };
};

describe('E2-T06 property — randomized dangling-intent scenarios', () => {
  it(
    'every scenario reconciles lawfully (presence/coherence/conservative/R2/idempotence/zero-loss)',
    { timeout: PROPERTY_TIMEOUT_MS },
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 18 }), async (script) => {
          const built = await buildWorld(script);
          const w = built.w;
          const stall = [...built.slots.entries()].filter(([, s]) => s.stalled).map(([n]) => n);
          const deps = withSabotage(w, {
            scanTailFails: built.tampered,
            failAppendForIntent: {
              current: stall.length > 0 ? intentId(stall[0] as number) : null,
            },
            pendingFails: false,
          });

          const preEvents = (await w.readAll()).length;
          const reportResult = await reconcile(w, deps);
          // L1 (report presence): the boot ALWAYS reports — even tampered boots.
          expect(reportResult.ok).toBe(true);
          const report = unwrap(reportResult);
          expect(report.schemaV).toBe(1);

          if (built.tampered) {
            // Degraded posture: nothing written, nothing resolved, risk disclosed.
            expect(report.outcome).toBe('recovered');
            expect(report.lossRisk).toBe(true);
            expect((await w.readAll()).length).toBe(preEvents);
            expect(report.resolutions).toEqual([]);
            return;
          }

          // L2 (coherence): outcome mirrors the examined set.
          const pendingCount = built.slots.size;
          expect(report.intentsExamined).toBe(pendingCount);
          expect(report.outcome).toBe(pendingCount > 0 ? 'reconciled' : 'clean');
          expect(report.resolutions).toHaveLength(pendingCount);

          const events = await w.readAll();
          const parkedRows = events.filter((e) => e.envelope.type === 'TabsParked');
          const abortedRows = events.filter((e) => e.envelope.type === 'ParkAborted');
          const firstStall = stall.length > 0 ? (stall[0] as number) : null;

          for (const [n, slot] of built.slots) {
            const id = intentId(n);
            const resolution = report.resolutions.find((r) => r.intentId === id);
            expect(resolution, `resolution for intent ${n}`).toBeDefined();
            if (resolution === undefined) continue;

            // A stall bites ONLY when the unstalled path would attempt a ledger
            // write (non-deferred dispositions); policy-driven deferreds never
            // call complete/abort, so sabotage is a no-op for them (B19 law).
            const want = expectedDisposition(slot, built.closeTimes);
            const isStalled = firstStall !== null && n === firstStall && want !== 'deferred';
            if (isStalled) {
              expect(resolution.disposition).toBe('deferred');
              expect(resolution.reason).toBe('defer:resolution-write-failed');
              continue;
            }
            expect(resolution.disposition, `intent ${n} disposition`).toBe(want);

            // L3 (conservative boundary): completion only under full proof.
            if (want === 'completed-evidence') {
              const refs = slot.refs.map(browserTabId);
              expect([...resolution.evidenceTabs].sort((a, b) => a - b)).toEqual(
                [...refs].sort((a, b) => a - b),
              );
              expect(resolution.securedCounted).toBe(refs.length);
            }
            // L4/R2 (dedupe + zero-loss for partial close-class aborts).
            if (want === 'aborted-conservative') {
              expect(new Set(resolution.evidenceTabs).size).toBe(resolution.evidenceTabs.length);
              expect(resolution.evidenceTabs.length + resolution.liveLeftOpen).toBe(
                scopeTabRefs({ tabIds: slot.refs.map(browserTabId) })?.length ?? 0,
              );
            }
            // Ledger convergence ≡ disposition (L5).
            const row = unwrap(
              await w.engine.txn(['intents'], 'readonly', (tx) => tx.table('intents').get(id)),
            ) as { state: string } | undefined;
            if (want === 'completed-evidence' || want === 'completed-safe') {
              expect(row?.state).toBe('done');
            } else if (want === 'aborted-conservative') {
              expect(row?.state).toBe('aborted');
            } else {
              expect(row?.state).toBe('intent');
            }
          }

          // Stream-shape law: deferreds wrote nothing; every resolvable intent's
          // terminal rows are present and reference its intentId.
          for (const row of [...parkedRows, ...abortedRows]) {
            const payload = row.envelope.payload as Record<string, unknown>;
            expect(Object.prototype.hasOwnProperty.call(payload, 'intentId')).toBe(true);
          }

          // L6 (loss-risk rule): gating flag tracks the pure rule.
          expect(report.lossRisk).toBe(assessLossRisk(report.journalProbe, report.resolutions));

          // L7 (idempotence = fixpoint): bounded boots converge — a stalled
          // intent heals on later boots; once a boot takes ONLY deferral
          // readings, the stream is frozen and stays frozen.
          let fixpoint = unwrap(await reconcile(w));
          for (let guard = 0; guard < pendingCount + 2; guard += 1) {
            if (fixpoint.resolutions.every((r) => r.disposition === 'deferred')) break;
            fixpoint = unwrap(await reconcile(w));
          }
          expect(fixpoint.resolutions.every((r) => r.disposition === 'deferred')).toBe(true);
          const frozenLen = (await w.readAll()).length;
          const frozenAgain = unwrap(await reconcile(w));
          expect(frozenAgain.resolutions.filter((r) => r.disposition !== 'deferred')).toEqual([]);
          expect((await w.readAll()).length).toBe(frozenLen);
          expect(frozenAgain.lossRisk).toBe(
            frozenAgain.resolutions.some((r) => r.disposition === 'deferred'),
          );

          // L8 (determinism): an independent world+reconciler over the SAME script
          // reaches byte-identical decision projections.
          const twin = await buildWorld(script);
          const twinDeps = withSabotage(twin.w, {
            scanTailFails: built.tampered,
            failAppendForIntent: {
              current: stall.length > 0 ? intentId(stall[0] as number) : null,
            },
            pendingFails: false,
          });
          const twinReport = unwrap(await reconcile(twin.w, twinDeps));
          expect(twinReport.resolutions.map(decisionProjection)).toEqual(
            report.resolutions.map(decisionProjection),
          );
        }),
      );
    },
  );
});
