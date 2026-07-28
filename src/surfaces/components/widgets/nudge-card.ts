// E8-T08 · Nudge card (Spec §5.8: "one optional tab-sprawl nudge/day"; §6.10:
// "timing model errs to never"). The card SHOWS the day's single offer and
// offers exactly two gestures: park the stale cohort (the only closing
// vocabulary Ledge owns) or "Not now" (§6.10 misfire memory). Laws:
//  * OPT-IN ONLY: nothing fires on render, on a timer, or "for" the user —
//    the buttons are the actions and the tests pin them (no silent closing).
//  * HONEST COUNT: "{count} tabs from last week" is exactly the cohort the
//    gesture will re-derive and park — the number the user reads is the
//    number the device acts on (act-on-now keeps it honest at tap time).
//  * CALM EXIT: "Not now" is dismissal memory (14-day ⇒ third-is-forever),
//    never a tantrum, never a badge.
import { copyOf } from '../copy/copy.js';
import { el } from '../dom/dom.js';

/** Presentation model of the day's sprawl offer (offerId correlates the tap
 *  back to the journal-ed offer fact; data only — no behavior). */
export interface SprawlNudgeModel {
  readonly offerId: string;
  readonly staleCount: number;
}

export interface NudgeCardActions {
  /** The ONE gesture: park exactly the stale cohort behind this offer. */
  readonly onPark: (offerId: string) => void;
  /** §6.10 misfire: dismissal memory (+1 for the type). */
  readonly onDismiss: (offerId: string) => void;
}

/** The card: one line of honest copy, one primary gesture, one quiet exit. */
export const renderNudgeCard = (
  doc: Document,
  model: SprawlNudgeModel,
  actions: NudgeCardActions,
): HTMLElement => {
  const card = el(doc, 'article', {
    cls: 'nudge-card',
    attrs: {
      'data-widget': 'nudge-card',
      'data-offer-id': model.offerId,
      role: 'group',
      'aria-label': copyOf('msg.aria.nudge'),
    },
  });
  card.appendChild(
    el(doc, 'p', {
      cls: 'nudge-line',
      text: copyOf('msg.nudge.sprawl', { count: model.staleCount }),
    }),
  );
  const row = el(doc, 'div', {
    cls: 'nudge-actions',
    attrs: { role: 'group', 'aria-label': copyOf('msg.aria.actions') },
  });
  row.appendChild(
    el(doc, 'button', {
      cls: 'btn btn-primary',
      text: copyOf('msg.action.park-stale', { count: model.staleCount }),
      attrs: { type: 'button', 'data-action': 'park-stale' },
      on: {
        click: () => {
          actions.onPark(model.offerId);
        },
      },
    }),
  );
  row.appendChild(
    el(doc, 'button', {
      cls: 'btn btn-quiet',
      text: copyOf('msg.action.not-now'),
      attrs: { type: 'button', 'data-action': 'dismiss-nudge' },
      on: {
        click: () => {
          actions.onDismiss(model.offerId);
        },
      },
    }),
  );
  card.appendChild(row);
  return card;
};
