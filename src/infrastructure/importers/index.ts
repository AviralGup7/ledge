// E5-T05 · Importers family surface (ADR-044). Public grammar: transport →
// detect → pure parse outcome (quarantined rejects) → canon-stamped preview →
// commit plan (one undoable batch). The family imports durability ONLY through
// application ports (depcruise importers-exporters-via-application-only).
export {
  BOM,
  IMPORT_MAX_BYTES,
  PARSE_DEADLINE_MS,
  PARSER_IDS,
  REJECT_EXCERPT_MAX,
  URL_SCHEME_ALLOW,
  excerptOf,
  verdictUrl,
  type ParseOutcome,
  type ParsedMissionDraft,
  type ParsedTabDraft,
  type ParserId,
  type RejectRow,
} from './model.js';
export { sniffParser, SNIFF_HEAD_CHARS } from './detect.js';
export { parseOneTab } from './parser-onetab.js';
export { parseSessionBuddy, readSessionBuddyJson } from './parser-sessionbuddy.js';
export { parseNetscape } from './parser-netscape.js';
export {
  createImportersAdapter,
  PREVIEW_STASH_CAP,
  PREVIEW_TTL_MS,
  type ImportersAdapter,
  type ImportBytesTransport,
} from './importers.adapter.js';
