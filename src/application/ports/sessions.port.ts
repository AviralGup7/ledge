// E3-T03 · NativeSessionsPort — the chrome.sessions READ seam (roadmap: "Recovery
// cross-check reads (read-only law)"). The port exists for the E6 recovery tier:
// boot reconcile cross-checks its journal-derived scope against the browser's own
// recently-closed backlog (EES §2.13 step 5), and the E6-T02 panel enumerates the
// same candidates for confirm-before-restore review.
//
// READ-ONLY LAW: this port cannot mutate browser session state — `restore` is
// deliberately absent from the surface. Restoration flows remain Ledge-driven
// (RestoreBootSession/recently-closed use cases write through the intent ledger),
// never native-pass-through.
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';

/**
 * One recently-closed tab as a cross-check candidate. `url` is the match key the
 * reconciler compares against its scope; `title` rides along for the E6-T02
 * review-first panel. Rows with an unreadable/absent url never leave the adapter
 * (unmatchable candidates are noise, not evidence).
 */
export interface RecentlyClosedTab {
  readonly url: string;
  readonly title: string;
}

export interface NativeSessionsPort {
  /**
   * The browser's own recently-closed backlog (tabs and windows' tabs),
   * most-recent first, capped at the platform ceiling. Failure is the typed
   * E_CAPABILITY law — callers degrade with a logged gap, never a guess.
   */
  readonly recentlyClosedTabs: () => Promise<Result<readonly RecentlyClosedTab[], LedgeError>>;
}
