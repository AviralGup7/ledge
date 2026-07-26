// E4 · Aria-live announcements (EES §7.4: heartbeat + action outcomes reach screen
// readers through a polite live region — never assertive, calm is the copy law too).
const REGION_ATTR = 'data-live-region';

export interface LiveAnnouncer {
  readonly region: HTMLElement;
  readonly say: (text: string) => void;
  readonly dispose: () => void;
}

/**
 * Attach (once) a visually-hidden polite live region under `root`. Repeated `say`
 * calls replace the text; screen readers announce the change. Assertions in tests
 * read the region's text (behavior, not pixels).
 */
// Duck-typed identity (no `instanceof HTMLElement`): the unit lane runs in Node where
// DOM constructors do not exist — the marker attribute is the sole authority for "ours".
const isLiveRegion = (node: Element | null): node is HTMLElement =>
  node !== null && node.hasAttribute(REGION_ATTR);

export const ensureLiveRegion = (doc: Document, root: Element): LiveAnnouncer => {
  let region: HTMLElement | null = null;
  const existing = root.querySelector(`[${REGION_ATTR}]`);
  if (isLiveRegion(existing)) region = existing;
  if (region === null) {
    region = doc.createElement('div');
    region.setAttribute(REGION_ATTR, '');
    region.setAttribute('class', 'sr-only');
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('role', 'status');
    root.appendChild(region);
  }
  const fixed = region;
  return {
    region: fixed,
    say: (text) => {
      fixed.textContent = text;
    },
    dispose: () => {
      fixed.remove();
    },
  };
};
