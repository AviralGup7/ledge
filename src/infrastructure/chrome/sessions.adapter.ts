// E3-T03 · EES §6 NativeSessionsPort over chrome.sessions (A-02 adapter
// containment; roadmap row "NativeSessions adapter — Recovery cross-check reads
// (read-only law)"). One method, one failure class: lastError/rejections flow
// through error-map into E_CAPABILITY_API; candidate normalization (window-shape
// fan-out, url-less row drop) happens at exactly this boundary. Session-order is
// chrome's (most-recent first) and is never rearranged here.
import type { NativeSessionsPort, RecentlyClosedTab } from '@/application/ports/sessions.port.js';
import { err, ledgeError, ok, type LedgeError } from '@/shared-kernel/result/index.js';
import type { ChromeSessionLike, ChromeSessionsApi } from './api-surface.js';
import { mapChromeError } from './error-map.js';

export interface SessionsAdapterDeps {
  /** Structural API seam; production binds chrome.sessions. */
  readonly api?: ChromeSessionsApi | undefined;
}

const SESSIONS_API = 'sessions';

/** Chrome caps the recently-closed backlog at 25; the port ceiling mirrors it
 *  (memory law: cross-check candidates are bounded by contract, not by habit). */
export const RECENTLY_CLOSED_CAP = 25;

const unavailableError = (): LedgeError =>
  ledgeError('E_CAPABILITY_API', { api: SESSIONS_API, raw: 'chrome.sessions unavailable' });

/** Push one (url,title) pair only when the match key is readable. */
const pushTab = (
  out: RecentlyClosedTab[],
  tab: { url?: string | undefined; title?: string | undefined },
): void => {
  const url = tab.url ?? '';
  if (url.length > 0) out.push({ url, title: tab.title ?? '' });
};

/** Tab sessions → one candidate; window sessions fan out per member tab. */
const toCandidates = (sessions: readonly ChromeSessionLike[]): RecentlyClosedTab[] => {
  const out: RecentlyClosedTab[] = [];
  for (const session of sessions) {
    if (session.tab !== undefined) {
      pushTab(out, session.tab);
      continue;
    }
    const memberTabs = session.window?.tabs;
    if (memberTabs !== undefined) {
      for (const tab of memberTabs) pushTab(out, tab);
    }
  }
  return out;
};

export function createChromeSessionsAdapter(deps: SessionsAdapterDeps = {}): NativeSessionsPort {
  /** Lazy ambient resolution (MV3 rehydration re-evaluates the global per wake). */
  const api = (): ChromeSessionsApi | undefined =>
    deps.api ??
    (typeof chrome !== 'undefined' ? (chrome.sessions as ChromeSessionsApi) : undefined);

  return {
    recentlyClosedTabs: async () => {
      const resolved = api();
      if (resolved === undefined) return err(unavailableError());
      try {
        const sessions = await resolved.getRecentlyClosed({ maxResults: RECENTLY_CLOSED_CAP });
        return ok(toCandidates(sessions));
      } catch (cause) {
        return err(mapChromeError(cause, SESSIONS_API));
      }
    },
  };
}
