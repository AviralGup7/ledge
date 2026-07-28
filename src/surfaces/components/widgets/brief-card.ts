// E8-T05 · Brief card (Spec §6.9 · W5) — the guardian's resumption brief:
// "You left {state}. You stopped at {place}. Pending: {note}." rendered
// VERBATIM from the artifact (authority-free surface — the text is data the
// domain already gated; the card adds no words of its own beyond catalog
// chrome). Laws this widget keeps:
//  * W5 SHAPE: one card per mission brief, shown once per mount, dismissible
//    per-mission-forever via the dismiss action (the authority that records
//    forever is the app seam — the card only asks).
//  * §6.11 AFFORDANCE: presentation is the domain tier word ('normal' shows
//    plainly; 'suggested' adds the suggestion chip); LOW never reaches the
//    surface — the brief gate's absence law already answered.
//  * CALM COPY: every string the widget emits is a catalog key (copy-lint);
//    the brief text itself is the only verbatim (and it is artifact truth).
import { copyOf } from '../copy/copy.js';
import { el } from '../dom/dom.js';

/** The domain-gated brief, wire-shaped (the v1.1 GetMissionBrief response made
 *  present-tense; surfaces never threshold confidences themselves — EES-R18). */
export interface PendingBrief {
  readonly missionId: string;
  readonly missionName: string;
  readonly text: string;
  readonly presentation: 'normal' | 'suggested';
}

export interface BriefCardActions {
  /** "Resume" — the card's forward affordance (same command as the mission
   *  card's Resume; the brief never invents a second resume path). */
  readonly onResume: (missionId: string) => void;
  /** "Don't show again" — per-mission-forever dismissal (Spec §6.9/W5). */
  readonly onDismiss: (missionId: string) => void;
}

export const renderBriefCard = (
  doc: Document,
  brief: PendingBrief,
  actions: BriefCardActions,
): HTMLElement => {
  const card = el(doc, 'article', {
    cls: 'brief-card',
    attrs: {
      'data-widget': 'brief-card',
      'data-mission-id': brief.missionId,
      'data-presentation': brief.presentation,
      role: 'group',
      'aria-label': copyOf('msg.aria.brief'),
    },
  });
  const head = el(doc, 'div', { cls: 'brief-card-head' });
  head.appendChild(
    el(doc, 'span', { cls: 'brief-card-heading', text: copyOf('msg.brief.heading') }),
  );
  if (brief.presentation === 'suggested') {
    head.appendChild(
      el(doc, 'span', { cls: 'chip chip-suggested', text: copyOf('msg.brief.suggested') }),
    );
  }
  card.appendChild(head);
  card.appendChild(el(doc, 'p', { cls: 'brief-card-mission', text: brief.missionName }));
  // Artifact truth, verbatim — the provider's honesty law vouches every token.
  card.appendChild(el(doc, 'p', { cls: 'brief-card-text', text: brief.text }));

  const row = el(doc, 'div', {
    cls: 'brief-card-actions',
    attrs: { role: 'group', 'aria-label': copyOf('msg.aria.actions') },
  });
  row.appendChild(
    el(doc, 'button', {
      cls: 'btn btn-primary',
      text: copyOf('msg.action.resume'),
      attrs: { type: 'button', 'data-action': 'resume-brief' },
      on: {
        click: () => {
          actions.onResume(brief.missionId);
        },
      },
    }),
  );
  row.appendChild(
    el(doc, 'button', {
      cls: 'btn btn-quiet',
      text: copyOf('msg.action.dismiss-brief'),
      attrs: { type: 'button', 'data-action': 'dismiss-brief' },
      on: {
        click: () => {
          actions.onDismiss(brief.missionId);
        },
      },
    }),
  );
  card.appendChild(row);
  return card;
};
