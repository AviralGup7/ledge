// E4 · Shared state blocks — loading / empty / error rendering identical across
// surfaces (one block law: no per-surface forks of state presentation). All prose
// arrives as catalog keys (§2 copy law); error copy comes from the §3.2 envelope's
// messageKey/recoveryKey with a calm generic fallback — never invented locally.
import { copyOf } from '../copy/copy.js';
import { el } from '../dom/dom.js';
import type { WireError } from '../session/client.js';

export type StateKind = 'loading' | 'empty' | 'error';

export interface StateBlockSpec {
  readonly kind: StateKind;
  /** msg.* key of the primary line (empty/loading copy is chosen by the surface). */
  readonly copyKey: string;
  readonly vars?: Readonly<Record<string, string | number>> | undefined;
  /** Error blocks: the wire envelope (messageKey/recoveryKey override copyKey). */
  readonly error?: WireError | undefined;
  /** Optional retry affordance — the surface owns what retry does. */
  readonly retry?: { readonly onRetry: () => void } | undefined;
}

const FALLBACK_ERROR_KEY = 'msg.error.output';
const FALLBACK_RECOVERY_KEY = 'msg.recover.report';

export const renderStateBlock = (doc: Document, spec: StateBlockSpec): HTMLElement => {
  const titleKey =
    spec.kind === 'error' ? (spec.error?.messageKey ?? FALLBACK_ERROR_KEY) : spec.copyKey;
  const block = el(doc, 'div', {
    cls: `state-block state-${spec.kind}`,
    attrs: { 'data-state': spec.kind, role: spec.kind === 'error' ? 'alert' : 'note' },
  });
  block.appendChild(el(doc, 'p', { cls: 'state-line', text: copyOf(titleKey, spec.vars) }));
  if (spec.kind === 'error') {
    const recoveryKey = spec.error?.recoveryKey ?? FALLBACK_RECOVERY_KEY;
    block.appendChild(el(doc, 'p', { cls: 'state-recovery', text: copyOf(recoveryKey) }));
  }
  if (spec.kind === 'loading') {
    block.appendChild(el(doc, 'span', { cls: 'shimmer', attrs: { 'aria-hidden': 'true' } }));
  }
  if (spec.retry !== undefined) {
    block.appendChild(
      el(doc, 'button', {
        cls: 'btn btn-quiet',
        text: copyOf('msg.action.refresh'),
        attrs: { type: 'button', 'data-action': 'retry' },
        on: { click: () => spec.retry?.onRetry() },
      }),
    );
  }
  return block;
};

/** The loading placeholder every section renders first (FCR posture: instant shell). */
export const renderLoading = (doc: Document): HTMLElement =>
  renderStateBlock(doc, { kind: 'loading', copyKey: 'msg.state.loading' });
