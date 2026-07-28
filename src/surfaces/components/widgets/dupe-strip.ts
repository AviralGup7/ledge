// E8-T07 · Dupe strip (roadmap "guardian dupe strip"; Spec: the lane "marks,
// does not close"). The strip SHOWS open-duplicate groups and offers exactly
// one gesture per group: park the older copies (the only closing vocabulary
// Ledge owns). Laws this widget keeps:
//  * OPT-IN ONLY: nothing here fires on render, on a timer, or "for" the
//    user — the park button is the action and the test pins it (no silent
//    closing, ever).
//  * HONEST COUNTS: "Park {count} older copies" counts exactly what the
//    action will park (parkCandidates), keeping the most-recent copy —
//    the copy the user was just reading is never the candidate.
//  * CALM ABSENCE: an empty group list renders nothing (the section stays
//    clean), and dismiss ("Ignore") is per-group memory, not a tantrum.
import { copyOf } from '../copy/copy.js';
import { el } from '../dom/dom.js';

/** Presentation model of one dupe group (wire-shaped at the v1.1 flip;
 *  today the composition seam answers it — either way it is DATA). */
export interface DupeGroupModel {
  readonly canonHash: string;
  readonly title: string;
  readonly domain: string;
  /** Exactly the candidates the one-tap action parks (keep is exempt). */
  readonly duplicateCount: number;
  readonly keepBrowserTabId: number;
}

export interface DupeStripActions {
  /** The ONE closing gesture: park the older copies of this group. */
  readonly onPark: (canonHash: string, keepBrowserTabId: number) => void;
  /** Per-group dismiss memory ("don't offer this again"). */
  readonly onIgnore: (canonHash: string) => void;
}

const renderGroup = (
  doc: Document,
  group: DupeGroupModel,
  actions: DupeStripActions,
): HTMLElement => {
  const row = el(doc, 'article', {
    cls: 'dupe-row',
    attrs: {
      'data-canon-hash': group.canonHash,
      role: 'group',
      'aria-label': group.title,
    },
  });
  const text = el(doc, 'div', { cls: 'dupe-row-text' });
  text.appendChild(el(doc, 'span', { cls: 'dupe-row-title', text: group.title }));
  text.appendChild(
    el(doc, 'span', {
      cls: 'chip chip-dupe-count',
      text: copyOf('msg.dupe.copies', { count: group.duplicateCount + 1 }),
    }),
  );
  row.appendChild(text);
  const rowActions = el(doc, 'div', {
    cls: 'dupe-row-actions',
    attrs: { role: 'group', 'aria-label': copyOf('msg.aria.actions') },
  });
  rowActions.appendChild(
    el(doc, 'button', {
      cls: 'btn btn-primary',
      text: copyOf('msg.action.park-dupes', { count: group.duplicateCount }),
      attrs: { type: 'button', 'data-action': 'park-dupes' },
      on: {
        click: () => {
          actions.onPark(group.canonHash, group.keepBrowserTabId);
        },
      },
    }),
  );
  rowActions.appendChild(
    el(doc, 'button', {
      cls: 'btn btn-quiet',
      text: copyOf('msg.action.ignore'),
      attrs: { type: 'button', 'data-action': 'ignore-dupe' },
      on: {
        click: () => {
          actions.onIgnore(group.canonHash);
        },
      },
    }),
  );
  row.appendChild(rowActions);
  return row;
};

/** The strip: one row per group, capped upstream by the domain law. */
export const renderDupeStrip = (
  doc: Document,
  groups: readonly DupeGroupModel[],
  actions: DupeStripActions,
): HTMLElement => {
  const strip = el(doc, 'div', { cls: 'dupe-strip', attrs: { 'data-widget': 'dupe-strip' } });
  strip.appendChild(el(doc, 'h2', { cls: 'section-title', text: copyOf('msg.dupe.heading') }));
  for (const group of groups) strip.appendChild(renderGroup(doc, group, actions));
  return strip;
};
