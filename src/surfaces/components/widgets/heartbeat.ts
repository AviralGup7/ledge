// E4 · Heartbeat pill — the "{count} tabs safe" strip (Spec §5.11/W4 honest copy).
// R1 law: updates ride HeartbeatUpdate, which the outbox recomputes POST-Applied —
// the pill can never be ahead of truth (ack never moves it).
import { copyOf } from '../copy/copy.js';
import { el } from '../dom/dom.js';

export interface HeartbeatData {
  readonly keptCount: number;
  readonly liveRecoverable?: number | undefined;
  readonly asOf?: number | undefined;
}

export interface HeartbeatPill {
  readonly el: HTMLElement;
  readonly update: (data: HeartbeatData) => void;
}

const EMPTY_THRESHOLD = 0;

export const createHeartbeatPill = (doc: Document): HeartbeatPill => {
  const root = el(doc, 'div', {
    cls: 'heartbeat-pill',
    attrs: {
      'data-widget': 'heartbeat',
      role: 'status',
      'aria-label': copyOf('msg.aria.heartbeat'),
    },
  });
  const line = el(doc, 'span', { cls: 'heartbeat-line', text: copyOf('msg.heartbeat.quiet') });
  root.appendChild(line);

  return {
    el: root,
    update: (data) => {
      const text =
        data.keptCount > EMPTY_THRESHOLD
          ? copyOf('msg.heartbeat.safe', { count: data.keptCount })
          : copyOf('msg.heartbeat.quiet');
      line.textContent = text;
    },
  };
};
