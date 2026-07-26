// E5-T05 · Importers adapter — the ImporterPort implementation (ADR-044
// two-phase: parse→preview, then commit as one undoable batch; EES §2.14
// guards; frozen C20/C21 contracts). v1 composes in the SW (precedent:
// exporters §1.1) — the workroom streaming contract (E3-T07 skeleton) is the
// transport door the C20 comment reserves, recorded in
// docs/adr-notes/e5-importers.md. Parsers are pure; this adapter owns the
// transport union, guards, the preview stash (TTL 1h per EES §5 ImportPreviewed
// row; cap-bounded, sweep AFTER insert), canon stamping, dedupe arithmetic,
// and the idempotency derive batchId := previewId (C21 "idempotent by batchId"
// — a re-commit replays the same journal idempotency key and collapses).
import type {
  ImportCommitPlan,
  ImportedMissionPlan,
  ImportedTabPlan,
  ImportPreviewModel,
  ImporterPort,
} from '@/application/ports/import-export.port.js';
import { CANON_RULES_V1, canonicalize } from '@/shared-kernel/canon/index.js';
import type { IdGenerator, Now } from '@/shared-kernel/identity/index.js';
import { err, ledgeError, ok } from '@/shared-kernel/result/index.js';
import { sniffParser, SNIFF_HEAD_CHARS } from './detect.js';
import {
  IMPORT_MAX_BYTES,
  PARSE_DEADLINE_MS,
  PARSER_IDS,
  REJECT_FATAL_MAJOR_DIVISOR,
  REJECT_FATAL_MIN_RECORDS,
  type ParseOutcome,
  type ParserId,
  type RejectRow,
} from './model.js';
import { parseNetscape } from './parser-netscape.js';
import { parseOneTab } from './parser-onetab.js';
import { parseSessionBuddy } from './parser-sessionbuddy.js';

/** EES §5 ImportPreviewed row: TTL 1h. Stash cap: the SW never piles previews. */
export const PREVIEW_TTL_MS = 3_600_000;
export const PREVIEW_STASH_CAP = 2;

/** v1 bytes transport (the workroom streaming contract's eventual frame shape;
 *  anything outside the union is E_FORMAT_UNKNOWN 'import-bytes'). */
export type ImportBytesTransport =
  | string
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array };

interface StampedTab extends ImportedTabPlan {
  readonly dupe: boolean;
}

interface PreviewEntry {
  readonly parserId: ParserId;
  readonly missions: readonly { readonly name: string; readonly tabs: readonly StampedTab[] }[];
  readonly rejects: readonly RejectRow[];
  readonly dupesHint: number;
  readonly modelSummary: string;
  readonly stashedAt: number;
}

const UTF8 = new TextEncoder();
const UTF8_DECODE = new TextDecoder('utf-8');

const decodeTransport = (bytesRef: unknown): { ok: true; text: string } | { ok: false } => {
  if (typeof bytesRef === 'string') return { ok: true, text: bytesRef };
  if (typeof bytesRef === 'object' && bytesRef !== null) {
    const ref = bytesRef as Record<string, unknown>;
    if (ref['kind'] === 'text' && typeof ref['text'] === 'string')
      return { ok: true, text: ref['text'] };
    if (ref['kind'] === 'bytes' && ref['bytes'] instanceof Uint8Array)
      return { ok: true, text: UTF8_DECODE.decode(ref['bytes']) };
  }
  return { ok: false };
};

const outcomeFor = (parserId: ParserId, text: string, now: Now): ParseOutcome => {
  const clock = { now, deadlineMs: now() + PARSE_DEADLINE_MS };
  switch (parserId) {
    case 'onetab':
      return parseOneTab(text, clock);
    case 'sessionbuddy':
      return parseSessionBuddy(text, clock);
    case 'netscape':
      return parseNetscape(text, clock);
  }
};

/** Canon-stamp every surviving tab once; intra-file dupes ride the canon form
 *  (ADR-016 matching within the file; dedupe-against-archive is the app-layer
 *  door — ports are archive-blind by depcruise law, see the ADR note). */
const stamp = (
  outcome: ParseOutcome,
): {
  readonly missions: PreviewEntry['missions'];
  readonly dupesHint: number;
  readonly tabs: number;
} => {
  const seen = new Set<string>();
  let dupesHint = 0;
  let tabs = 0;
  const missions = outcome.missions.map((mission) => ({
    name: mission.name,
    tabs: mission.tabs.map((tab) => {
      const canon = canonicalize(tab.url);
      const urlCanon = canon.canonForm;
      const dupe = seen.has(urlCanon);
      if (dupe) dupesHint += 1;
      else seen.add(urlCanon);
      tabs += 1;
      return { url: tab.url, title: tab.title, domain: canon.domain, urlCanon, dupe };
    }),
  }));
  return { missions, dupesHint, tabs };
};

export interface ImportersAdapter extends ImporterPort {
  /** Rejects quarantine (the roadmap's "rejects file" material; the UI surface
   *  rides E5-T06 — same door pattern as the exporters' fetchArtifact seam). */
  readonly fetchRejects: (previewId: string) => readonly RejectRow[] | undefined;
}

export const createImportersAdapter = (deps: {
  readonly ids: IdGenerator;
  readonly now: Now;
}): ImportersAdapter => {
  const stash = new Map<string, PreviewEntry>();

  /** Sweep AFTER insert (the WP2 lesson): expire TTL-dead entries, then evict
   *  oldest beyond the cap — memory law holds at every instant. */
  const sweep = (): void => {
    const now = deps.now();
    for (const [id, entry] of stash) if (now - entry.stashedAt > PREVIEW_TTL_MS) stash.delete(id);
    while (stash.size > PREVIEW_STASH_CAP) {
      const oldest = [...stash.entries()].sort((a, b) => a[1].stashedAt - b[1].stashedAt)[0];
      if (oldest === undefined) return;
      stash.delete(oldest[0]);
    }
  };

  return {
    preview: async (input) => {
      if (input.fileMeta.size > IMPORT_MAX_BYTES) {
        return err(
          ledgeError('E_FILE_GUARD', {
            what: 'file-bytes',
            size: String(input.fileMeta.size),
            cap: String(IMPORT_MAX_BYTES),
          }),
        );
      }
      const decoded = decodeTransport(input.bytesRef);
      if (!decoded.ok) return err(ledgeError('E_FORMAT_UNKNOWN', { what: 'import-bytes' }));
      const textBytes = UTF8.encode(decoded.text).length;
      if (textBytes > IMPORT_MAX_BYTES) {
        return err(
          ledgeError('E_FILE_GUARD', {
            what: 'file-bytes',
            size: String(textBytes),
            cap: String(IMPORT_MAX_BYTES),
          }),
        );
      }
      const detected = sniffParser(decoded.text.slice(0, SNIFF_HEAD_CHARS), input.parserHint);
      if (!detected.ok) {
        return err(
          ledgeError('E_FORMAT_UNKNOWN', {
            what: detected.reason === 'hint-invalid' ? 'parser-hint' : 'import-detect',
            ...(input.parserHint !== undefined ? { hint: input.parserHint } : {}),
          }),
        );
      }
      const outcome = outcomeFor(detected.parserId, decoded.text, deps.now);
      if (outcome.deadlineBreached) {
        return err(ledgeError('E_FILE_GUARD', { what: 'parse-time', capMs: PARSE_DEADLINE_MS }));
      }
      if (detected.parserId === 'sessionbuddy' && outcome.records === 0) {
        // Structural invalidity marker from the parser (json-malformed) means
        // the file ISN'T the format — not a good file with bad rows.
        if (outcome.rejects.some((r) => r.reason === 'json-malformed'))
          return err(ledgeError('E_FORMAT_UNKNOWN', { what: 'import-json' }));
      }
      if (
        outcome.records >= REJECT_FATAL_MIN_RECORDS &&
        outcome.rejects.length * REJECT_FATAL_MAJOR_DIVISOR > outcome.records
      ) {
        return err(
          ledgeError('E_PARSE_REJECTS', {
            rejects: String(outcome.rejects.length),
            records: String(outcome.records),
          }),
        );
      }

      const stamped = stamp(outcome);
      const modelSummary = `${outcome.parserId}:m${String(stamped.missions.length)}:t${String(
        stamped.tabs,
      )}:r${String(outcome.rejects.length)}:d${String(stamped.dupesHint)}`;
      const previewId = deps.ids.nextId();
      stash.set(previewId, {
        parserId: outcome.parserId,
        missions: stamped.missions,
        rejects: outcome.rejects,
        dupesHint: stamped.dupesHint,
        modelSummary,
        stashedAt: deps.now(),
      });
      sweep();
      const model: ImportPreviewModel = {
        previewId,
        parserId: outcome.parserId,
        missions: stamped.missions.length,
        tabs: stamped.tabs,
        dupesHint: stamped.dupesHint,
        rejects: outcome.rejects.length,
        modelSummary,
      };
      return ok(model);
    },

    commit: async (input) => {
      const entry = stash.get(input.previewId);
      if (entry === undefined) {
        return err(
          ledgeError('E_DOMAIN_LEGALITY', {
            operation: 'ImporterPort:commit',
            reason: 'preview-unknown',
          }),
        );
      }
      if (deps.now() - entry.stashedAt > PREVIEW_TTL_MS) {
        stash.delete(input.previewId);
        return err(
          ledgeError('E_DOMAIN_LEGALITY', {
            operation: 'ImporterPort:commit',
            reason: 'preview-stale',
          }),
        );
      }
      const skip = input.dedupeMode === 'skip';
      const missions: ImportedMissionPlan[] = entry.missions
        .map((mission) => ({
          name: mission.name,
          tabs: mission.tabs
            .filter((tab) => !(skip && tab.dupe))
            .map((tab): ImportedTabPlan => {
              const plan: ImportedTabPlan = {
                url: tab.url,
                title: tab.title,
                domain: tab.domain,
                urlCanon: tab.urlCanon,
              };
              return plan;
            }),
        }))
        .filter((mission) => mission.tabs.length > 0);
      const plan: ImportCommitPlan = {
        batchId: input.previewId, // the idempotency derive (C21)
        source: entry.parserId,
        canonRulesV: CANON_RULES_V1.version,
        missions,
        dupes: entry.dupesHint,
        rejects: entry.rejects.length,
      };
      return ok(plan);
    },

    fetchRejects: (previewId) => stash.get(previewId)?.rejects,
  };
};

/** Parser ids (the parserHint enum's members — the E5 tier's row in §3). */
export { PARSER_IDS };
