// E4 · Guardian strip surface (EES §2.16 / Spec §6.2: the park gesture, the
// heartbeat, Start/Resume, the one-nudge slot). Authority-free by law: it renders
// DTOs, sends commands/queries, and subscribes streams — ZERO business logic.
// R1 (EES): acknowledge-pending until CommandApplied; the heartbeat moves only on
// HeartbeatUpdate (post-Applied). No optimistic truth anywhere in this file.
import type { SenderContext } from '@/application/contracts/index.js';
import { copyOf } from '../components/copy/copy.js';
import { clearChildren, el, inputValue } from '../components/dom/dom.js';
import { bindKeys } from '../components/dom/keyboard.js';
import { ensureLiveRegion, type LiveAnnouncer } from '../components/dom/live.js';
import {
  createWireClient,
  type OperationHandle,
  type WireClient,
  type WireError,
  type WireTransport,
} from '../components/session/client.js';
import type { CidEntropy } from '../components/session/ids.js';
import { createViewStore, viewFrameOf, type ViewStore } from '../components/state/view-store.js';
import { createHeartbeatPill, type HeartbeatPill } from '../components/widgets/heartbeat.js';
import { renderBriefCard, type PendingBrief } from '../components/widgets/brief-card.js';
import { renderDupeStrip, type DupeGroupModel } from '../components/widgets/dupe-strip.js';
import {
  actionButton,
  renderMissionCard,
  type MissionCardModel,
} from '../components/widgets/mission-card.js';
import { renderTabRow, type TabRowModel } from '../components/widgets/tab-row.js';
import { renderLoading, renderStateBlock } from '../components/widgets/states.js';

const GUARDIAN_CONTEXT: SenderContext = 'guardian';
const GROUP_NONE = -1;
const NO_GROUP_ID = 0;
const FIRST_INDEX = 0;

export interface GuardianDeps {
  readonly transport: WireTransport;
  readonly entropy: CidEntropy;
  /** Wake seam (visibilitychange/focus): re-reads snapshots after SW sleep — the
   *  reconnect contract for MV3 (streams are fire-and-forget; a full snapshot
   *  rejoin on wake is the honest resume). */
  readonly onWake?: ((listener: () => void) => () => void) | undefined;
  readonly contractHash?: string | undefined;
  /**
   * E8-T05 brief seam (Spec §6.9 · W5 · ADR note e8-resumption-briefs J3):
   * `pending` answers the domain-gated briefs for this mount's missions;
   * `onDismiss` records the per-mission-forever dismissal. The DismissBrief /
   * GetMissionBrief wire names ride the v1.1 reserve tier (dormant today), so
   * composition injects this seam (production root: quiet-page archive read +
   * prefs dismiss; tests: fakes). DEFAULT IS ABSENCE: no seam, no seam fault,
   * no artifact — all render identically nothing.
   */
  readonly briefs?:
    | {
        readonly pending: () => Promise<readonly PendingBrief[]>;
        readonly onDismiss?: ((missionId: string) => void) | undefined;
      }
    | undefined;
  /**
   * E8-T07 dupe strip seam (Spec "marks, does not close" · roadmap action row
   * · ADR note e8-dupe-actions): `list` answers the current open-duplicate
   * groups; `park` is the ONE gesture (rides ParkDupeTabs at the v1.1 tier
   * flip; today composition injects the application service directly);
   * `onIgnore` records per-group dismiss. OPT-IN LAW: the surface never
   * calls `park` except from an explicit tap. Default: absence (no strip).
   */
  readonly dupes?:
    | {
        readonly list: () => Promise<readonly DupeGroupModel[]>;
        readonly park: (canonHash: string, keepBrowserTabId: number) => void;
        readonly onIgnore?: ((canonHash: string) => void) | undefined;
      }
    | undefined;
}

export interface Mounted {
  readonly unmount: () => void;
}

// ── wire-shaped read models (DTO mirrors; fields are §3.4/DTO contract fields) ──
interface OpenTabWire {
  readonly browserTabId: number;
  readonly windowId: number;
  readonly title: string;
  readonly url: string;
  readonly pinned: boolean;
  readonly active: boolean;
  readonly groupId: number | null;
}

interface BootstrapWire {
  readonly missions: readonly Record<string, unknown>[];
  readonly recentlyClosed: readonly Record<string, unknown>[];
  readonly trashCount: number;
  readonly watermark: number;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly heartbeat: {
    readonly keptCount: number;
    readonly liveRecoverable: number;
    readonly asOf: number;
  };
}

const asString = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const asNumber = (v: unknown, fallback = 0): number => (typeof v === 'number' ? v : fallback);
const asBool = (v: unknown): boolean => v === true;
const asRecords = (v: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(v)
    ? (v.filter((x) => typeof x === 'object' && x !== null) as Record<string, unknown>[])
    : [];

const missionModelOf = (
  raw: Record<string, unknown>,
  settings: Readonly<Record<string, unknown>>,
): MissionCardModel => {
  const missionId = asString(raw['missionId']);
  return {
    missionId,
    name: asString(raw['name'], missionId),
    namedBy: asString(raw['namedBy'], 'system'),
    state: asString(raw['state'], 'live'),
    concluded: raw['concluded'] === true,
    ...(typeof raw['lastActiveAt'] === 'number' ? { lastActiveAt: raw['lastActiveAt'] } : {}),
    tabCount: Array.isArray(raw['tabIds']) ? raw['tabIds'].length : asNumber(raw['tabCount'], 0),
    favorite: settings[`favorite.mission.${missionId}`] === true,
    pinned: settings[`pinnedMission.${missionId}`] === true,
  };
};

const openTabModelOf = (raw: Record<string, unknown>): OpenTabWire => ({
  browserTabId: asNumber(raw['browserTabId']),
  windowId: asNumber(raw['windowId']),
  title: asString(raw['title']),
  url: asString(raw['url']),
  pinned: asBool(raw['pinned']),
  active: asBool(raw['active']),
  groupId: typeof raw['groupId'] === 'number' ? raw['groupId'] : null,
});

const domainOf = (url: string): string => {
  // Presentation-only: strip scheme/host for the tile + subtitle. No canon logic
  // (Canon Law lives in the kernel); this is purely the visible label.
  const withoutScheme = url.replace(/^[a-z]+:\/\//i, '');
  return withoutScheme.split('/')[FIRST_INDEX] ?? withoutScheme;
};

export const mountGuardian = (doc: Document, deps: GuardianDeps): Mounted => {
  const client: WireClient = createWireClient({
    context: GUARDIAN_CONTEXT,
    transport: deps.transport,
    entropy: deps.entropy,
    ...(deps.contractHash !== undefined ? { contractHash: deps.contractHash } : {}),
  });
  const store: ViewStore = createViewStore();
  const live: LiveAnnouncer = ensureLiveRegion(doc, doc.body);
  const pill: HeartbeatPill = createHeartbeatPill(doc);

  let settings: Readonly<Record<string, unknown>> = {};
  let openTabs: readonly OpenTabWire[] = [];
  let booted = false;

  const root = el(doc, 'main', {
    cls: 'surface guardian',
    attrs: { 'data-surface': 'guardian' },
  });

  const bannerSlot = el(doc, 'div', { cls: 'banner-slot', attrs: { 'data-slot': 'banner' } });
  const header = el(doc, 'header', { cls: 'guardian-head' });
  const pendingStrip = el(doc, 'div', {
    cls: 'pending-strip',
    attrs: { 'data-section': 'pending', role: 'group', 'aria-label': copyOf('msg.aria.pending') },
  });
  const recoverySlot = el(doc, 'div', {
    cls: 'recovery-slot',
    attrs: { 'data-section': 'recovery' },
  });
  // E8-T07: the dupe strip sits with the open-tab inventory it relieves —
  // groups visible ⇒ one-tap relief; absent ⇒ nothing renders (no stub).
  const dupeSlot = el(doc, 'section', {
    cls: 'guardian-dupes',
    attrs: { 'data-section': 'dupes', 'aria-label': copyOf('msg.aria.dupes') },
  });
  const openSection = el(doc, 'section', {
    cls: 'guardian-open',
    attrs: { 'data-section': 'open', 'aria-label': copyOf('msg.aria.tabs') },
  });
  // E8-T05 · W5: the brief slot sits at the window top of the resumption area
  // (above the mission cards); absence renders an empty slot, never a stub.
  const briefSlot = el(doc, 'section', {
    cls: 'guardian-briefs',
    attrs: { 'data-section': 'briefs', 'aria-label': copyOf('msg.aria.brief') },
  });
  const missionsSection = el(doc, 'section', {
    cls: 'guardian-missions',
    attrs: { 'data-section': 'missions', 'aria-label': copyOf('msg.aria.missions') },
  });
  const startSection = el(doc, 'section', {
    cls: 'guardian-start',
    attrs: { 'data-section': 'start' },
  });

  header.appendChild(pill.el);
  root.appendChild(bannerSlot);
  root.appendChild(header);
  root.appendChild(pendingStrip);
  root.appendChild(recoverySlot);
  root.appendChild(dupeSlot);
  root.appendChild(openSection);
  root.appendChild(briefSlot);
  root.appendChild(missionsSection);
  root.appendChild(startSection);
  doc.body.appendChild(root);

  // ── E8-T05 brief slot (W5: shown ONCE per mount, dismissible per-mission) ──
  // Session memory: shown-once is a mount-scoped stamp (a re-seed never
  // resurfaces the same brief); dismissal outranks everything and rides the
  // seam so the app can record it forever (Spec §6.9).
  const briefShownThisMount = new Set<string>();
  const briefDismissed = new Set<string>();

  const renderBriefs = (): void => {
    const seam = deps.briefs;
    if (seam === undefined || !booted) {
      clearChildren(briefSlot);
      return; // absence-by-default (silent posture)
    }
    void seam
      .pending()
      .then((pending) => {
        // Reconcile, never wipe-and-redraw: a card already shown STAYS shown
        // until dismissed or its brief stops being pending (W5's "shown once"
        // is sticky — a later seed never resurfaces AND never erases it).
        const alive = new Set(pending.map((b) => b.missionId));
        for (const card of briefSlot.querySelectorAll('[data-widget="brief-card"]')) {
          const id = card.getAttribute('data-mission-id') ?? '';
          if (!alive.has(id) || briefDismissed.has(id)) card.remove();
        }
        for (const brief of pending) {
          if (briefDismissed.has(brief.missionId)) continue;
          if (briefShownThisMount.has(brief.missionId)) continue;
          briefShownThisMount.add(brief.missionId);
          briefSlot.appendChild(
            renderBriefCard(doc, brief, {
              onResume: (missionId) => {
                runCommand('ResumeMission', { missionId, mode: 'full' });
              },
              onDismiss: (missionId) => {
                briefDismissed.add(missionId);
                briefSlot.querySelector(`[data-mission-id="${missionId}"]`)?.remove();
                seam.onDismiss?.(missionId);
              },
            }),
          );
        }
      })
      .catch(() => {
        // Seam fault = absence for NEW briefs (calm degrade): cards already
        // shown were true when written and stay; nothing new renders.
      });
  };

  // ── E8-T07 dupe strip (opt-in law: `park` fires ONLY from a tap) ─────────
  // Unlike briefs there is no shown-once stickiness: groups are fresh truth
  // per pull — parked groups dissolve, ignored groups stay dismissed via the
  // seam's memory (the strip itself keeps no truth).
  const renderDupeSlot = (): void => {
    const seam = deps.dupes;
    if (seam === undefined || !booted) {
      clearChildren(dupeSlot);
      return; // absence-by-default
    }
    void seam
      .list()
      .then((groups) => {
        clearChildren(dupeSlot);
        if (groups.length === 0) return; // calm absence — no relief needed
        dupeSlot.appendChild(
          renderDupeStrip(doc, groups, {
            onPark: (canonHash, keepBrowserTabId) => {
              seam.park(canonHash, keepBrowserTabId);
              // Truth re-pull: parked rows stop being live; the strip
              // re-derives from the next list (never optimistic removal of
              // anything the park did not actually take).
              renderDupeSlot();
            },
            onIgnore: (canonHash) => {
              seam.onIgnore?.(canonHash);
              dupeSlot.querySelector(`[data-canon-hash="${canonHash}"]`)?.remove();
            },
          }),
        );
      })
      .catch(() => {
        // Seam fault: the strip is a nicety — open tabs below remain truth.
      });
  };

  // ── renderers (pure presentation of current local state) ──────────────────────
  const renderPending = (): void => {
    clearChildren(pendingStrip);
    const ops = client.pending();
    for (const op of ops) {
      pendingStrip.appendChild(
        el(doc, 'span', {
          cls: 'chip chip-pending',
          text: copyOf('msg.state.pending'),
          attrs: { 'data-cid': op.cid, 'data-command': op.name, 'data-phase': op.phase },
        }),
      );
    }
  };

  const showError = (error: WireError, retry: () => void): void => {
    clearChildren(bannerSlot);
    bannerSlot.appendChild(
      renderStateBlock(doc, {
        kind: 'error',
        copyKey: 'msg.error.output',
        error,
        retry: { onRetry: retry },
      }),
    );
  };

  const showResyncBanner = (update: boolean): void => {
    clearChildren(bannerSlot);
    if (!update) {
      bannerSlot.appendChild(
        el(doc, 'div', {
          cls: 'banner banner-resync',
          text: copyOf('msg.note.resync-needed'),
          attrs: { 'data-banner': 'resync', role: 'status' },
        }),
      );
      return;
    }
    // Schema resync rides the generic error + recovery pair (catalog law).
    bannerSlot.appendChild(
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
  };

  /** Command runner — the only way this surface mutates anything. */
  const runCommand = (name: string, payload: unknown, after?: () => void): OperationHandle => {
    const op = client.command(name, payload);
    renderPending();
    void op.ack.then(() => renderPending());
    void op.terminal.then((t) => {
      renderPending();
      if (!t.ok) {
        showError(t.error, () => {
          void runCommand(name, payload, after);
        });
        return;
      }
      after?.();
    });
    return op;
  };

  const renderOpenTabs = (): void => {
    clearChildren(openSection);
    openSection.appendChild(
      el(doc, 'h2', { cls: 'section-title', text: copyOf('msg.section.open-now') }),
    );
    if (!booted) {
      openSection.appendChild(renderLoading(doc));
      return;
    }
    if (openTabs.length === 0) {
      openSection.appendChild(renderStateBlock(doc, { kind: 'empty', copyKey: 'msg.empty.strip' }));
      return;
    }
    const byWindow = new Map<number, OpenTabWire[]>();
    for (const tab of openTabs) {
      const bucket = byWindow.get(tab.windowId) ?? [];
      bucket.push(tab);
      byWindow.set(tab.windowId, bucket);
    }
    for (const [windowId, tabs] of byWindow) {
      const windowBlock = el(doc, 'div', {
        cls: 'window-block',
        attrs: { 'data-window-id': String(windowId) },
      });
      const windowBar = el(doc, 'div', { cls: 'window-bar' });
      windowBar.appendChild(
        el(doc, 'span', {
          cls: 'window-count',
          text: copyOf('msg.count.tabs', { count: tabs.length }),
        }),
      );
      windowBar.appendChild(
        actionButton(doc, {
          copyKey: 'msg.action.park-window',
          action: 'park-window',
          onClick: () => {
            runCommand('ParkWindow', { windowId });
          },
        }),
      );
      windowBlock.appendChild(windowBar);
      const list = el(doc, 'ul', { cls: 'tab-list', attrs: { role: 'list' } });
      const groups = new Set<number>();
      for (const tab of tabs) {
        if (tab.groupId !== null && tab.groupId !== GROUP_NONE && tab.groupId !== NO_GROUP_ID)
          groups.add(tab.groupId);
        const model: TabRowModel = {
          id: String(tab.browserTabId),
          title: tab.title,
          domain: domainOf(tab.url),
          url: tab.url,
          state: 'open',
          pinned: tab.pinned,
        };
        list.appendChild(
          renderTabRow(doc, model, [
            actionButton(doc, {
              copyKey: 'msg.action.park-tab',
              action: 'park-tab',
              onClick: () => {
                runCommand('ParkTab', { browserTabId: tab.browserTabId });
              },
            }),
          ]),
        );
      }
      for (const groupId of groups) {
        list.appendChild(
          el(doc, 'li', {
            cls: 'group-row',
            attrs: { 'data-group-id': String(groupId) },
            children: [
              actionButton(doc, {
                copyKey: 'msg.action.park-group',
                action: 'park-group',
                onClick: () => {
                  runCommand('ParkGroup', { groupId });
                },
              }),
            ],
          }),
        );
      }
      windowBlock.appendChild(list);
      openSection.appendChild(windowBlock);
    }
    openSection.appendChild(
      actionButton(doc, {
        copyKey: 'msg.action.park-all',
        action: 'park-all',
        primary: true,
        onClick: () => {
          runCommand('ParkAll', {});
        },
      }),
    );
  };

  const renderMissions = (): void => {
    clearChildren(missionsSection);
    missionsSection.appendChild(
      el(doc, 'h2', { cls: 'section-title', text: copyOf('msg.section.missions') }),
    );
    if (!booted) return;
    const missions = store
      .rows('missions')
      .map((r) => missionModelOf(r, settings))
      .filter((m) => m.state !== 'trash');
    if (missions.length === 0) {
      missionsSection.appendChild(
        renderStateBlock(doc, { kind: 'empty', copyKey: 'msg.empty.library' }),
      );
      return;
    }
    const grid = el(doc, 'div', { cls: 'mission-grid', attrs: { role: 'list' } });
    for (const mission of missions) {
      const children: HTMLElement[] = [];
      if (mission.state === 'parked') {
        children.push(
          actionButton(doc, {
            copyKey: 'msg.action.resume',
            action: 'resume',
            primary: true,
            onClick: () => {
              runCommand('ResumeMission', { missionId: mission.missionId, mode: 'full' });
            },
          }),
        );
      }
      grid.appendChild(renderMissionCard(doc, mission, { children }));
    }
    missionsSection.appendChild(grid);
  };

  const renderStart = (): void => {
    clearChildren(startSection);
    const nameInput = el(doc, 'input', {
      cls: 'start-name',
      attrs: {
        type: 'text',
        'data-field': 'mission-name',
        placeholder: copyOf('msg.hint.name-optional'),
        'aria-label': copyOf('msg.section.detail'),
        maxlength: '120',
      },
    });
    const startButton = actionButton(doc, {
      copyKey: 'msg.action.start-mission',
      action: 'start-mission',
      primary: true,
      onClick: () => {
        const name = inputValue(nameInput).trim();
        runCommand('StartMission', name.length > 0 ? { name } : {});
      },
    });
    const undoButton = actionButton(doc, {
      copyKey: 'msg.action.undo',
      action: 'undo',
      onClick: () => {
        runUndo();
      },
    });
    const form = el(doc, 'div', {
      cls: 'start-form',
      children: [nameInput, startButton, undoButton],
    });
    startSection.appendChild(form);
  };

  const runUndo = (): void => {
    const op = client.command('Undo', {});
    renderPending();
    void op.terminal.then((t) => {
      renderPending();
      if (!t.ok) {
        live.say(copyOf(t.error.messageKey ?? 'msg.undo.empty'));
        return;
      }
      const result = t.value as { undid?: unknown } | null;
      const label = typeof result?.undid === 'string' ? result.undid : 'msg.undo.done';
      live.say(copyOf(label));
      void refreshAll();
    });
  };

  const renderAll = (): void => {
    renderPending();
    renderOpenTabs();
    renderMissions();
    renderStart();
  };

  const applyBootstrap = (value: unknown): void => {
    const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<
      string,
      unknown
    >;
    const b: BootstrapWire = {
      missions: asRecords(raw['missions']),
      recentlyClosed: asRecords(raw['recentlyClosed']),
      trashCount: asNumber(raw['trashCount']),
      watermark: asNumber(raw['watermark']),
      settings:
        typeof raw['settings'] === 'object' && raw['settings'] !== null
          ? (raw['settings'] as Record<string, unknown>)
          : {},
      heartbeat:
        typeof raw['heartbeat'] === 'object' && raw['heartbeat'] !== null
          ? (raw['heartbeat'] as BootstrapWire['heartbeat'])
          : { keptCount: 0, liveRecoverable: 0, asOf: 0 },
    };
    settings = b.settings;
    store.seed('missions', b.missions, undefined);
    pill.update(b.heartbeat);
    live.say(
      b.heartbeat.keptCount > 0
        ? copyOf('msg.heartbeat.safe', { count: b.heartbeat.keptCount })
        : copyOf('msg.heartbeat.quiet'),
    );
    booted = true;
    // E8-T05: briefs render at boot completion (the store seed fires while
    // `booted` is still false — the once-per-mount render belongs HERE, with
    // later seeds only reconciling dismissals/removals).
    renderBriefs();
    // E8-T07: the dupe strip's first pull (later seeds re-pull via the store
    // subscription; every render is fresh truth — groups dissolve on park).
    renderDupeSlot();
    // First-run posture: nothing kept and nothing parked ⇒ offer FirstRunIngest.
    if (b.heartbeat.keptCount === 0 && b.missions.length === 0) {
      clearChildren(recoverySlot);
      recoverySlot.appendChild(
        el(doc, 'div', {
          cls: 'first-run-card',
          attrs: { 'data-card': 'first-run' },
          children: [
            el(doc, 'p', { cls: 'state-line', text: copyOf('msg.hint.first-run') }),
            actionButton(doc, {
              copyKey: 'msg.action.first-run',
              action: 'first-run',
              primary: true,
              onClick: () => {
                clearChildren(recoverySlot);
                runCommand('FirstRunIngest', {}, () => {
                  void refreshAll();
                });
              },
            }),
          ],
        }),
      );
    }
  };

  const refreshPeek = (): void => {
    const peek = client.query('PeekOpenTabs', {});
    void peek.terminal.then((t) => {
      if (!t.ok) return;
      openTabs = asRecords(t.value).map(openTabModelOf);
      renderOpenTabs();
    });
  };

  const refreshBootstrap = (): void => {
    const boot = client.query('GetBootstrap', { surface: GUARDIAN_CONTEXT });
    void boot.terminal.then((t) => {
      if (!t.ok) {
        if (!booted)
          showError(t.error, () => {
            refreshBootstrap();
          });
        return;
      }
      applyBootstrap(t.value);
      renderAll();
    });
  };

  const refreshAll = (): void => {
    refreshBootstrap();
    refreshPeek();
  };

  /** Full snapshot rejoin — the ONLY legal response to a stream gap/resync (§3.5). */
  const rejoin = (): void => {
    store.dispose();
    booted = false;
    clearChildren(bannerSlot);
    bannerSlot.appendChild(
      el(doc, 'div', {
        cls: 'banner banner-resync',
        text: copyOf('msg.state.resync'),
        attrs: { 'data-banner': 'resync', role: 'status' },
      }),
    );
    renderOpenTabs();
    refreshAll();
  };

  // ── stream subscriptions (§3.5): deltas feed the store; terminals settle ops ──
  const detachStreams = client.subscribe({
    ViewDelta: (payload) => {
      const frame = viewFrameOf(payload);
      if (frame === undefined) return;
      const result = store.applyFrame(frame);
      if (result === 'gap') {
        rejoin();
        return;
      }
      if (result === 'applied' && (frame.view === 'missions' || frame.view === 'tabs'))
        renderMissions();
    },
    HeartbeatUpdate: (payload) => {
      const p = payload as Record<string, unknown>;
      const data = {
        keptCount: asNumber(p['keptCount']),
        liveRecoverable: asNumber(p['liveRecoverable']),
        asOf: asNumber(p['asOf']),
      };
      pill.update(data);
      live.say(copyOf('msg.heartbeat.safe', { count: data.keptCount }));
    },
    RecoveryAvailable: (payload) => {
      const p = payload as Record<string, unknown>;
      const severity = asString(p['severity']);
      // §14.4 (E6-T01 realignment): the CARD venue is the quiet tab and only on
      // loss-risk — the guardian strip renders the calm heartbeat state for both
      // severities: a subdued chip for clean-abnormal, a card-marked line when a
      // loss-risk card awaits on the quiet page.
      clearChildren(recoverySlot);
      recoverySlot.appendChild(
        el(doc, 'div', {
          cls: severity === 'clean-abnormal' ? 'recovery-chip' : 'recovery-card',
          attrs: { 'data-card': 'recovery', 'data-severity': severity, role: 'status' },
          children: [el(doc, 'p', { cls: 'state-line', text: copyOf('msg.heartbeat.recovered') })],
        }),
      );
    },
    ResyncRequired: (payload) => {
      const p = payload as Record<string, unknown>;
      const reason = asString(p['reason']);
      if (reason === 'schema') {
        showResyncBanner(true); // calm update prompt — never silent partial (§3.5 comp)
      } else {
        rejoin();
      }
    },
    CommandAck: () => renderPending(),
    CommandApplied: () => {
      renderPending();
      refreshPeek();
    },
    CommandFailed: () => renderPending(),
  });

  const detachStore = store.subscribe((event) => {
    if (event.kind === 'seed') {
      renderMissions();
      // E8-T05: briefs ride the bootstrap seed (the once-per-mount stamp keeps
      // any later seed from resurfacing a card the user already saw).
      renderBriefs();
      // E8-T07: open-tab truth moved — re-derive the strip (parked groups
      // dissolve; the seam's settings memory keeps ignores).
      renderDupeSlot();
    }
  });

  const detachWake = deps.onWake?.(() => {
    refreshAll();
  });

  const detachKeys = bindKeys(doc.body, [
    { combo: 'u', run: () => runUndo() },
    { combo: 'meta+z', run: () => runUndo() },
    { combo: 'ctrl+z', run: () => runUndo() },
    {
      combo: 'r',
      run: () => {
        refreshAll();
      },
    },
  ]);

  // Boot: shell renders instantly; data arrives via the query bus (FCR posture).
  renderOpenTabs();
  renderMissions();
  renderStart();
  refreshAll();

  return {
    unmount: () => {
      detachStreams();
      detachStore();
      detachKeys();
      detachWake?.();
      store.dispose();
      client.dispose();
      live.dispose();
      root.remove();
    },
  };
};
