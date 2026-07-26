// E4 · Overlay surface — Reflex Search (Spec §6.6 / EES §2.16: one global gesture,
// type → arrow → enter, a reflex layer over every surface). v1 platform reality:
// no host permissions ⇒ no in-page overlay on arbitrary sites; the overlay is an
// extension page (activation via the surfaces + OS shortcut wiring is the ADR-022
// manifest sign-off item — see docs/adr-notes/e4-surfaces.md). Authority-free:
// it renders SearchResultsView hits and dispatches exactly one activation command.
import type { SenderContext } from '@/application/contracts/index.js';
import { copyOf } from '../components/copy/copy.js';
import { clearChildren, el } from '../components/dom/dom.js';
import { ensureLiveRegion, type LiveAnnouncer } from '../components/dom/live.js';
import {
  createWireClient,
  type WireClient,
  type WireError,
  type WireTransport,
} from '../components/session/client.js';
import type { CidEntropy } from '../components/session/ids.js';
import {
  createSearchPalette,
  type PaletteItem,
  type SearchPalette,
} from '../components/widgets/search-palette.js';
import { renderStateBlock } from '../components/widgets/states.js';

const OVERLAY_CONTEXT: SenderContext = 'overlay';
const RESULT_LIMIT = 20;

export interface OverlayDeps {
  readonly transport: WireTransport;
  readonly entropy: CidEntropy;
  /** Query debounce seam (root wires setTimeout; tests drive manually). */
  readonly debounce: (delayMs: number, fn: () => void) => () => void;
  /** Close seam (root wires window.close / panel teardown). */
  readonly close: () => void;
  readonly contractHash?: string | undefined;
}

export interface Mounted {
  readonly unmount: () => void;
}

interface SearchHitWire {
  readonly tabId: string;
  readonly missionId: string;
  readonly title: string;
  readonly url: string;
  readonly domain: string;
  readonly state: string;
}

const asString = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const asRecords = (v: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(v)
    ? (v.filter((x) => typeof x === 'object' && x !== null) as Record<string, unknown>[])
    : [];

const hitOf = (raw: Record<string, unknown>): SearchHitWire => ({
  tabId: asString(raw['tabId']),
  missionId: asString(raw['missionId']),
  title: asString(raw['title']),
  url: asString(raw['url']),
  domain: asString(raw['domain']),
  state: asString(raw['state'], 'kept'),
});

const itemOf = (hit: SearchHitWire, index: number): PaletteItem => ({
  id: `${hit.state}.${hit.tabId.length > 0 ? hit.tabId : hit.missionId}.${String(index)}`,
  title: hit.title.length > 0 ? hit.title : hit.domain,
  sub: hit.domain,
  group: hit.state,
});

const DEBOUNCE_MS = 150;

export const mountOverlay = (doc: Document, deps: OverlayDeps): Mounted => {
  const client: WireClient = createWireClient({
    context: OVERLAY_CONTEXT,
    transport: deps.transport,
    entropy: deps.entropy,
    ...(deps.contractHash !== undefined ? { contractHash: deps.contractHash } : {}),
  });
  const live: LiveAnnouncer = ensureLiveRegion(doc, doc.body);

  let hits: readonly SearchHitWire[] = [];
  let searchedFreshness = '';
  let lastQuery = '';
  let cancelDebounce: (() => void) | undefined;
  const hitByItemId = new Map<string, SearchHitWire>();

  const root = el(doc, 'main', {
    cls: 'surface overlay',
    attrs: { 'data-surface': 'overlay' },
  });
  const statusSlot = el(doc, 'div', { cls: 'overlay-status', attrs: { 'data-slot': 'status' } });

  const showError = (error: WireError): void => {
    clearChildren(statusSlot);
    statusSlot.appendChild(
      renderStateBlock(doc, { kind: 'error', copyKey: 'msg.error.output', error }),
    );
  };

  const runSearch = (q: string): void => {
    palette.setLoading(true);
    const query = client.query('SearchQuery', { q, scope: 'all', limit: RESULT_LIMIT });
    void query.terminal.then((t) => {
      // Stale-response guard: newer typing superseded this answer; only the live
      // query may touch the palette (out-of-order replies never downgrade results).
      if (q !== lastQuery) return;
      palette.setLoading(false);
      if (!t.ok) {
        showError(t.error);
        palette.setItems([]);
        return;
      }
      clearChildren(statusSlot);
      const r = (typeof t.value === 'object' && t.value !== null ? t.value : {}) as Record<
        string,
        unknown
      >;
      searchedFreshness = asString(r['freshness']);
      hits = asRecords(r['results']).map(hitOf);
      hitByItemId.clear();
      const items = hits.map(itemOf);
      items.forEach((item, index) => {
        const hit = hits[index];
        if (hit !== undefined) hitByItemId.set(item.id, hit);
      });
      palette.setItems(items);
      if (hits.length === 0 && q.trim().length > 0) {
        palette.setNote(copyOf('msg.empty.search'));
      } else if (searchedFreshness === 'fallback') {
        palette.setNote(copyOf('msg.note.fallback'));
      } else {
        palette.setNote(undefined);
      }
    });
  };

  const activate = (item: PaletteItem): void => {
    const hit = hitByItemId.get(item.id);
    if (hit === undefined) return;
    if (hit.state === 'kept') {
      const op = client.command('ResumeMission', { missionId: hit.missionId, mode: 'full' });
      live.say(copyOf('msg.state.pending'));
      void op.terminal.then((t) => {
        if (!t.ok) {
          showError(t.error);
          return;
        }
        deps.close();
      });
      return;
    }
    if (hit.state === 'live') {
      // Live hits: no v1 wire verb focuses an already-open tab — honest no-op note.
      palette.setNote(copyOf('msg.note.already-open'));
      return;
    }
    // 'trash' hits are not activatable from search (recovery lives in the quiet page)
  };

  const palette: SearchPalette = createSearchPalette(doc, {
    onQuery: (q) => {
      lastQuery = q;
      cancelDebounce?.();
      if (q.trim().length === 0) {
        hits = [];
        palette.setItems([]);
        palette.setNote(undefined);
        clearChildren(statusSlot);
        return;
      }
      cancelDebounce = deps.debounce(DEBOUNCE_MS, () => runSearch(lastQuery));
    },
    onActivate: activate,
    onClose: () => deps.close(),
  });

  root.appendChild(palette.root);
  root.appendChild(statusSlot);
  doc.body.appendChild(root);
  palette.focus();

  const detachStreams = client.subscribe({
    ResyncRequired: (payload) => {
      const p = payload as Record<string, unknown>;
      if (asString(p['reason']) === 'schema') {
        // Schema resync: the generic error + recovery pair, never a silent partial.
        clearChildren(statusSlot);
        statusSlot.appendChild(
          renderStateBlock(doc, {
            kind: 'error',
            copyKey: 'msg.error.output',
            error: {
              code: 'E_OUTPUT_MALFORMED',
              messageKey: 'msg.error.output',
              recoveryKey: 'msg.recover.report',
            },
          }),
        );
      }
    },
  });

  return {
    unmount: () => {
      detachStreams();
      cancelDebounce?.();
      palette.dispose();
      client.dispose();
      live.dispose();
      root.remove();
    },
  };
};
