// E5-T05 · parser-sessionbuddy (ADR-044). Grammar (corpus-pinned, ops/fixtures/
// import/sessionbuddy/**): top-level JSON array of session objects
// { name?, windows: [{ tabs: [{ url, title?, …] }] } ]; additive fields are
// tolerated (never rejected, never carried — plans have no home for them).
// File-level malformation (bad JSON, non-array top) is E_FORMAT_UNKNOWN's
// class — the adapter raises it; this parser reports validity structurally.
import {
  BOM,
  DEADLINE_PROBE_RECORDS,
  deadlineBreached,
  excerptOf,
  verdictUrl,
  type ParseClock,
  type ParseOutcome,
  type ParsedTabDraft,
  type RejectRow,
} from './model.js';

/** Structural parse: the array of unknown rows, or why it isn't one. */
export type SessionBuddyJson =
  { readonly ok: true; readonly rows: unknown[] } | { readonly ok: false };

export const readSessionBuddyJson = (text: string): SessionBuddyJson => {
  const body = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  try {
    const parsed: unknown = JSON.parse(body);
    return Array.isArray(parsed) ? { ok: true, rows: parsed } : { ok: false };
  } catch {
    return { ok: false };
  }
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validate the parsed rows into an outcome (row/window/session-level quarantine). */
export const parseSessionBuddy = (text: string, clock: ParseClock): ParseOutcome => {
  const json = readSessionBuddyJson(text);
  if (!json.ok) {
    // Structural invalidity is encoded as ONE record-level refusal; the adapter
    // maps a zero-record outcome with this marker to E_FORMAT_UNKNOWN.
    return {
      parserId: 'sessionbuddy',
      missions: [],
      rejects: [{ ref: 'file', reason: 'json-malformed', excerpt: '' }],
      records: 0,
      deadlineBreached: false,
    };
  }
  const missions: { name: string; tabs: ParsedTabDraft[] }[] = [];
  const rejects: RejectRow[] = [];
  let records = 0;
  let halted = false;

  json.rows.forEach((session, si) => {
    const sessionRef = `sessions[${String(si)}]`;
    if (!isRecord(session) || !Array.isArray(session['windows'])) {
      rejects.push({ ref: sessionRef, reason: 'session-malformed', excerpt: '' });
      return;
    }
    const name = typeof session['name'] === 'string' ? (session['name'] as string) : '';
    const tabs: ParsedTabDraft[] = [];
    (session['windows'] as unknown[]).forEach((win, wi) => {
      const windowRef = `${sessionRef}.windows[${String(wi)}]`;
      if (!isRecord(win) || !Array.isArray(win['tabs'])) {
        rejects.push({ ref: windowRef, reason: 'window-malformed', excerpt: '' });
        return;
      }
      (win['tabs'] as unknown[]).forEach((tab, ti) => {
        if (halted) return;
        const tabRef = `${windowRef}.tabs[${String(ti)}]`;
        records += 1;
        if (records % DEADLINE_PROBE_RECORDS === 0 && deadlineBreached(clock)) {
          halted = true;
          return;
        }
        if (!isRecord(tab) || typeof tab['url'] !== 'string') {
          rejects.push({ ref: tabRef, reason: 'url-malformed', excerpt: '' });
          return;
        }
        const url = tab['url'] as string;
        const verdict = verdictUrl(url);
        if (verdict !== 'ok') {
          rejects.push({ ref: tabRef, reason: verdict, excerpt: excerptOf(url) });
          return;
        }
        tabs.push({ url, title: typeof tab['title'] === 'string' ? (tab['title'] as string) : '' });
      });
    });
    if (tabs.length > 0) missions.push({ name, tabs });
  });

  return { parserId: 'sessionbuddy', missions, rejects, records, deadlineBreached: halted };
};
