// E3-APP · Portability service (C20 ImportPreviewRequest · C21 ImportCommit · C22
// ExportRequest — Spec W14/W15). Parsers/renderers are E5 infrastructure behind the
// portability ports; the APPLICATION owns orchestration + truth. Unwired ports answer
// honestly (E_CAPABILITY, never a fake success). C21 truth-write: ImportCommitted with
// the batch manifest (§4 consumers='*(all views)' — projections materialize
// missions+tabs as PARKED library entries) + R11 batch-undo atom at completion.
import type { LedgeError, Result } from '@/shared-kernel/result/index.js';
import { err, ledgeError, ok } from '@/shared-kernel/result/index.js';
import type { ExportScope } from '@/application/ports/import-export.port.js';
import type { ServiceEdge, UseCtx } from './shared/app-ctx.js';
import { opKey } from './shared/app-ctx.js';
import { readSettingsRows } from './shared/rows.js';
import { policyOf } from '@/domain/lifecycle/index.js';
import { pushUndoHinge, UNDO_STACK_STORES, type UndoEntry } from './shared/undo-stack.js';

const PORT_OP = 'command:portability';

const unwired = (family: string): LedgeError =>
  ledgeError('E_CAPABILITY', { operation: `${PORT_OP}:${family}`, fault: 'port-not-wired' });

export interface PortabilityService {
  importPreview(
    input: {
      readonly fileMeta: { readonly name: string; readonly size: number };
      readonly parserHint?: string | undefined;
      readonly bytesRef?: unknown;
    },
    ctx: UseCtx,
  ): Promise<Result<{ readonly previewId: string }, LedgeError>>;
  importCommit(
    input: { readonly previewId: string; readonly dedupeMode: 'skip' | 'import-anyway' },
    ctx: UseCtx,
  ): Promise<
    Result<
      {
        readonly batchId: string;
        readonly imported: number;
        readonly dupes: number;
        readonly rejects: number;
      },
      LedgeError
    >
  >;
  exportRequest(
    input: {
      readonly scope: ExportScope;
      readonly formats: readonly ('json' | 'html' | 'md')[];
    },
    ctx: UseCtx,
  ): Promise<Result<{ readonly exportId: string }, LedgeError>>;
}

export const createPortabilityService = (edge: ServiceEdge): PortabilityService => {
  const { deps, appender } = edge;

  return {
    importPreview: async (input, ctx) => {
      ctx.token.throwIfCancelled();
      if (deps.importer === undefined) return err(unwired('ImportPreviewRequest'));
      const model = await deps.importer.preview({
        fileMeta: input.fileMeta,
        ...(input.parserHint !== undefined ? { parserHint: input.parserHint } : {}),
        bytesRef: input.bytesRef ?? null,
      });
      if (!model.ok) return err(model.error);
      // ImportPreviewed rides the journal (transient-surface consumer; audit lineage).
      const committed = await appender.commit({
        plans: [
          {
            type: 'ImportPreviewed',
            payload: { previewId: model.value.previewId, modelSummary: model.value.modelSummary },
          },
        ],
        key: opKey(edge, 'ImportPreviewRequest', ctx.cid),
      });
      if (!committed.ok) return err(committed.error);
      ctx.progress({ stage: 2, ref: model.value.previewId });
      return ok({ previewId: model.value.previewId });
    },

    importCommit: async (input, ctx) => {
      ctx.token.throwIfCancelled();
      if (deps.importer === undefined) return err(unwired('ImportCommit'));
      const plan = await deps.importer.commit({
        previewId: input.previewId,
        dedupeMode: input.dedupeMode,
      });
      if (!plan.ok) return err(plan.error);
      ctx.progress({ stage: 2 });
      // Mint durable ids for the manifest (importer plans are content-level; truth
      // ids are the application's — referential probe: every tabId exists in tabs).
      const minted = plan.value.missions.map((m) => ({
        missionId: deps.ids.nextId(),
        name: m.name,
        tabIds: m.tabs.map(() => deps.ids.nextId()),
        sourceTabs: m.tabs,
      }));
      const manifest = {
        missions: minted.map((m) => ({
          missionId: m.missionId,
          name: m.name,
          tabIds: [...m.tabIds],
          tabs: m.sourceTabs.map((t, i) => {
            const ledgeTabId = m.tabIds[i] ?? '';
            return {
              ledgeTabId,
              url: t.url,
              title: t.title,
              domain: t.domain,
              urlCanonHash: t.urlCanon,
            };
          }),
        })),
      };
      const imported = minted.reduce((n, m) => n + m.tabIds.length, 0);
      ctx.progress({ stage: 3 });
      // R11: ONE batch-undo atom covering the import (undo trashes the batch into the
      // recovery net — four-nets layering, never invisible deletion).
      const atom: UndoEntry = {
        atomId: deps.ids.nextId(),
        kind: 'import-undo',
        payload: {
          batchId: plan.value.batchId,
          missionIds: minted.map((m) => m.missionId),
          tabIds: minted.flatMap((m) => m.tabIds),
        },
        label: 'msg.undo.imported',
        pushedAt: deps.now(),
      };
      const settings = await readSettingsRows(deps.engine);
      const cap = policyOf(settings.ok ? settings.value : undefined).undoStackCap;
      const committed = await appender.commit({
        plans: [
          {
            type: 'ImportCommitted',
            payload: {
              batchId: plan.value.batchId,
              batchManifestRef: manifest,
              source: plan.value.source,
              dupesMode: input.dedupeMode,
              canonRulesV: plan.value.canonRulesV,
            },
          },
        ],
        key: opKey(edge, 'ImportCommit', ctx.cid),
        hinge: { extraStores: UNDO_STACK_STORES, write: pushUndoHinge(atom, cap) },
      });
      if (!committed.ok) return err(committed.error);
      ctx.progress({ stage: 4, ref: plan.value.batchId });
      return ok({
        batchId: plan.value.batchId,
        imported,
        dupes: plan.value.dupes,
        rejects: plan.value.rejects,
      });
    },

    exportRequest: async (input, ctx) => {
      ctx.token.throwIfCancelled();
      if (deps.exporter === undefined) return err(unwired('ExportRequest'));
      if (input.scope.kind === 'mission') {
        const rowR = await deps.engine.txn(['missions'], 'readonly', async (tx) =>
          tx.table('missions').get(input.scope.kind === 'mission' ? input.scope.missionId : ''),
        );
        if (!rowR.ok) return err(rowR.error);
        if (rowR.value === undefined)
          return err(
            ledgeError('E_DOMAIN_LEGALITY', {
              operation: `${PORT_OP}:ExportRequest`,
              reason: 'mission-missing',
            }),
          );
      }
      const plan = await deps.exporter.request({ scope: input.scope, formats: input.formats });
      if (!plan.ok) return err(plan.error);
      ctx.progress({ stage: 2, ref: plan.value.exportId });
      const committed = await appender.commit({
        plans: [
          {
            type: 'ExportCompleted',
            payload: {
              exportId: plan.value.exportId,
              scope: plan.value.scope,
              formats: [...plan.value.formats],
              manifestChecksum: plan.value.manifestChecksum,
            },
          },
        ],
        key: opKey(edge, 'ExportRequest', ctx.cid),
      });
      if (!committed.ok) return err(committed.error);
      ctx.progress({ stage: 3, ref: plan.value.exportId });
      return ok({ exportId: plan.value.exportId });
    },
  };
};
