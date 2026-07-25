// E2-T05 · pure observation→draft mapping (§4 catalog rows, canon via kernel).
// Nothing in here awaits, clocks, or entropies: raw observations + captured ts in,
// IngestDrafts out. Identity resolution flows through the identity map — the SINGLE
// mint authority for ledgeTabIds in the ingest path.
import type { TabChanges, TabsEvent } from '@/application/ports/tabs.port.js';
import type { WindowsEvent } from '@/application/ports/windows.port.js';
import { canonicalize } from '@/shared-kernel/canon/index.js';
import type { GroupChangedInput, IngestDraft, PendingObservation } from './types.js';
import type { TabIdentityMap } from './identity-map.js';

export type CounterField =
  | 'observed'
  | 'updated'
  | 'activated'
  | 'closed'
  | 'windowsClosed'
  | 'groupsChanged'
  | 'skippedUnknownTab';

export interface MappedObservation {
  readonly drafts: readonly IngestDraft[];
  readonly count: CounterField | null;
}

/** Normalize a port TabChanges into the §4 TabUpdated.changes record shape. */
const changesRecord = (changes: TabChanges): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  if (changes.title !== undefined) out['title'] = changes.title;
  if (changes.url !== undefined) out['url'] = changes.url;
  if (changes.groupId !== undefined) out['groupId'] = changes.groupId;
  return out;
};

/**
 * Map one raw tabs event. Laws (§4 idempotency column):
 *  * created on an UNKNOWN browserTabId → TabObserved (idempotent by ledgeTabId at
 *    the projection law; the journal only ever sees one per identity);
 *  * created on a KNOWN id (SW restart race / chrome id-reuse after a close) →
 *    TabUpdated supersede, never a second TabObserved — the ONLY closure re-arm;
 *  * updated/activated/removed on an unknown tab → no draft (skippedUnknownTab):
 *    a tab Ledge never observed is not user truth (EES §2.1 truth law);
 *  * updated/activated/removed on a CLOSED tab → also no draft (skippedUnknownTab):
 *    TabClosedExternal is terminal for the episode; a late event must not
 *    resurrect it in projections (closure finality, regression B17);
 *  * moved/attached → no event in the v1 catalog (§4 has no row; windowId silently
 *    tracked for hydrate-consistency).
 */
export function mapTabsEvent(
  event: TabsEvent,
  identity: TabIdentityMap,
  ts: number,
): MappedObservation {
  switch (event.kind) {
    case 'created': {
      const resolved = identity.resolve(event.tab.browserTabId, event.tab.windowId);
      if (!resolved.isNew) {
        // Restart race (or chrome id-reuse after a close): the tab pre-exists in our
        // truth; a full-field supersede refreshes mutable content — one TabUpdated,
        // never a duplicate identity. This is the ONLY re-arm of closure finality.
        identity.unclose(resolved.ledgeTabId);
        const changes = changesRecord({ title: event.tab.title, url: event.tab.url });
        if (Object.keys(changes).length === 0) return { drafts: [], count: null };
        return {
          drafts: [{ type: 'TabUpdated', payload: { ledgeTabId: resolved.ledgeTabId, changes } }],
          count: 'updated',
        };
      }
      const canon = canonicalize(event.tab.url);
      return {
        drafts: [
          {
            type: 'TabObserved',
            payload: {
              ledgeTabId: resolved.ledgeTabId,
              browserTabId: event.tab.browserTabId,
              windowId: event.tab.windowId,
              ...(event.tab.groupId !== null ? { groupId: event.tab.groupId } : {}),
              url: event.tab.url,
              urlCanon: canon.canonForm,
              canonRulesV: canon.rulesVersion,
              title: event.tab.title,
              domain: canon.domain,
              ts,
            },
          },
        ],
        count: 'observed',
      };
    }
    case 'updated': {
      const ledgeTabId = identity.get(event.browserTabId);
      if (ledgeTabId === undefined || identity.isClosed(ledgeTabId)) {
        return { drafts: [], count: 'skippedUnknownTab' };
      }
      const changes = changesRecord(event.changes);
      if (Object.keys(changes).length === 0) return { drafts: [], count: null };
      return {
        drafts: [{ type: 'TabUpdated', payload: { ledgeTabId, changes } }],
        count: 'updated',
      };
    }
    case 'activated': {
      const ledgeTabId = identity.get(event.browserTabId);
      if (ledgeTabId === undefined || identity.isClosed(ledgeTabId)) {
        return { drafts: [], count: 'skippedUnknownTab' };
      }
      return {
        drafts: [{ type: 'TabActivatedObserved', payload: { ledgeTabId, ts } }],
        count: 'activated',
      };
    }
    case 'removed': {
      const ledgeTabId = identity.get(event.browserTabId);
      if (ledgeTabId === undefined || identity.isClosed(ledgeTabId)) {
        // Duplicate/late close after finality: the closure row already exists —
        // appending another would double-count (§10-R2 double-count law).
        return { drafts: [], count: 'skippedUnknownTab' };
      }
      identity.close(ledgeTabId);
      return {
        drafts: [{ type: 'TabClosedExternal', payload: { ledgeTabId, closedAt: ts } }],
        count: 'closed',
      };
    }
    case 'moved':
    case 'attached':
      identity.noteWindow(event.browserTabId, event.windowId);
      return { drafts: [], count: null };
  }
}

/** §4 WindowClosedExternal; window birth/focus have no v1 catalog row. */
export function mapWindowsEvent(event: WindowsEvent, ts: number): MappedObservation {
  if (event.kind === 'removed') {
    return {
      drafts: [
        { type: 'WindowClosedExternal', payload: { windowId: event.windowId, closedAt: ts } },
      ],
      count: 'windowsClosed',
    };
  }
  return { drafts: [], count: null };
}

/** §4 GroupChanged passthrough (E3-T02 wires chrome.tabGroups to this seam). */
export function mapGroupChanged(input: GroupChangedInput): MappedObservation {
  return {
    drafts: [
      {
        type: 'GroupChanged',
        payload: {
          groupId: input.groupId,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.color !== undefined ? { color: input.color } : {}),
          ...(input.collapsed !== undefined ? { collapsed: input.collapsed } : {}),
        },
      },
    ],
    count: 'groupsChanged',
  };
}

/** Single dispatch for a pending observation (handle-time ts rides along). */
export function mapPending(
  pending: PendingObservation,
  identity: TabIdentityMap,
): MappedObservation {
  switch (pending.source) {
    case 'tabs':
      return mapTabsEvent(pending.event, identity, pending.ts);
    case 'windows':
      return mapWindowsEvent(pending.event, pending.ts);
    case 'group':
      return mapGroupChanged(pending.input);
  }
}
