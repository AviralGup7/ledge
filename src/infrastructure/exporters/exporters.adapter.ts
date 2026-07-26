// E5-T03 · Exporters adapter — the ExporterPort implementation. Composes the
// ADR-045 pipeline: canonical model (projection snapshot via the injected
// source) → deterministic renderers (json seals the manifest; html/md are
// human artifacts) → verifying assembly (chunk-verify-then-present; a render
// failure is E_RENDER_FATAL, never a partial). Rendered artifacts live in a
// bounded in-memory registry keyed by exportId (the ExportReady fetch
// machinery's material — the stream fields are the follow-up door; this WP
// ships the render pipeline they will serve).
import type {
  ExportPlan,
  ExporterPort,
  ExportScope,
} from '@/application/ports/import-export.port.js';
import { CANON_RULES_V1 } from '@/shared-kernel/canon/index.js';
import type { IdGenerator, Now } from '@/shared-kernel/identity/index.js';
import { err, ledgeError, ok, type LedgeError, type Result } from '@/shared-kernel/result/index.js';
import { buildModel, type CanonicalExportModel, type ExportModelSource } from './model.js';
import { htmlParts } from './render-html.js';
import { jsonParts } from './render-json.js';
import { mdParts } from './render-md.js';
import { assembleVerified, streamParts, type ExportArtifact, type RawPart } from './stream.js';

/** ExportRequest formats in canonical render order (the seal rides json first). */
const FORMAT_ORDER = ['json', 'html', 'md'] as const;
type ExportFormat = (typeof FORMAT_ORDER)[number];

/** Artifact registry bounds (memory law: never an unbounded SW-side pile). */
export const EXPORT_ARTIFACT_TTL_MS = 600_000;
export const EXPORT_ARTIFACT_CAP = 4;

interface ArtifactSet {
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly artifacts: Readonly<Partial<Record<ExportFormat, ExportArtifact>>>;
  readonly modelMeta: {
    readonly missions: number;
    readonly missionTabs: number;
    readonly looseTabs: number;
  };
}

export interface ExportersAdapterDeps {
  readonly source: ExportModelSource;
  readonly ids: IdGenerator;
  readonly now: Now;
  /** Contract hash of the running build (provenance stamp; root-composed). */
  readonly build: string;
}

const renderers: Record<ExportFormat, (model: CanonicalExportModel) => readonly RawPart[]> = {
  json: jsonParts,
  html: htmlParts,
  md: mdParts,
};

const scopeString = (scope: ExportScope): string =>
  scope.kind === 'all' ? 'all' : `mission:${scope.missionId}`;

const modelScopeOf = (scope: ExportScope): 'all' | { readonly mission: string } =>
  scope.kind === 'all' ? 'all' : { mission: scope.missionId };

export interface ExportersAdapter extends ExporterPort {
  /** Diagnostics/fetch seam: the rendered artifact set for a live exportId. */
  fetchArtifact(exportId: string): ArtifactSet | undefined;
}

export const createExportersAdapter = (deps: ExportersAdapterDeps): ExportersAdapter => {
  const registry = new Map<string, ArtifactSet>();

  const sweep = (nowMs: number): void => {
    for (const [id, set] of registry) {
      if (set.expiresAt <= nowMs) registry.delete(id);
    }
    while (registry.size > EXPORT_ARTIFACT_CAP) {
      const oldest = registry.keys().next().value;
      if (oldest === undefined) break;
      registry.delete(oldest);
    }
  };

  return {
    fetchArtifact: (exportId) => {
      const set = registry.get(exportId);
      if (set === undefined) return undefined;
      if (set.expiresAt <= deps.now()) {
        registry.delete(exportId);
        return undefined;
      }
      return set;
    },

    request: async (input): Promise<Result<ExportPlan, LedgeError>> => {
      const [missions, tabs] = await Promise.all([deps.source.missions(), deps.source.tabs()]);
      if (!missions.ok) return err(missions.error);
      if (!tabs.ok) return err(tabs.error);

      const model = buildModel({
        scope: modelScopeOf(input.scope),
        rows: { missions: missions.value, tabs: tabs.value },
        build: deps.build,
        canonRulesV: CANON_RULES_V1.version,
        now: deps.now,
      });

      const requested = FORMAT_ORDER.filter((f) => input.formats.includes(f));
      const [firstFormat] = requested;
      if (firstFormat === undefined) {
        // The wire constrains format VALUES but not array emptiness — an empty
        // request reaching here is a domain legality fault, not a render fault.
        return err(
          ledgeError('E_DOMAIN_LEGALITY', { operation: 'export:request', reason: 'formats-empty' }),
        );
      }

      const artifacts: Partial<Record<ExportFormat, ExportArtifact>> = {};
      for (const format of requested) {
        const parts = renderers[format](model);
        const assembled = await assembleVerified(format, () => streamParts(parts));
        if (!assembled.ok) return err(assembled.error);
        artifacts[format] = assembled.value;
      }

      // Plan seal: the json manifest is the canonical seal (ADR-045 fidelity
      // format); without json requested, the first rendered format seals.
      const seal = artifacts['json'] ?? artifacts[firstFormat];
      if (seal === undefined) {
        return err(
          ledgeError('E_RENDER_FATAL', { format: firstFormat, fault: 'seal-missing-after-render' }),
        );
      }
      const exportId = deps.ids.nextId();

      const nowMs = deps.now();
      registry.set(exportId, {
        createdAt: nowMs,
        expiresAt: nowMs + EXPORT_ARTIFACT_TTL_MS,
        artifacts,
        modelMeta: {
          missions: model.missions.length,
          missionTabs: model.missions.reduce((n, m) => n + m.tabs.length, 0),
          looseTabs: model.looseTabs.length,
        },
      });
      // Registry law: trim AFTER insert (expired-then-oldest); a sweep before the
      // insert would let the fresh entry push past the cap by one.
      sweep(nowMs);

      return ok({
        exportId,
        scope: scopeString(input.scope),
        formats: requested,
        manifestChecksum: seal.manifest.manifestChecksum,
        fetchRef: { exportId },
      });
    },
  };
};
