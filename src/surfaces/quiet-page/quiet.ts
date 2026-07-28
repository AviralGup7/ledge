// E4 · Quiet page surface (Spec §6.4 / EES §2.16: missions, Archive, Recently
// Closed, Trash, settings, import/export, rescue console — a place of business).
// Authority-free by law: sections render query DTOs, actions send commands, the
// store mirrors §3.5 deltas mechanically. No business logic, no storage, no
// chrome APIs — presentation + wire only.
import type { SenderContext } from '@/application/contracts/index.js';
import type { ImportStageWriter } from '../components/session/import-stage.js';
import { copyOf } from '../components/copy/copy.js';
import { relTimeOf } from '../components/copy/reltime.js';
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
import {
  actionButton,
  renderMissionCard,
  type MissionCardModel,
} from '../components/widgets/mission-card.js';
import { renderTabRow } from '../components/widgets/tab-row.js';
import { renderLoading, renderStateBlock } from '../components/widgets/states.js';

const QUIET_CONTEXT: SenderContext = 'quiet';
const ACTIVITY_LIMIT = 50;
const SETTING_KEYS = [
  'trash.retentionDays',
  'trash.bulkConfirmThreshold',
  'undo.stackCap',
  'park.allWindowMs',
  'heartbeat.windowMs',
  'recentlyClosed.retentionDays',
] as const;
const SETTING_COPY: Readonly<Record<string, string>> = {
  'trash.retentionDays': 'msg.setting.retention',
  'trash.bulkConfirmThreshold': 'msg.setting.bulk-threshold',
  'undo.stackCap': 'msg.setting.undo-cap',
  'park.allWindowMs': 'msg.setting.park-window',
  'heartbeat.windowMs': 'msg.setting.heartbeat-window',
  'recentlyClosed.retentionDays': 'msg.setting.closed-retention',
};

export interface QuietDeps {
  readonly transport: WireTransport;
  readonly entropy: CidEntropy;
  readonly onWake?: ((listener: () => void) => () => void) | undefined;
  readonly contractHash?: string | undefined;
  /** E5-T06 bytes shelf writer (composed by the page root; undefined ⇒ previews
   *  answer the adapter's honest 'import-bytes' refusal). */
  readonly importBytesStage?: ImportStageWriter | undefined;
}

export interface Mounted {
  readonly unmount: () => void;
}

type SectionKey =
  | 'library'
  | 'archive'
  | 'closed'
  | 'trash'
  | 'activity'
  | 'history'
  | 'settings'
  | 'import-export'
  | 'rescue';

const SECTIONS: readonly { readonly key: SectionKey; readonly copyKey: string }[] = [
  { key: 'library', copyKey: 'msg.section.library' },
  { key: 'archive', copyKey: 'msg.section.archive' },
  { key: 'closed', copyKey: 'msg.section.closed' },
  { key: 'trash', copyKey: 'msg.section.trash' },
  { key: 'activity', copyKey: 'msg.section.activity' },
  { key: 'history', copyKey: 'msg.section.history' },
  { key: 'settings', copyKey: 'msg.section.settings' },
  { key: 'import-export', copyKey: 'msg.section.import-export' },
  { key: 'rescue', copyKey: 'msg.section.rescue' },
];

const asString = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const asCount = (v: string | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
const asNumber = (v: unknown, fallback = 0): number => (typeof v === 'number' ? v : fallback);
const asRecords = (v: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(v)
    ? (v.filter((x) => typeof x === 'object' && x !== null) as Record<string, unknown>[])
    : [];
const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export const mountQuietPage = (doc: Document, deps: QuietDeps): Mounted => {
  const client: WireClient = createWireClient({
    context: QUIET_CONTEXT,
    transport: deps.transport,
    entropy: deps.entropy,
    ...(deps.contractHash !== undefined ? { contractHash: deps.contractHash } : {}),
  });
  const store: ViewStore = createViewStore();
  const live: LiveAnnouncer = ensureLiveRegion(doc, doc.body);
  const pill: HeartbeatPill = createHeartbeatPill(doc);

  let settings: Readonly<Record<string, unknown>> = {};
  let currentSection: SectionKey = 'library';
  let booted = false;

  const root = el(doc, 'main', {
    cls: 'surface quiet-page',
    attrs: { 'data-surface': 'quiet' },
  });
  const bannerSlot = el(doc, 'div', { cls: 'banner-slot', attrs: { 'data-slot': 'banner' } });
  const header = el(doc, 'header', { cls: 'quiet-head' });
  const nav = el(doc, 'nav', {
    cls: 'quiet-nav',
    attrs: { role: 'navigation', 'aria-label': copyOf('msg.aria.nav'), 'data-widget': 'nav' },
  });
  const pendingStrip = el(doc, 'div', {
    cls: 'pending-strip',
    attrs: { 'data-section': 'pending', role: 'group', 'aria-label': copyOf('msg.aria.pending') },
  });
  const firstRunSlot = el(doc, 'div', { attrs: { 'data-slot': 'first-run' } });
  const streamsSlot = el(doc, 'div', { attrs: { 'data-slot': 'streams' } });
  /** E6-T01 · W7 card venue (§5.9/§14.4): sits above the sections, below the pill. */
  const recoverySlot = el(doc, 'div', { attrs: { 'data-slot': 'recovery' } });
  const content = el(doc, 'section', {
    cls: 'quiet-content',
    attrs: { 'data-section': 'content', tabindex: '0' },
  });

  header.appendChild(pill.el);
  root.appendChild(bannerSlot);
  root.appendChild(header);
  root.appendChild(nav);
  root.appendChild(pendingStrip);
  root.appendChild(firstRunSlot);
  root.appendChild(recoverySlot);
  root.appendChild(streamsSlot);
  root.appendChild(content);
  doc.body.appendChild(root);

  // ── shared shell helpers ─────────────────────────────────────────────────────
  const showError = (error: WireError, retry: () => void): void => {
    clearChildren(content);
    content.appendChild(
      renderStateBlock(doc, {
        kind: 'error',
        copyKey: 'msg.error.output',
        error,
        retry: { onRetry: retry },
      }),
    );
  };

  const showBanner = (key: string, kind: string): void => {
    clearChildren(bannerSlot);
    bannerSlot.appendChild(
      el(doc, 'div', {
        cls: 'banner',
        text: copyOf(key),
        attrs: { 'data-banner': kind, role: 'status' },
      }),
    );
  };

  // ── E6-T01 · W7 recovery card (§14.4: card ONLY on loss-risk, queried truth) ──
  // The stream is fire-and-forget, so the card never trusts it: every signal
  // re-queries GetBootReport and renders the returned DTO. Disclosure tokens are
  // mapped through a STATIC copy table (the copy census reads literal keys).
  interface BootReportWire {
    readonly bootReportId: string;
    readonly severity: string;
    readonly copyKey: string | null;
    readonly asOf: number;
    readonly scope: { readonly tabsRecoverable: number; readonly missionsAffected: number };
    readonly disclosure: readonly { readonly token: string; readonly count: number }[];
    /** E6-T02: the incident's boot-time candidate snapshot (absent ⟺ none taken). */
    readonly crossCheckCandidates?: readonly { readonly url: string; readonly title: string }[];
    readonly pending: boolean;
  }

  const DISCLOSURE_COPY: Readonly<Record<string, string>> = {
    'journal-truncate': 'msg.recovery.note-truncate',
    'left-open': 'msg.recovery.note-left-open',
    deferred: 'msg.recovery.note-deferred',
    'crosscheck-degraded': 'msg.recovery.note-crosscheck',
    'marker-gap': 'msg.recovery.note-marker-gap',
  };

  let recoveryView: BootReportWire | null = null;
  let reviewOpen = false;

  const asBootReport = (value: unknown): BootReportWire | null => {
    const raw = asRecord(value);
    if (typeof raw['bootReportId'] !== 'string') return null;
    const scope = asRecord(raw['scope']);
    return {
      bootReportId: raw['bootReportId'],
      severity: asString(raw['severity']),
      copyKey: typeof raw['copyKey'] === 'string' ? raw['copyKey'] : null,
      asOf: asNumber(raw['asOf']),
      scope: {
        tabsRecoverable: asNumber(scope['tabsRecoverable']),
        missionsAffected: asNumber(scope['missionsAffected']),
      },
      disclosure: asRecords(raw['disclosure']).map((d) => ({
        token: asString(d['token']),
        count: asNumber(d['count']),
      })),
      ...(raw['crossCheckCandidates'] !== undefined
        ? {
            crossCheckCandidates: asRecords(raw['crossCheckCandidates'])
              .map((c) => ({ url: asString(c['url']), title: asString(c['title']) }))
              .filter((c) => c.url.length > 0),
          }
        : {}),
      pending: raw['pending'] === true,
    };
  };

  /** Confirm-before-restore law: candidate urls the user toggled IN (default:
   *  excluded — nothing candidate-shaped rides the put-back uninvited). */
  let includedCandidates = new Set<string>();

  const renderRecovery = (): void => {
    clearChildren(recoverySlot);
    const view = recoveryView;
    if (view === null || !view.pending) return; // §14.4 gate rides the DTO
    // Toggle hygiene: only urls from THIS incident's snapshot stay armed.
    const snapshotUrls = new Set((view.crossCheckCandidates ?? []).map((c) => c.url));
    includedCandidates = new Set([...includedCandidates].filter((u) => snapshotUrls.has(u)));
    const titleKey = view.copyKey ?? 'msg.recovery.crashed';
    const card = el(doc, 'div', {
      cls: 'recovery-card',
      attrs: { 'data-card': 'recovery', 'data-severity': view.severity, role: 'status' },
    });
    card.appendChild(
      el(doc, 'p', {
        cls: 'state-line',
        text: copyOf(titleKey, { asOf: relTimeOf(view.asOf) }),
        attrs: { 'data-line': 'recovery-title' },
      }),
    );
    card.appendChild(
      el(doc, 'p', {
        cls: 'state-recovery',
        text: copyOf('msg.recovery.scope', {
          tabs: view.scope.tabsRecoverable,
          missions: view.scope.missionsAffected,
        }),
        attrs: { 'data-line': 'recovery-scope' },
      }),
    );
    const actions = el(doc, 'div', { cls: 'recovery-actions' });
    actions.appendChild(
      actionButton(doc, {
        copyKey: 'msg.action.put-back',
        action: 'put-back',
        primary: true,
        onClick: () => {
          runPutBack(view.bootReportId);
        },
      }),
    );
    if (view.disclosure.length > 0) {
      actions.appendChild(
        actionButton(doc, {
          copyKey: 'msg.action.review-first',
          action: 'review-first',
          onClick: () => {
            reviewOpen = !reviewOpen;
            renderRecovery();
          },
        }),
      );
    }
    card.appendChild(actions);
    // E6-T02 candidates panel (boot-time snapshot; hidden when none was taken or
    // the set came back empty — the card shows exactly what that boot observed).
    const candidates = view.crossCheckCandidates;
    if (candidates !== undefined && candidates.length > 0) {
      const panel = el(doc, 'div', {
        cls: 'recovery-candidates',
        attrs: { 'data-panel': 'recovery-candidates' },
      });
      panel.appendChild(
        el(doc, 'p', {
          cls: 'state-recovery',
          text: copyOf('msg.recovery.candidates-head', { count: candidates.length }),
          attrs: { 'data-line': 'recovery-candidates-head' },
        }),
      );
      const list = el(doc, 'ul', {
        cls: 'recovery-candidate-list',
        attrs: { role: 'list' },
      });
      for (const c of candidates) {
        const included = includedCandidates.has(c.url);
        const row = el(doc, 'li', {
          cls: 'recovery-candidate',
          attrs: { 'data-line': 'recovery-candidate', 'data-url': c.url },
        });
        row.appendChild(
          el(doc, 'button', {
            cls: included ? 'btn btn-candidate is-included' : 'btn btn-candidate',
            text: copyOf(
              included ? 'msg.action.exclude-candidate' : 'msg.action.include-candidate',
            ),
            attrs: {
              type: 'button',
              'data-action': 'include-candidate',
              'data-url': c.url,
              'aria-pressed': included ? 'true' : 'false',
            },
            on: {
              click: () => {
                if (includedCandidates.has(c.url)) includedCandidates.delete(c.url);
                else includedCandidates.add(c.url);
                renderRecovery();
              },
            },
          }),
        );
        row.appendChild(
          el(doc, 'span', {
            cls: 'recovery-candidate-title',
            text: c.title.length > 0 ? c.title : c.url,
            attrs: { 'data-line': 'recovery-candidate-title' },
          }),
        );
        list.appendChild(row);
      }
      panel.appendChild(list);
      card.appendChild(panel);
    }
    if (reviewOpen && view.disclosure.length > 0) {
      const notes = el(doc, 'ul', {
        cls: 'recovery-notes',
        attrs: { 'data-panel': 'recovery-review', role: 'list' },
      });
      for (const d of view.disclosure) {
        const key = DISCLOSURE_COPY[d.token];
        if (key === undefined) continue; // unknown token: tolerate, never throw
        notes.appendChild(
          el(doc, 'li', {
            text: copyOf(key, { count: d.count }),
            attrs: { 'data-line': `recovery-note-${d.token}` },
          }),
        );
      }
      card.appendChild(notes);
    }
    recoverySlot.appendChild(card);
  };

  const resolveRecovery = (card: {
    missionsRestored: number;
    disclosure: readonly string[];
  }): void => {
    // Settled outcomes: any content-gap token ⇒ the honest partial line.
    const partial = card.disclosure.some((t) => t === 'no-content' || t === 'mission-gone');
    const key = partial ? 'msg.recovery.restored-partial' : 'msg.recovery.restored';
    recoveryView = null;
    reviewOpen = false;
    includedCandidates = new Set();
    clearChildren(recoverySlot);
    recoverySlot.appendChild(
      el(doc, 'p', {
        cls: 'state-line',
        text: copyOf(key),
        attrs: { 'data-card': 'recovery-resolved', role: 'status' },
      }),
    );
    live.say(copyOf(key));
  };

  const runPutBack = (bootReportId: string): void => {
    // E6-T02 F2: the payload carries ONLY the toggled-in candidates, and only when
    // this card's incident actually snapshotted a candidate set (additive wire).
    const snapshotTaken = recoveryView?.crossCheckCandidates !== undefined;
    const payload: Record<string, unknown> = { bootReportId };
    if (snapshotTaken) payload['includeCandidates'] = [...includedCandidates];
    runCommand('RestoreBootSession', payload, (value) => {
      const result = asRecord(value);
      resolveRecovery({
        missionsRestored: asNumber(result['missionsRestored']),
        disclosure: Array.isArray(result['disclosure'])
          ? (result['disclosure'] as unknown[]).filter((x): x is string => typeof x === 'string')
          : [],
      });
    });
  };

  /** Truth re-query — the ONLY way the card comes or goes (streams merely hint). */
  const refreshRecovery = (): void => {
    const q = client.query('GetBootReport', {});
    void q.terminal.then((t) => {
      if (!t.ok) return; // a report read failure never fabricates a card
      recoveryView = asBootReport(t.value);
      renderRecovery();
    });
  };

  const renderPending = (): void => {
    clearChildren(pendingStrip);
    for (const op of client.pending()) {
      pendingStrip.appendChild(
        el(doc, 'span', {
          cls: 'chip chip-pending',
          text: copyOf('msg.state.pending'),
          attrs: { 'data-cid': op.cid, 'data-command': op.name, 'data-phase': op.phase },
        }),
      );
    }
  };

  const runCommand = (
    name: string,
    payload: unknown,
    after?: (value: unknown) => void,
    onError?: (error: WireError) => void,
  ): OperationHandle => {
    const op = client.command(name, payload);
    renderPending();
    void op.terminal.then((t) => {
      renderPending();
      if (!t.ok) {
        if (onError !== undefined) {
          onError(t.error);
          return;
        }
        showError(t.error, () => {
          void runCommand(name, payload, after, onError);
        });
        return;
      }
      after?.(t.value);
    });
    return op;
  };

  const loadQuery = (name: string, payload: unknown, render: (value: unknown) => void): void => {
    // Stale-response guard: the answer belongs to the section that asked. A late
    // terminal arriving after a nav switch must never clobber the live section
    // (nav aria-current and content would desync — a defect class, not a style).
    const sectionAtFire = currentSection;
    clearChildren(content);
    content.appendChild(renderLoading(doc));
    const q = client.query(name, payload);
    void q.terminal.then((t) => {
      if (sectionAtFire !== currentSection) return;
      if (!t.ok) {
        showError(t.error, () => loadQuery(name, payload, render));
        return;
      }
      render(t.value);
    });
  };

  // ── library + detail ─────────────────────────────────────────────────────────
  const missionModelOf = (raw: Record<string, unknown>): MissionCardModel => {
    const missionId = asString(raw['missionId']);
    return {
      missionId,
      name: asString(raw['name'], missionId),
      namedBy: asString(raw['namedBy'], 'system'),
      state: asString(raw['state'], 'live'),
      concluded: raw['concluded'] === true,
      ...(asString(raw['outcomeNote']).length > 0
        ? { outcomeNote: asString(raw['outcomeNote']) }
        : {}),
      ...(typeof raw['lastActiveAt'] === 'number' ? { lastActiveAt: raw['lastActiveAt'] } : {}),
      tabCount: Array.isArray(raw['tabIds']) ? raw['tabIds'].length : asNumber(raw['tabCount']),
      favorite: settings[`favorite.mission.${missionId}`] === true,
      pinned: settings[`pinnedMission.${missionId}`] === true,
    };
  };

  const confirmLane = (
    doc2: Document,
    hintKey: string,
    onConfirm: () => void,
    onCancel: () => void,
  ): HTMLElement => {
    const lane = el(doc2, 'div', { cls: 'confirm-lane', attrs: { 'data-lane': 'confirm' } });
    lane.appendChild(el(doc2, 'p', { cls: 'state-line', text: copyOf(hintKey) }));
    lane.appendChild(
      actionButton(doc2, {
        copyKey: 'msg.action.confirm',
        action: 'confirm',
        danger: true,
        onClick: onConfirm,
      }),
    );
    lane.appendChild(
      actionButton(doc2, { copyKey: 'msg.action.cancel', action: 'cancel', onClick: onCancel }),
    );
    return lane;
  };

  // E8-T10 · W12: the conclude lane — optional outcome note (user-authored,
  // verbatim), one confirm, one cancel. No modal: the lane IS the detail
  // surface's content while the gesture is open (house confirm idiom).
  const concludeLane = (doc2: Document, missionId: string): HTMLElement => {
    const lane = el(doc2, 'div', { cls: 'conclude-lane', attrs: { 'data-lane': 'conclude' } });
    lane.appendChild(el(doc2, 'p', { cls: 'state-line', text: copyOf('msg.hint.conclude-note') }));
    const note = el(doc2, 'textarea', {
      cls: 'conclude-note-input',
      attrs: {
        'data-input': 'conclude-note',
        rows: '3',
        maxlength: '2000',
        'aria-label': copyOf('msg.aria.conclude-note'),
        placeholder: copyOf('msg.hint.conclude-note'),
      },
    }) as HTMLTextAreaElement;
    lane.appendChild(note);
    const row = el(doc2, 'div', { cls: 'conclude-lane-actions' });
    row.appendChild(
      actionButton(doc2, {
        copyKey: 'msg.action.conclude',
        action: 'conclude-note',
        primary: true,
        onClick: () => {
          const value = note.value.trim();
          runCommand(
            'ConcludeMission',
            {
              missionId,
              ...(value.length > 0 ? { outcomeNote: value } : {}),
            },
            () => {
              renderSection('library');
            },
          );
        },
      }),
    );
    row.appendChild(
      actionButton(doc2, {
        copyKey: 'msg.action.cancel',
        action: 'conclude-cancel',
        onClick: () => {
          renderSection('library');
        },
      }),
    );
    lane.appendChild(row);
    return lane;
  };

  const renderDetail = (value: unknown): void => {
    const detail = asRecord(value);
    const mission = asRecord(detail['mission']);
    const tabs = asRecords(detail['tabs']);
    const artifacts = asRecords(detail['artifacts']);
    const missionModel = missionModelOf(mission);
    clearChildren(content);
    const head = el(doc, 'div', { cls: 'detail-head' });
    head.appendChild(
      actionButton(doc, {
        copyKey: 'msg.action.close',
        action: 'detail-close',
        onClick: () => renderSection(currentSection),
      }),
    );
    content.appendChild(head);
    const actions: HTMLElement[] = [];
    if (missionModel.state === 'parked') {
      actions.push(
        actionButton(doc, {
          copyKey: 'msg.action.resume',
          action: 'resume',
          primary: true,
          onClick: () => {
            runCommand('ResumeMission', { missionId: missionModel.missionId, mode: 'full' }, () => {
              renderSection('library');
            });
          },
        }),
      );
    }
    actions.push(
      actionButton(doc, {
        copyKey: 'msg.action.archive',
        action: 'archive',
        onClick: () => {
          runCommand('ArchiveMission', { missionId: missionModel.missionId }, () => {
            renderSection('archive');
          });
        },
      }),
    );
    if (missionModel.state === 'parked' || missionModel.state === 'archived') {
      actions.push(
        actionButton(doc, {
          copyKey: 'msg.action.conclude',
          action: 'conclude',
          onClick: () => {
            // E8-T10 · W12: conclude opens the note lane — the closure gesture
            // carries the optional outcome note INTO the same command (never a
            // second wire name; a blank note rides note-less, per the domain).
            clearChildren(content);
            content.appendChild(concludeLane(doc, missionModel.missionId));
          },
        }),
      );
    }
    actions.push(
      actionButton(doc, {
        copyKey: 'msg.action.favorite',
        action: 'favorite',
        onClick: () => {
          runCommand(
            'SetFavorite',
            {
              entityKind: 'mission',
              id: missionModel.missionId,
              favor: missionModel.favorite !== true,
            },
            () => {
              void refreshBootstrap(() => {
                renderDetail(value);
              });
            },
          );
        },
      }),
      actionButton(doc, {
        copyKey: 'msg.action.delete',
        action: 'trash-mission',
        danger: true,
        onClick: () => {
          clearChildren(content);
          content.appendChild(
            confirmLane(
              doc,
              'msg.hint.confirm-delete',
              () => {
                runCommand('DeleteEntity', { kind: 'mission', id: missionModel.missionId }, () => {
                  renderSection('library');
                });
              },
              () => renderDetail(value),
            ),
          );
        },
      }),
    );
    content.appendChild(renderMissionCard(doc, missionModel, { children: actions }));

    // Topics (W16 chip-editable): read artifacts, teach via CorrectTopic.
    const topicsBlock = el(doc, 'div', { cls: 'topics-block', attrs: { 'data-block': 'topics' } });
    topicsBlock.appendChild(
      el(doc, 'h3', { cls: 'section-title', text: copyOf('msg.section.detail') }),
    );
    const chipRow = el(doc, 'div', { cls: 'topic-chips' });
    const topicValues = artifacts
      .filter((a) => asString(a['kind']) === 'topic')
      .map((a) =>
        typeof a['value'] === 'string' ? a['value'] : asString(asRecord(a['value'])['topic']),
      );
    if (topicValues.length === 0) {
      chipRow.appendChild(
        el(doc, 'p', { cls: 'state-recovery', text: copyOf('msg.empty.topics') }),
      );
    }
    for (const topic of topicValues) {
      chipRow.appendChild(el(doc, 'span', { cls: 'chip chip-topic', text: topic }));
    }
    topicsBlock.appendChild(chipRow);
    const teachInput = el(doc, 'input', {
      cls: 'teach-input',
      attrs: {
        type: 'text',
        'data-field': 'topic',
        placeholder: copyOf('msg.hint.topics'),
        'aria-label': copyOf('msg.action.teach'),
      },
    });
    topicsBlock.appendChild(
      el(doc, 'div', {
        cls: 'teach-row',
        children: [
          teachInput,
          actionButton(doc, {
            copyKey: 'msg.action.teach',
            action: 'correct-topic',
            onClick: () => {
              const v = inputValue(teachInput).trim();
              if (v.length === 0) return;
              runCommand('CorrectTopic', { subjectId: missionModel.missionId, value: v }, () => {
                live.say(copyOf('msg.dialog.topic-saved'));
              });
            },
          }),
        ],
      }),
    );
    content.appendChild(topicsBlock);

    const list = el(doc, 'ul', {
      cls: 'tab-list',
      attrs: { role: 'list', 'aria-label': copyOf('msg.aria.tabs') },
    });
    for (const tab of tabs) {
      list.appendChild(
        renderTabRow(doc, {
          id: asString(tab['tabId']),
          title: asString(tab['title']),
          domain: asString(tab['domain']),
          ...(typeof tab['url'] === 'string' ? { url: tab['url'] } : {}),
          state: asString(tab['state'], 'kept'),
        }),
      );
    }
    if (tabs.length === 0) {
      content.appendChild(renderStateBlock(doc, { kind: 'empty', copyKey: 'msg.empty.detail' }));
    } else {
      content.appendChild(list);
    }
  };

  const renderLibrary = (state: 'all' | 'archived'): void => {
    const payloads = state === 'archived' ? { filter: { state: 'archived' } } : {};
    loadQuery('GetLibrary', payloads, (value) => {
      const page = asRecord(value);
      const missions = asRecords(page['missions']).map(missionModelOf);
      clearChildren(content);
      content.appendChild(
        el(doc, 'h2', {
          cls: 'section-title',
          text: copyOf(state === 'archived' ? 'msg.section.archive' : 'msg.section.library'),
        }),
      );
      if (missions.length === 0) {
        content.appendChild(
          renderStateBlock(doc, {
            kind: 'empty',
            copyKey: state === 'archived' ? 'msg.empty.archive' : 'msg.empty.library',
          }),
        );
        return;
      }
      const grid = el(doc, 'div', { cls: 'mission-grid', attrs: { role: 'list' } });
      for (const mission of missions) {
        const children: HTMLElement[] = [
          actionButton(doc, {
            copyKey: 'msg.action.details',
            action: 'open-detail',
            onClick: () => {
              loadQuery('GetMissionDetail', { missionId: mission.missionId }, renderDetail);
            },
          }),
        ];
        if (mission.state === 'parked') {
          children.push(
            actionButton(doc, {
              copyKey: 'msg.action.resume',
              action: 'resume',
              primary: true,
              onClick: () => {
                runCommand('ResumeMission', { missionId: mission.missionId, mode: 'full' }, () => {
                  renderSection(currentSection);
                });
              },
            }),
          );
        }
        if (mission.state === 'parked' || mission.state === 'archived') {
          children.push(
            actionButton(doc, {
              copyKey: 'msg.action.conclude',
              action: 'conclude',
              onClick: () => {
                runCommand('ConcludeMission', { missionId: mission.missionId }, () => {
                  renderSection('library');
                });
              },
            }),
          );
        }
        grid.appendChild(renderMissionCard(doc, mission, { children }));
      }
      content.appendChild(grid);
    });
  };

  const renderClosed = (): void => {
    loadQuery('GetRecentlyClosed', {}, (value) => {
      const page = asRecord(value);
      const source =
        asRecords(page['entries']).length > 0
          ? asRecords(page['entries'])
          : asRecords(page['items']).length > 0
            ? asRecords(page['items'])
            : asRecords(value);
      clearChildren(content);
      content.appendChild(
        el(doc, 'h2', { cls: 'section-title', text: copyOf('msg.section.closed') }),
      );
      if (source.length === 0) {
        content.appendChild(renderStateBlock(doc, { kind: 'empty', copyKey: 'msg.empty.closed' }));
        return;
      }
      const list = el(doc, 'ul', { cls: 'tab-list', attrs: { role: 'list' } });
      for (const entry of source) {
        const entryId = asString(entry['entryId']);
        const tabId = asString(entry['tabId']);
        list.appendChild(
          renderTabRow(
            doc,
            {
              id: entryId,
              title: asString(entry['title'], entryId),
              domain: asString(entry['domain']),
              state: 'kept',
            },
            [
              actionButton(doc, {
                copyKey: 'msg.action.restore',
                action: 'restore-closed',
                onClick: () => {
                  // target 'new': restore lands in a fresh mission (no picker in v1 UX;
                  // the registry/handler both require the field — frozen wire law).
                  runCommand('RestoreRecentlyClosed', { ids: [tabId], target: 'new' }, () => {
                    renderSection(currentSection);
                  });
                },
              }),
            ],
          ),
        );
      }
      content.appendChild(list);
    });
  };

  const renderTrash = (): void => {
    loadQuery('GetTrash', {}, (value) => {
      const page = asRecord(value);
      const rows =
        asRecords(page['entries']).length > 0
          ? asRecords(page['entries'])
          : asRecords(page['items']).length > 0
            ? asRecords(page['items'])
            : asRecords(value);
      clearChildren(content);
      content.appendChild(
        el(doc, 'h2', { cls: 'section-title', text: copyOf('msg.section.trash') }),
      );
      if (rows.length === 0) {
        content.appendChild(renderStateBlock(doc, { kind: 'empty', copyKey: 'msg.empty.trash' }));
        return;
      }
      const list = el(doc, 'ul', { cls: 'tab-list', attrs: { role: 'list' } });
      for (const entry of rows) {
        const kind = asString(entry['kind']);
        const id = asString(entry['id']);
        list.appendChild(
          renderTabRow(
            doc,
            {
              id,
              title: asString(entry['displayName'], id),
              domain: kind,
              state: 'trash',
            },
            [
              actionButton(doc, {
                copyKey: 'msg.action.restore',
                action: 'restore-trash',
                onClick: () => {
                  runCommand('RestoreFromTrash', { kind, id }, () => {
                    renderSection(currentSection);
                  });
                },
              }),
            ],
          ),
        );
      }
      content.appendChild(list);
      const purge = el(doc, 'div', { cls: 'purge-row', attrs: { 'data-block': 'purge' } });
      purge.appendChild(
        actionButton(doc, {
          copyKey: 'msg.action.empty-trash',
          action: 'empty-trash',
          danger: true,
          onClick: () => {
            clearChildren(purge);
            purge.appendChild(
              confirmLane(
                doc,
                'msg.hint.confirm-purge',
                () => {
                  runCommand('EmptyTrash', { confirm: true }, () => {
                    renderSection(currentSection);
                  });
                },
                () => renderTrash(),
              ),
            );
          },
        }),
      );
      content.appendChild(purge);
    });
  };

  const renderActivity = (limit: number): void => {
    loadQuery('GetActivity', { limit }, (value) => {
      const items = asRecords(value);
      clearChildren(content);
      content.appendChild(
        el(doc, 'h2', {
          cls: 'section-title',
          text: copyOf(
            currentSection === 'history' ? 'msg.section.history' : 'msg.section.activity',
          ),
        }),
      );
      if (items.length === 0) {
        content.appendChild(
          renderStateBlock(doc, {
            kind: 'empty',
            copyKey: currentSection === 'history' ? 'msg.empty.history' : 'msg.empty.activity',
          }),
        );
        return;
      }
      const list = el(doc, 'ul', { cls: 'activity-list', attrs: { role: 'list' } });
      for (const item of items) {
        const label = asString(item['label'], asString(item['title'], asString(item['kind'])));
        list.appendChild(
          el(doc, 'li', {
            cls: 'activity-row',
            text: label,
            attrs: {
              'data-kind': asString(item['kind']),
              'data-at': String(asNumber(item['at'], asNumber(item['deletedAt']))),
            },
          }),
        );
      }
      content.appendChild(list);
    });
  };

  const renderSettings = (): void => {
    clearChildren(content);
    content.appendChild(
      el(doc, 'h2', { cls: 'section-title', text: copyOf('msg.section.settings') }),
    );
    const form = el(doc, 'div', { cls: 'settings-form', attrs: { role: 'form' } });
    for (const key of SETTING_KEYS) {
      const row = el(doc, 'div', { cls: 'setting-row', attrs: { 'data-setting': key } });
      row.appendChild(
        el(doc, 'label', {
          cls: 'setting-label',
          text: copyOf(SETTING_COPY[key] ?? 'msg.setting.retention'),
          attrs: { for: `setting-${key}` },
        }),
      );
      const field = el(doc, 'input', {
        cls: 'setting-input',
        attrs: {
          id: `setting-${key}`,
          type: 'number',
          min: '1',
          'data-field': key,
          'aria-label': copyOf(SETTING_COPY[key] ?? 'msg.setting.retention'),
        },
      });
      const current = settings[key];
      if (typeof current === 'number') (field as HTMLInputElement).value = String(current);
      row.appendChild(field);
      row.appendChild(
        actionButton(doc, {
          copyKey: 'msg.action.save',
          action: 'set-setting',
          onClick: () => {
            const raw = inputValue(field);
            const value = Number(raw);
            if (raw.trim().length === 0 || !Number.isFinite(value)) return;
            runCommand('SetSetting', { key, value }, () => {
              live.say(copyOf('msg.dialog.settings-saved'));
              void refreshBootstrap(() => renderSettings());
            });
          },
        }),
      );
      form.appendChild(row);
    }
    content.appendChild(form);
  };

  // ── import / export ──────────────────────────────────────────────────────────
  // E5-T06 · the import panel (roadmap row: counts/dupes/rejects display with
  // commit flow; corrupt-abort path). Bytes stage through the IDB shelf (the
  // wire carries fileMeta only — frozen C20); the preview census rides the
  // amended ImportReady row's modelSummary shape key, whose surface-facing
  // purpose this panel is. One preview flow at a time by UI law.
  const IMPORT_ACCEPT = '.txt,.json,.html,.htm';
  const MODEL_SUMMARY = /^([a-z-]+):m(\d+):t(\d+):r(\d+):d(\d+)$/;

  interface PreviewCensus {
    readonly parser: string;
    readonly missions: number;
    readonly tabs: number;
    readonly rejects: number;
    readonly dupes: number;
    readonly summary: string;
  }

  /** The single pending preview (UI law: one import flow at a time; the SW stash
   *  TTL-sweeps an abandoned one, the panel keeps its place across nav switches). */
  let pendingPreview:
    { readonly previewId: string; readonly census: PreviewCensus | undefined } | undefined;

  const censusOf = (summary: string): PreviewCensus | undefined => {
    const m = MODEL_SUMMARY.exec(summary);
    if (m === null) return undefined;
    return {
      parser: m[1] ?? '',
      missions: asCount(m[2]),
      tabs: asCount(m[3]),
      rejects: asCount(m[4]),
      dupes: asCount(m[5]),
      summary,
    };
  };

  /** Typed import failures → panel copy (W15: name the supported formats). */
  const importWireError = (error: WireError): WireError => {
    const map = (messageKey: string, recoveryKey: string): WireError => ({
      ...error,
      messageKey,
      recoveryKey,
    });
    if (error.code === 'E_QUOTA') return map('msg.error.quota', 'msg.recover.space');
    if (error.code === 'E_CORRUPT_STORE') return map('msg.error.store', 'msg.recover.restart');
    if (error.code === 'E_FILE_GUARD') return map('msg.import.guard', 'msg.recover.file-other');
    if (error.code === 'E_PARSE_REJECTS')
      return map('msg.import.rejects-fatal', 'msg.recover.file-other');
    if (error.code === 'E_FORMAT_UNKNOWN')
      return map('msg.import.unsupported', 'msg.recover.file-path');
    return map('msg.error.file', 'msg.recover.file-path');
  };

  type FileInput = { files?: { 0?: File } | null; click: () => void } & HTMLElement;
  type RadioInput = { checked?: boolean } & HTMLElement;

  const renderPortability = (): void => {
    clearChildren(content);
    content.appendChild(
      el(doc, 'h2', { cls: 'section-title', text: copyOf('msg.section.import-export') }),
    );
    const importBlock = el(doc, 'div', { cls: 'port-block', attrs: { 'data-block': 'import' } });

    const renderImportError = (error: WireError): void => {
      const mapped = importWireError(error);
      clearChildren(importBlock);
      importBlock.appendChild(
        renderStateBlock(doc, {
          kind: 'error',
          copyKey: mapped.messageKey ?? 'msg.error.file',
          error: mapped,
          retry: { onRetry: () => renderPortability() },
        }),
      );
      live.say(copyOf(mapped.messageKey ?? 'msg.error.file'));
    };

    const stageAndPreview = async (file: File): Promise<void> => {
      const meta = { name: file.name, size: file.size };
      if (deps.importBytesStage !== undefined) {
        const staged = await deps.importBytesStage.put({
          name: file.name,
          size: file.size,
          bytes: new Uint8Array(await file.arrayBuffer()),
        });
        if (!staged.ok) {
          renderImportError({ code: staged.error.code, details: staged.error.details });
          return;
        }
      }
      importBlock.appendChild(
        el(doc, 'p', {
          cls: 'state-line',
          text: copyOf('msg.import.staged', { name: file.name }),
          attrs: { 'data-line': 'import-staged' },
        }),
      );
      live.say(copyOf('msg.hint.import-wait'));
      runCommand('ImportPreviewRequest', { fileMeta: meta }, undefined, (error) =>
        renderImportError(error),
      );
    };

    const fileRow = el(doc, 'div', { cls: 'port-row' });
    const fileInput = el(doc, 'input', {
      cls: 'port-file',
      attrs: {
        type: 'file',
        accept: IMPORT_ACCEPT,
        'data-field': 'import-file',
        'aria-label': copyOf('msg.import.choose'),
      },
      on: {
        change: () => {
          const file = (fileInput as unknown as FileInput).files?.[0];
          if (file === undefined) return;
          void stageAndPreview(file);
        },
      },
    }) as unknown as FileInput;
    fileRow.appendChild(fileInput);
    fileRow.appendChild(
      actionButton(doc, {
        copyKey: 'msg.action.import',
        action: 'import-preview',
        primary: true,
        onClick: () => fileInput.click(),
      }),
    );
    importBlock.appendChild(fileRow);

    /** Preview lane (counts/dupes/rejects + dedupe choice + commit). Rendered from
     *  pendingPreview so a nav switch away and back keeps the flow's place. */
    const previewLane = (previewId: string, census: PreviewCensus | undefined): HTMLElement => {
      const lane = el(doc, 'div', {
        cls: 'import-ready-lane',
        attrs: { 'data-lane': 'import-ready' },
      });
      if (census === undefined) {
        lane.appendChild(
          el(doc, 'p', { cls: 'state-line', text: copyOf('msg.hint.import-ready') }),
        );
      } else {
        lane.appendChild(
          el(doc, 'p', {
            cls: 'import-detected',
            text: copyOf('msg.import.detected', {
              parser: census.parser,
              missions: census.missions,
              tabs: census.tabs,
            }),
            attrs: { 'data-line': 'import-detected' },
          }),
        );
        lane.appendChild(
          el(doc, 'p', {
            cls: 'import-extras',
            text: copyOf('msg.import.extras', { dupes: census.dupes, rejects: census.rejects }),
            attrs: { 'data-line': 'import-extras' },
          }),
        );
        if (census.rejects > 0)
          lane.appendChild(
            el(doc, 'p', {
              cls: 'import-rejects-note',
              text: copyOf('msg.import.rejects-note', { rejects: census.rejects }),
              attrs: { 'data-line': 'import-rejects' },
            }),
          );
      }
      const skipInput = el(doc, 'input', {
        attrs: { type: 'radio', name: 'import-dedupe', value: 'skip', 'data-field': 'dedupe-skip' },
      }) as unknown as RadioInput;
      skipInput.checked = true;
      const anywayInput = el(doc, 'input', {
        attrs: {
          type: 'radio',
          name: 'import-dedupe',
          value: 'import-anyway',
          'data-field': 'dedupe-anyway',
        },
      }) as unknown as RadioInput;
      lane.appendChild(
        el(doc, 'div', {
          cls: 'import-dedupe',
          attrs: { role: 'radiogroup', 'data-field': 'dedupe' },
          children: [
            el(doc, 'label', {
              cls: 'import-dedupe-option',
              children: [skipInput, el(doc, 'span', { text: copyOf('msg.import.dedupe-skip') })],
            }),
            el(doc, 'label', {
              cls: 'import-dedupe-option',
              children: [
                anywayInput,
                el(doc, 'span', { text: copyOf('msg.import.dedupe-anyway') }),
              ],
            }),
          ],
        }),
      );
      lane.appendChild(
        actionButton(doc, {
          copyKey: 'msg.action.import-commit',
          action: 'import-commit',
          primary: true,
          onClick: () => {
            const dedupeMode =
              anywayInput.checked === true ? ('import-anyway' as const) : ('skip' as const);
            runCommand(
              'ImportCommit',
              { previewId, dedupeMode },
              (value) => {
                const r = asRecord(value);
                const imported = asNumber(r['imported']);
                const dupes = asNumber(r['dupes']);
                const rejects = asNumber(r['rejects']);
                pendingPreview = undefined;
                // The commit's outcome lands as an honest receipt line (calm
                // success, plain numbers) — announcements ride the live region.
                clearChildren(importBlock);
                importBlock.appendChild(
                  el(doc, 'p', {
                    cls: 'import-receipt',
                    text: copyOf('msg.dialog.imported', { imported, dupes }),
                    attrs: { 'data-line': 'import-receipt', role: 'status' },
                  }),
                );
                live.say(copyOf('msg.dialog.imported', { imported, dupes }));
                if (rejects > 0) live.say(copyOf('msg.import.rejects-note', { rejects }));
              },
              (error) => {
                // A stale/unknown preview is committed-proof the card lied: drop
                // the flow and show the typed failure.
                pendingPreview = undefined;
                renderImportError(error);
              },
            );
          },
        }),
      );
      lane.appendChild(
        actionButton(doc, {
          copyKey: 'msg.import.cancel',
          action: 'import-cancel',
          onClick: () => {
            pendingPreview = undefined;
            renderPortability();
          },
        }),
      );
      return lane;
    };

    if (pendingPreview !== undefined)
      importBlock.appendChild(previewLane(pendingPreview.previewId, pendingPreview.census));

    content.appendChild(importBlock);
    const exportBlock = el(doc, 'div', { cls: 'port-block', attrs: { 'data-block': 'export' } });
    exportBlock.appendChild(
      actionButton(doc, {
        copyKey: 'msg.action.export',
        action: 'export-request',
        primary: true,
        onClick: () => {
          // 'all' scope + every format: the v1 export UX is one button, all-in;
          // the registry requires formats explicitly — frozen wire law.
          runCommand('ExportRequest', { scope: 'all', formats: ['json', 'html', 'md'] });
        },
      }),
    );
    content.appendChild(exportBlock);
  };

  // ── rescue console (E6-T04/T05/T06: §12 probes UI, bundle download, cadence) ──
  interface ProbeWire {
    readonly name: string;
    readonly wired: boolean;
    readonly status: string;
    readonly fields: Readonly<Record<string, unknown>>;
  }
  interface RingRowWire {
    readonly kind: string;
    readonly level: string;
    readonly msg: string;
    readonly at: number;
  }
  /** The parsed health dump for this console session (null = pre-answer). */
  let rescueHealth: {
    probes: readonly ProbeWire[];
    ring: readonly RingRowWire[];
    lastBundle: { bundleId: string; size: number; json: string } | null;
  } | null = null;
  /** Timeline filter (kind chip; 'all' shows everything). */
  let ringFilter = 'all';

  const asProbeRows = (v: unknown): readonly ProbeWire[] => {
    if (!Array.isArray(v)) return [];
    return (v as readonly unknown[])
      .map((row) => asRecord(row))
      .filter((row) => typeof row['name'] === 'string')
      .map((row) => ({
        name: asString(row['name']),
        wired: row['wired'] === true,
        status: asString(row['status']),
        fields: asRecord(row['fields']),
      }));
  };

  const asRingRows = (v: unknown): readonly RingRowWire[] => {
    if (!Array.isArray(v)) return [];
    return (v as readonly unknown[])
      .map((row) => asRecord(row))
      .filter((row) => typeof row['kind'] === 'string' && typeof row['at'] === 'number')
      .map((row) => ({
        kind: asString(row['kind']),
        level: asString(row['level']),
        msg: asString(row['msg']),
        at: asNumber(row['at']),
      }));
  };

  const STATUS_CHIP_COPY: Readonly<Record<string, string>> = {
    ok: 'msg.state.probe-ok',
    warn: 'msg.state.probe-warn',
    fail: 'msg.state.probe-fail',
    unwired: 'msg.state.probe-unwired',
  };

  const RING_FILTERS: readonly { id: string; copyKey: string }[] = [
    { id: 'all', copyKey: 'msg.rescue.filter-all' },
    { id: 'command', copyKey: 'msg.rescue.filter-commands' },
    { id: 'scan', copyKey: 'msg.rescue.filter-scans' },
    { id: 'bundle', copyKey: 'msg.rescue.filter-bundles' },
    { id: 'probe', copyKey: 'msg.rescue.filter-probes' },
    { id: 'diag', copyKey: 'msg.rescue.filter-diagnostics' },
  ];

  const renderRingList = (mount: HTMLElement): void => {
    clearChildren(mount);
    const ring = rescueHealth?.ring ?? [];
    mount.appendChild(
      el(doc, 'p', {
        cls: 'state-recovery',
        text:
          ring.length === 0
            ? copyOf('msg.rescue.timeline-empty')
            : copyOf('msg.rescue.timeline-head', { count: ring.length }),
        attrs: { 'data-line': 'ring-head' },
      }),
    );
    const chips = el(doc, 'div', { cls: 'ring-filters', attrs: { role: 'toolbar' } });
    for (const f of RING_FILTERS) {
      chips.appendChild(
        el(doc, 'button', {
          cls: ringFilter === f.id ? 'btn btn-chip is-active' : 'btn btn-chip',
          text: copyOf(f.copyKey),
          attrs: {
            type: 'button',
            'data-action': `ring-filter-${f.id}`,
            'aria-pressed': ringFilter === f.id ? 'true' : 'false',
          },
          on: {
            click: () => {
              ringFilter = f.id;
              renderRingList(mount);
            },
          },
        }),
      );
    }
    mount.appendChild(chips);
    const list = el(doc, 'ul', {
      cls: 'ring-list',
      attrs: { 'data-panel': 'ring-timeline', role: 'list' },
    });
    for (const row of ring) {
      if (ringFilter !== 'all' && row.kind !== ringFilter) continue;
      list.appendChild(
        el(doc, 'li', {
          cls: `ring-row ring-${row.level}`,
          text: `${relTimeOf(row.at)} · ${row.kind} · ${row.msg}`,
          attrs: { 'data-line': 'ring-row', 'data-kind': row.kind },
        }),
      );
    }
    mount.appendChild(list);
  };

  const renderRescue = (): void => {
    clearChildren(content);
    ringFilter = 'all';
    rescueHealth = null;
    content.appendChild(
      el(doc, 'h2', { cls: 'section-title', text: copyOf('msg.section.rescue') }),
    );
    content.appendChild(el(doc, 'p', { cls: 'state-recovery', text: copyOf('msg.hint.rescue') }));
    const bar = el(doc, 'div', { cls: 'rescue-bar', attrs: { role: 'toolbar' } });
    const reportChip = (reportId: string, tag: string): void => {
      streamsSlot.appendChild(
        el(doc, 'p', {
          cls: 'chip chip-report',
          text: reportId.length > 0 ? reportId : copyOf('msg.dialog.scan-done'),
          attrs: { 'data-report': tag },
        }),
      );
    };
    const renderForceConfirm = (d: Document): HTMLElement => {
      const box = el(d, 'div', {
        cls: 'force-confirm',
        attrs: { 'data-panel': 'scan-force-confirm', role: 'alert' },
      });
      box.appendChild(
        el(d, 'p', {
          cls: 'state-recovery',
          text: copyOf('msg.rescue.force-confirm'),
          attrs: { 'data-line': 'force-confirm-copy' },
        }),
      );
      box.appendChild(
        actionButton(d, {
          copyKey: 'msg.action.scan-full-confirm',
          action: 'scan-full-force',
          onClick: () => {
            box.remove();
            runCommand('RescueScanNow', { mode: 'full', force: true }, (value) => {
              reportChip(asString(asRecord(value)['reportId']), 'scan-full');
              live.say(copyOf('msg.dialog.scan-done'));
            });
          },
        }),
      );
      return box;
    };
    bar.appendChild(
      actionButton(doc, {
        copyKey: 'msg.action.scan',
        action: 'rescue-scan',
        onClick: () => {
          runCommand('RescueScanNow', { mode: 'tail' }, (value) => {
            reportChip(asString(asRecord(value)['reportId']), 'scan');
          });
        },
      }),
    );
    // E6-T06: full scan — C24 cadence law rides the service; the refusal turns
    // into a calm confirm (the console holds the rescue capability; the server
    // re-verifies the envelope on the forced resend).
    bar.appendChild(
      actionButton(doc, {
        copyKey: 'msg.action.scan-full',
        action: 'rescue-scan-full',
        onClick: () => {
          runCommand(
            'RescueScanNow',
            { mode: 'full' },
            (value) => {
              reportChip(asString(asRecord(value)['reportId']), 'scan-full');
              live.say(copyOf('msg.dialog.scan-done'));
            },
            (error) => {
              const reason = asRecord(error.details)['reason'];
              if (error.code === 'E_DOMAIN_LEGALITY' && reason === 'full-scan-cadence') {
                streamsSlot.appendChild(renderForceConfirm(doc));
                return;
              }
              live.say(copyOf('msg.error.output'));
            },
          );
        },
      }),
    );
    bar.appendChild(
      actionButton(doc, {
        copyKey: 'msg.action.repair',
        action: 'repair-rebuild',
        onClick: () => {
          runCommand(
            'RepairRebuild',
            { scope: 'all' },
            () => {
              live.say(copyOf('msg.dialog.repair-done'));
              rejoin();
            },
            // repair implies view rebuild: the store drops its watermarks after
          );
        },
      }),
    );
    bar.appendChild(
      actionButton(doc, {
        copyKey: 'msg.action.diagnostics',
        action: 'export-diagnostics',
        onClick: () => {
          runCommand('ExportDiagnostics', {}, () => {
            live.say(copyOf('msg.dialog.diagnostics-done'));
            renderRescue(); // the fresh bundle lands in the dump → download armed
          });
        },
      }),
    );
    // E6-T05: download rides the ALREADY-LOCAL bundle json (ADR-027: leaves the
    // device only on this explicit gesture; zero network, zero regeneration).
    // Armed post-answer when the dump carries lastBundle (data-armed state).
    bar.appendChild(
      el(doc, 'button', {
        cls: 'btn',
        text: copyOf('msg.action.download-bundle'),
        attrs: {
          type: 'button',
          'data-action': 'download-bundle',
          'data-armed': 'false',
          'aria-disabled': 'true',
        },
        on: {
          click: () => {
            const b = rescueHealth?.lastBundle;
            if (b === null || b === undefined) return;
            // Host-capability guard: test lanes without Blob/URL skip the file
            // gesture calmly (the bundle stays inspectable in the dump).
            if (
              typeof Blob === 'undefined' ||
              typeof URL === 'undefined' ||
              typeof URL.createObjectURL !== 'function'
            ) {
              live.say(copyOf('msg.dialog.diagnostics-done'));
              return;
            }
            const href = URL.createObjectURL(new Blob([b.json], { type: 'application/json' }));
            const anchor = el(doc, 'a', {
              attrs: { href, download: `${b.bundleId}.json` },
            });
            anchor.click();
            URL.revokeObjectURL(href);
            live.say(copyOf('msg.dialog.download-done'));
          },
        },
      }),
    );
    content.appendChild(bar);
    const dumpSlot = el(doc, 'div', { attrs: { 'data-slot': 'health' } });
    content.appendChild(dumpSlot);
    const ringSlot = el(doc, 'div', { attrs: { 'data-slot': 'ring-timeline' } });
    content.appendChild(ringSlot);
    dumpSlot.appendChild(renderLoading(doc));
    const q = client.query('GetHealth', {});
    void q.terminal.then((t) => {
      clearChildren(dumpSlot);
      if (!t.ok) {
        dumpSlot.appendChild(
          renderStateBlock(doc, {
            kind: 'error',
            copyKey: 'msg.error.output',
            error: t.error,
            retry: { onRetry: () => renderRescue() },
          }),
        );
        return;
      }
      const raw = asRecord(t.value);
      const health = {
        probes: asProbeRows(raw['probes']),
        ring: asRingRows(raw['recentRing']),
        lastBundle: (() => {
          const b = raw['lastBundle'];
          if (b === null || b === undefined) return null;
          const rec = asRecord(b);
          return {
            bundleId: asString(rec['bundleId']),
            size: asNumber(rec['size']),
            json: typeof rec['json'] === 'string' ? rec['json'] : '',
          };
        })(),
      };
      rescueHealth = health.lastBundle !== null || health.probes.length > 0 ? health : null;
      // Arm the download gesture with the post-answer bundle presence (click
      // guard reads rescueHealth either way — the chip state is honesty, not law).
      const dl = content.querySelector('[data-action="download-bundle"]');
      if (dl !== null && health.lastBundle !== null) {
        dl.setAttribute('data-armed', 'true');
        dl.setAttribute('aria-disabled', 'false');
      }
      if (health.probes.length > 0) {
        dumpSlot.appendChild(
          el(doc, 'p', {
            cls: 'state-recovery',
            text: copyOf('msg.rescue.probes-head', { count: health.probes.length }),
            attrs: { 'data-line': 'probes-head' },
          }),
        );
        const rows = el(doc, 'ul', {
          cls: 'probe-list',
          attrs: { 'data-panel': 'probe-list', role: 'list' },
        });
        for (const probe of health.probes) {
          const row = el(doc, 'li', {
            cls: `probe-row probe-${probe.status}`,
            attrs: { 'data-line': 'probe-row', 'data-status': probe.status },
          });
          row.appendChild(
            el(doc, 'span', {
              cls: `chip chip-probe chip-${probe.status}`,
              text: copyOf(STATUS_CHIP_COPY[probe.status] ?? 'msg.state.probe-ok'),
              attrs: { 'data-chip': `probe-${probe.status}` },
            }),
          );
          row.appendChild(
            el(doc, 'span', {
              cls: 'probe-name',
              text: probe.name,
              attrs: { 'data-line': 'probe-name' },
            }),
          );
          row.appendChild(
            el(doc, 'span', {
              cls: 'probe-fields',
              text: JSON.stringify(probe.fields),
              attrs: { 'data-line': 'probe-fields' },
            }),
          );
          rows.appendChild(row);
        }
        dumpSlot.appendChild(rows);
        renderRingList(ringSlot);
      }
      // The raw dump stays — folded away as the tell-me-more lane (either shape).
      const fold = el(doc, 'details', { cls: 'probe-fold', attrs: { 'data-panel': 'probe-fold' } });
      fold.appendChild(
        el(doc, 'summary', {
          text: copyOf('msg.action.details'),
          attrs: { 'data-action': 'probe-fold' },
        }),
      );
      fold.appendChild(
        el(doc, 'pre', {
          cls: 'probe-dump',
          text: JSON.stringify(t.value),
          attrs: { 'data-probe-dump': '', tabindex: '0' },
        }),
      );
      dumpSlot.appendChild(fold);
    });
  };

  const renderSection = (key: SectionKey): void => {
    currentSection = key;
    for (const b of Array.from(nav.querySelectorAll('[data-nav]'))) {
      b.setAttribute('aria-current', b.getAttribute('data-nav') === key ? 'page' : 'false');
    }
    if (key === 'library') renderLibrary('all');
    else if (key === 'archive') renderLibrary('archived');
    else if (key === 'closed') renderClosed();
    else if (key === 'trash') renderTrash();
    else if (key === 'activity') renderActivity(ACTIVITY_LIMIT);
    else if (key === 'history') renderActivity(ACTIVITY_LIMIT);
    else if (key === 'settings') renderSettings();
    else if (key === 'import-export') renderPortability();
    else renderRescue();
  };

  const renderNav = (): void => {
    clearChildren(nav);
    for (const section of SECTIONS) {
      nav.appendChild(
        actionButton(doc, {
          copyKey: section.copyKey,
          action: `nav-${section.key}`,
          onClick: () => renderSection(section.key),
        }),
      );
      const btn = nav.lastElementChild;
      if (btn !== null) btn.setAttribute('data-nav', section.key);
    }
  };

  // ── bootstrap / rejoin ───────────────────────────────────────────────────────
  const applyBootstrap = (value: unknown): void => {
    const raw = asRecord(value);
    settings = asRecord(raw['settings']);
    store.seed('missions', asRecords(raw['missions']), undefined);
    const heartbeat = asRecord(raw['heartbeat']);
    pill.update({
      keptCount: asNumber(heartbeat['keptCount']),
      liveRecoverable: asNumber(heartbeat['liveRecoverable']),
      asOf: asNumber(heartbeat['asOf']),
    });
    booted = true;
    clearChildren(firstRunSlot);
    if (asNumber(heartbeat['keptCount']) === 0 && asRecords(raw['missions']).length === 0) {
      firstRunSlot.appendChild(
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
                clearChildren(firstRunSlot);
                runCommand('FirstRunIngest', {}, () => {
                  void refreshBootstrap(() => renderSection(currentSection));
                });
              },
            }),
          ],
        }),
      );
    }
  };

  const refreshBootstrap = (after?: () => void): Promise<void> => {
    const boot = client.query('GetBootstrap', { surface: QUIET_CONTEXT });
    return boot.terminal.then((t) => {
      if (!t.ok) {
        if (!booted)
          showError(t.error, () => {
            void refreshBootstrap(after);
          });
        return;
      }
      applyBootstrap(t.value);
      after?.();
    });
  };

  const rejoin = (): void => {
    store.dispose();
    showBanner('msg.state.resync', 'resync');
    void refreshBootstrap(() => renderSection(currentSection));
  };

  // ── streams ──────────────────────────────────────────────────────────────────
  const detachStreams = client.subscribe({
    ViewDelta: (payload) => {
      const frame = viewFrameOf(payload);
      if (frame === undefined) return;
      const result = store.applyFrame(frame);
      if (result === 'gap') rejoin();
    },
    HeartbeatUpdate: (payload) => {
      const p = asRecord(payload);
      pill.update({
        keptCount: asNumber(p['keptCount']),
        liveRecoverable: asNumber(p['liveRecoverable']),
        asOf: asNumber(p['asOf']),
      });
      live.say(copyOf('msg.heartbeat.safe', { count: asNumber(p['keptCount']) }));
    },
    RecoveryAvailable: (payload) => {
      void payload;
      // The stream is only a hint (fire-and-forget): the card queries the
      // report and §14.4-gates on the returned DTO — never on the hint itself.
      refreshRecovery();
    },
    ResyncRequired: (payload) => {
      const p = asRecord(payload);
      if (asString(p['reason']) === 'schema') {
        // Schema resync: generic error + recovery pair in the banner lane (catalog
        // law), never a silent partial — the user keeps their current section.
        clearChildren(bannerSlot);
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
      } else {
        rejoin();
      }
    },
    ImportReady: (payload) => {
      const p = asRecord(payload);
      const previewId = asString(p['previewId']);
      const modelSummary = asString(p['modelSummary']);
      // Keep the preview's place even off-section (the flow resumes when the
      // user returns; the SW TTL-sweeps an abandoned one honestly).
      pendingPreview = { previewId, census: censusOf(modelSummary) };
      if (currentSection !== 'import-export') return;
      renderPortability();
      live.say(copyOf('msg.hint.import-ready'));
    },
    ExportReady: (payload) => {
      const p = asRecord(payload);
      const fetchURL = asString(p['fetchURL']);
      if (fetchURL.length === 0) return;
      streamsSlot.appendChild(
        el(doc, 'a', {
          cls: 'export-link',
          text: copyOf('msg.dialog.export-ready'),
          attrs: { 'data-link': 'export', href: fetchURL, target: '_blank', rel: 'noreferrer' },
        }),
      );
      live.say(copyOf('msg.dialog.export-ready'));
    },
    ImportProgress: () => renderPending(),
    ExportProgress: () => renderPending(),
    CommandAck: () => renderPending(),
    CommandApplied: () => renderPending(),
    CommandFailed: () => renderPending(),
  });

  const detachStore = store.subscribe((event) => {
    if (event.kind === 'seed' && currentSection === 'library') renderSection('library');
  });

  const detachWake = deps.onWake?.(() => {
    void refreshBootstrap(() => renderSection(currentSection));
    refreshRecovery();
  });

  const detachKeys = bindKeys(doc.body, [
    { combo: 'u', run: () => undoOnce() },
    { combo: 'meta+z', run: () => undoOnce() },
    { combo: 'ctrl+z', run: () => undoOnce() },
  ]);

  const undoOnce = (): void => {
    const op = client.command('Undo', {});
    renderPending();
    void op.terminal.then((t) => {
      renderPending();
      if (!t.ok) {
        live.say(copyOf(t.error.messageKey ?? 'msg.undo.empty'));
        return;
      }
      const result = asRecord(t.value);
      const label =
        typeof result['undid'] === 'string' ? (result['undid'] as string) : 'msg.undo.done';
      live.say(copyOf(label));
      void refreshBootstrap(() => renderSection(currentSection));
    });
  };

  // Boot: shell instantly, data via query bus. When the bootstrap lands the live
  // section re-renders once — a section entered mid-boot (e.g. settings) otherwise
  // keeps pre-boot blanks forever (the wake/rejoin paths already re-render this way).
  renderNav();
  renderSection('library');
  refreshRecovery(); // W7 card truth rides the SAME boot read path as the shell
  void refreshBootstrap(() => {
    if (booted) renderSection(currentSection);
  });

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
