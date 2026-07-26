// E5-T03 · Exporters family surface (ADR-045). Public grammar: model → parts →
// verified assembly → plan/artifacts. The family imports durability ONLY through
// application ports (depcruise importers-exporters-via-application-only).
export {
  buildModel,
  EXPORT_APP_NAME,
  EXPORT_FORMAT,
  EXPORT_FORMAT_V,
  type BuildModelInput,
  type CanonicalExportModel,
  type ExportDiagnostics,
  type ExportMissionModel,
  type ExportModelSource,
  type ExportTabModel,
} from './model.js';
export { createEngineModelSource } from './model-source.js';
export { jsonParts, LOOSE_BATCH } from './render-json.js';
export { htmlParts, HTML_SECTION_BATCH } from './render-html.js';
export { mdParts, MD_SECTION_BATCH } from './render-md.js';
export {
  assembleVerified,
  chunkOk,
  MANIFEST_PART_ID,
  REGEN_ATTEMPTS,
  streamParts,
  type ExportArtifact,
  type ManifestPart,
  type RawPart,
  type RenderChunk,
  type RenderManifest,
} from './stream.js';
export {
  createExportersAdapter,
  EXPORT_ARTIFACT_CAP,
  EXPORT_ARTIFACT_TTL_MS,
  type ExportersAdapter,
  type ExportersAdapterDeps,
} from './exporters.adapter.js';
