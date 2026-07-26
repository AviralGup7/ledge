// E3-APP · Portability seams (C20/C21/C22 — Spec W14/W15 "reciprocity"). Parsers and
// renderers are infrastructure families (E5); the application layer owns the full
// orchestration contract NOW so handlers/services/tests are stable. The depcruise law
// "importers-exporters-via-application-only" means these ports NEVER touch durability:
// they return PLANS; services write truth (ImportCommitted manifest, §4).
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';

/** C20 fileMeta (wire shape; bytes move through the workroom streaming contract). */
export interface ImportFileMeta {
  readonly name: string;
  readonly size: number;
}

/** One imported tab (content level; urlCanon pre-computed by the importer family). */
export interface ImportedTabPlan {
  readonly url: string;
  readonly title: string;
  readonly domain: string;
  readonly urlCanon: string;
}

/** One imported mission (named grouping; provenance recorded as 'import'). */
export interface ImportedMissionPlan {
  readonly name: string;
  readonly tabs: readonly ImportedTabPlan[];
}

/** Preview model (C20 response rides {previewId}; the model rides ImportPreviewed). */
export interface ImportPreviewModel {
  readonly previewId: string;
  readonly parserId: string;
  readonly missions: number;
  readonly tabs: number;
  readonly dupesHint: number;
  readonly rejects: number;
  /** One-line structural summary (§4 modelSummary: never display copy, a shape key). */
  readonly modelSummary: string;
}

/** Commit input after preview (C21: preview fresh, dedupeMode decides duplicates). */
export interface ImportCommitPlan {
  readonly batchId: string;
  readonly source: string;
  readonly canonRulesV: number;
  readonly missions: readonly ImportedMissionPlan[];
  readonly dupes: number;
  readonly rejects: number;
}

export interface ImporterPort {
  /** Parse + preview (E5 workroom path behind the port). Preview ids are minted by the
   *  importer; freshness (<1h) enforcement is the commit call's law. */
  preview(input: {
    readonly fileMeta: ImportFileMeta;
    readonly parserHint?: string | undefined;
    readonly bytesRef: unknown;
  }): Promise<Result<ImportPreviewModel, LedgeError>>;
  /** Materialize the previously previewed parse into import plans (idempotent by
   *  previewId-derived batchId per C21 "idempotent by batchId"). */
  commit(input: {
    readonly previewId: string;
    readonly dedupeMode: 'skip' | 'import-anyway';
  }): Promise<Result<ImportCommitPlan, LedgeError>>;
}

/** Export scope (C22): everything, or one mission. */
export type ExportScope =
  { readonly kind: 'all' } | { readonly kind: 'mission'; readonly missionId: string };

/** Export plan the E5 renderers return; services audit-stamp ExportCompleted. */
export interface ExportPlan {
  readonly exportId: string;
  readonly scope: string;
  readonly formats: readonly ('json' | 'html' | 'md')[];
  /** Integrity stamp of the rendered manifest (§4 manifestChecksum). */
  readonly manifestChecksum: string;
  /** Opaque fetch handle the ExportReady stream delivers (E5 render storage). */
  readonly fetchRef: unknown;
}

export interface ExporterPort {
  request(input: {
    readonly scope: ExportScope;
    readonly formats: readonly ('json' | 'html' | 'md')[];
  }): Promise<Result<ExportPlan, LedgeError>>;
}
