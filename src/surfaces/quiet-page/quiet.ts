// E4 · Quiet page surface (Spec §6.4 / EES §2.16: missions, Archive, Recently
// Closed, Trash, settings, import/export, rescue console — a place of business).
// Authority-free by law: sections render query DTOs, actions send commands, the
// store mirrors §3.5 deltas mechanically. No business logic, no storage, no
// chrome APIs — presentation + wire only.
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
  ): OperationHandle => {
    const op = client.command(name, payload);
    renderPending();
    void op.terminal.then((t) => {
      renderPending();
      if (!t.ok) {
        showError(t.error, () => {
          void runCommand(name, payload, after);
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
            runCommand('ConcludeMission', { missionId: missionModel.missionId }, () => {
              renderSection('library');
            });
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
  const renderPortability = (): void => {
    clearChildren(content);
    content.appendChild(
      el(doc, 'h2', { cls: 'section-title', text: copyOf('msg.section.import-export') }),
    );
    const importBlock = el(doc, 'div', { cls: 'port-block', attrs: { 'data-block': 'import' } });
    const fileRow = el(doc, 'div', { cls: 'port-row' });
    const nameField = el(doc, 'input', {
      cls: 'port-file-name',
      attrs: {
        type: 'text',
        'data-field': 'file-name',
        placeholder: copyOf('msg.action.import'),
        'aria-label': copyOf('msg.action.import'),
      },
    });
    const sizeField = el(doc, 'input', {
      cls: 'port-file-size',
      attrs: {
        type: 'number',
        min: '0',
        'data-field': 'file-size',
        'aria-label': copyOf('msg.action.import'),
      },
    });
    fileRow.appendChild(nameField);
    fileRow.appendChild(sizeField);
    fileRow.appendChild(
      actionButton(doc, {
        copyKey: 'msg.action.import',
        action: 'import-preview',
        onClick: () => {
          const name = inputValue(nameField).trim();
          const size = Number(inputValue(sizeField));
          if (name.length === 0 || !Number.isFinite(size)) return;
          importBlock.appendChild(
            el(doc, 'p', { cls: 'state-line', text: copyOf('msg.hint.import-wait') }),
          );
          runCommand('ImportPreviewRequest', { fileMeta: { name, size } });
        },
      }),
    );
    importBlock.appendChild(fileRow);
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

  // ── rescue console ────────────────────────────────────────────────────────────
  const renderRescue = (): void => {
    clearChildren(content);
    content.appendChild(
      el(doc, 'h2', { cls: 'section-title', text: copyOf('msg.section.rescue') }),
    );
    content.appendChild(el(doc, 'p', { cls: 'state-recovery', text: copyOf('msg.hint.rescue') }));
    const bar = el(doc, 'div', { cls: 'rescue-bar', attrs: { role: 'toolbar' } });
    bar.appendChild(
      actionButton(doc, {
        copyKey: 'msg.action.scan',
        action: 'rescue-scan',
        onClick: () => {
          runCommand('RescueScanNow', { mode: 'tail' }, (value) => {
            const report = asRecord(value);
            const reportId = asString(report['reportId']);
            streamsSlot.appendChild(
              el(doc, 'p', {
                cls: 'chip chip-report',
                text: reportId.length > 0 ? reportId : copyOf('msg.dialog.scan-done'),
                attrs: { 'data-report': 'scan' },
              }),
            );
          });
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
          });
        },
      }),
    );
    content.appendChild(bar);
    const dumpSlot = el(doc, 'div', { attrs: { 'data-slot': 'health' } });
    content.appendChild(dumpSlot);
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
      dumpSlot.appendChild(
        el(doc, 'pre', {
          cls: 'probe-dump',
          text: JSON.stringify(t.value),
          attrs: { 'data-probe-dump': '', tabindex: '0' },
        }),
      );
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
      const p = asRecord(payload);
      const severity = asString(p['severity']);
      showBanner(
        severity === 'clean-abnormal' ? 'msg.recovery.updated' : 'msg.recovery.crashed',
        'recovery',
      );
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
      if (currentSection !== 'import-export') return;
      streamsSlot.appendChild(
        el(doc, 'div', {
          cls: 'import-ready-lane',
          attrs: { 'data-lane': 'import-ready' },
          children: [
            el(doc, 'p', { cls: 'state-line', text: copyOf('msg.hint.import-ready') }),
            actionButton(doc, {
              copyKey: 'msg.action.import-commit',
              action: 'import-commit',
              primary: true,
              onClick: () => {
                runCommand('ImportCommit', { previewId, dedupeMode: 'skip' }, (value) => {
                  const r = asRecord(value);
                  live.say(
                    copyOf('msg.dialog.imported', {
                      imported: asNumber(r['imported']),
                      dupes: asNumber(r['dupes']),
                    }),
                  );
                });
              },
            }),
          ],
        }),
      );
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
