// E4 · Mission card — the library/guardian unit of mission presentation.
// Display-only mapping of the MissionView DTO (name/state/counts are DATA rendered
// verbatim — the only keys are state chips and count prose from the catalog).
import { copyOf } from '../copy/copy.js';
import { el } from '../dom/dom.js';

/** Display mirror of the MissionView DTO the wire carries (item 8 of the DTO law:
 *  surfaces never see store rows — these fields ARE the DTO's). */
export interface MissionCardModel {
  readonly missionId: string;
  readonly name: string;
  readonly namedBy: string;
  readonly state: string;
  readonly concluded: boolean;
  readonly createdAt?: number | undefined;
  readonly lastActiveAt?: number | undefined;
  readonly tabCount: number;
  readonly favorite?: boolean | undefined;
  readonly pinned?: boolean | undefined;
}

export interface MissionCardActions {
  readonly children: readonly HTMLElement[];
  readonly onOpen?: (() => void) | undefined;
}

const STATE_CHIP_KEYS: Readonly<Record<string, string>> = {
  live: 'msg.state.live',
  parked: 'msg.state.parked',
  archived: 'msg.state.archived',
  trash: 'msg.state.trash',
};

export const renderMissionCard = (
  doc: Document,
  mission: MissionCardModel,
  actions?: MissionCardActions,
): HTMLElement => {
  const card = el(doc, 'article', {
    cls: 'mission-card',
    attrs: {
      'data-mission-id': mission.missionId,
      'data-state': mission.state,
      tabindex: '0',
      role: 'group',
      'aria-label': mission.name,
    },
  });
  const head = el(doc, 'div', { cls: 'mission-card-head' });
  head.appendChild(el(doc, 'h3', { cls: 'mission-name', text: mission.name }));
  const chips = el(doc, 'div', { cls: 'mission-chips' });
  chips.appendChild(
    el(doc, 'span', {
      cls: `chip chip-state chip-${mission.state}`,
      text: copyOf(STATE_CHIP_KEYS[mission.state] ?? 'msg.state.kept'),
    }),
  );
  if (mission.concluded)
    chips.appendChild(
      el(doc, 'span', { cls: 'chip chip-concluded', text: copyOf('msg.state.concluded') }),
    );
  if (mission.pinned === true)
    chips.appendChild(el(doc, 'span', { cls: 'chip chip-pinned', text: copyOf('msg.action.pin') }));
  if (mission.favorite === true)
    chips.appendChild(
      el(doc, 'span', { cls: 'chip chip-favorite', text: copyOf('msg.action.favorite') }),
    );
  head.appendChild(chips);
  card.appendChild(head);
  card.appendChild(
    el(doc, 'p', {
      cls: 'mission-meta',
      text: copyOf('msg.count.tabs', { count: mission.tabCount }),
    }),
  );
  if (actions !== undefined && actions.children.length > 0) {
    const row = el(doc, 'div', {
      cls: 'card-actions',
      attrs: { role: 'toolbar', 'aria-label': copyOf('msg.aria.actions') },
    });
    for (const child of actions.children) row.appendChild(child);
    card.appendChild(row);
  }
  return card;
};

/** The button idiom shared by every card action (44px targets via .btn — EES §7.4). */
export const actionButton = (
  doc: Document,
  spec: {
    readonly copyKey: string;
    readonly action: string;
    readonly onClick: () => void;
    readonly primary?: boolean | undefined;
    readonly danger?: boolean | undefined;
  },
): HTMLElement =>
  el(doc, 'button', {
    cls: spec.primary === true ? 'btn btn-primary' : 'btn',
    text: copyOf(spec.copyKey),
    attrs: {
      type: 'button',
      'data-action': spec.action,
      ...(spec.danger === true ? { 'data-danger': 'true' } : {}),
    },
    on: { click: () => spec.onClick() },
  });
