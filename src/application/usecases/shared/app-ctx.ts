// E3-APP · Service plumbing — the context every use-case service receives. Services
// are the PUBLIC application layer (one service per use case, per the E3 mission):
// UI/surfaces talk to them through handlers; they never know journal/ledger/storage
// exist. Deps flow through the composition root (roots wire ports; tests wire fakes).
import type {
  ExporterPort,
  ImportBytesStagePort,
  ImporterPort,
} from '@/application/ports/import-export.port.js';
import type { IntentLedgerPort } from '@/application/ports/intent-ledger.port.js';
import type { JournalPort } from '@/application/ports/journal.port.js';
import type { ProjectionEnginePort } from '@/application/ports/projection-engine.port.js';
import type { DiagnosticsPort } from '@/application/ports/diagnostics.port.js';
import type { NativeSessionsPort } from '@/application/ports/sessions.port.js';
import type { SnapshotsPort } from '@/application/ports/snapshots.port.js';
import type { StorageEnginePort } from '@/application/ports/storage-engine.port.js';
import type { TabsPort } from '@/application/ports/tabs.port.js';
import type { WindowsPort } from '@/application/ports/windows.port.js';
import type { SearchRankPort } from '@/application/ports/search.port.js';
import type {
  AiJobQueuePort,
  AiWorkerHost,
  ProviderBreakerReport,
  WorkroomPair,
} from '@/application/ports/ai-jobs.port.js';
import type { CancelToken } from '@/application/hub/dispatch/cancellation.js';
import type { ProgressEmitter } from '@/application/hub/dispatch/progress.js';
import type { IngestHub } from '@/application/hub/ingest/types.js';
import type { DeviceId } from '@/shared-kernel/identity/device-id.js';
import type { IdGenerator, Now } from '@/shared-kernel/identity/index.js';
import type { StreamAppender } from './stream-appender.js';

/** E8-T01 · AI pipeline assembly seams (EES §2.12). Declared HERE — the service
 *  implementation consumes them one-directionally (usecases/ai-jobs.ts → app-ctx);
 *  the queue/host/breaker types are the port's (application-never-touches-
 *  infrastructure proof is the import list above). */
export interface AiJobScheduler {
  readonly after: (delayMs: number, fn: () => void) => () => void;
}

/** §10 lane-window gate: interactive never sheds; maintenance runs freely;
 *  background claims ONLY in caller-proven idle+battery-ok windows (conservative
 *  default: unproven ⇒ held — E3-T04's idle adapter is the future live source). */
export interface AiLaneWindowPort {
  readonly maintenanceOk: () => Promise<boolean>;
  readonly backgroundOk: () => Promise<boolean>;
}

export interface AiJobsServiceDeps {
  readonly queue: AiJobQueuePort;
  readonly swLocal: AiWorkerHost;
  readonly workroom: WorkroomPair | null;
  /** Breaker evidence seam (the ladder's reports — probe-facing, read-only). */
  readonly breakers: () => readonly ProviderBreakerReport[];
  readonly window: AiLaneWindowPort;
  readonly scheduler: AiJobScheduler;
}

/** Composition-wired ports (roots fill; every member a port seam, never an impl). */
export interface ServiceDeps {
  readonly engine: StorageEnginePort;
  readonly journal: JournalPort;
  readonly projections: ProjectionEnginePort;
  readonly ledger: IntentLedgerPort;
  readonly snapshots: SnapshotsPort;
  readonly tabs: TabsPort;
  readonly windows: WindowsPort;
  readonly ids: IdGenerator;
  readonly deviceId: DeviceId;
  readonly now: Now;
  /** First-run crawl (C1) — the ingest hub use case reused by the system service. */
  readonly ingest?: IngestHub | undefined;
  /** Portability seams (E5 importers/exporters families; undefined ⇒ E_CAPABILITY). */
  readonly importer?: ImporterPort | undefined;
  readonly exporter?: ExporterPort | undefined;
  /** E5-T06 import-bytes shelf (v1 workroom-contract frame; undefined ⇒ the wire's
   *  bytesRef-less requests refuse E_FORMAT_UNKNOWN 'import-bytes' as before). */
  readonly importBytesStage?: ImportBytesStagePort | undefined;
  /** Reflex Search rank seam (E5-T01; undefined ⇒ §6.6 fallback sweep, honestly flagged). */
  readonly search?: SearchRankPort | undefined;
  /** E6-T02 sessions cross-check seam (boot-incident candidate snapshot; undefined ⇒
   *  the snapshot is skipped and the card carries no candidates row — degrade, never
   *  fault the boot act). Read-only by port law (E3-T03). */
  readonly sessions?: NativeSessionsPort | undefined;
  /** E6-T03 diagnostics seam (EES §2.15: unified typed ring, redactor, probes,
   *  bundle). undefined ⇒ services fall back to their pre-T03 inline ring writes
   *  and getHealth answers the legacy ad-hoc dump (degrade, never fault). */
  readonly diagnostics?: DiagnosticsPort | undefined;
  /** E8-T01 AI pipeline seams (queue + hosts + lane windows — EES §2.12).
   *  undefined ⇒ the aiJobs service member is ABSENT (hosts without the AI graph
   *  stay honest-grey on the ai-lanes probe; Principle 29 coherence unaffected). */
  readonly ai?: AiJobsServiceDeps | undefined;
}

/** Per-invocation dispatch facts a service may need (never the raw wire message). */
export interface UseCtx {
  readonly cid: string;
  readonly token: CancelToken;
  readonly progress: ProgressEmitter;
  readonly notifyPending: (intentId: string) => void;
}

/** Edge shared by every service factory: ports + the serialized truth-writer. */
export interface ServiceEdge {
  readonly deps: ServiceDeps;
  readonly appender: StreamAppender;
}

/** Idempotent op key (journal idempotency law): unique per invocation by opId; the
 *  dispatcher's cid dedupe handles wire-level duplicates, the ledger's cid map covers
 *  intents, and late post-dedupe duplicates mint a fresh opId so the journal NEVER
 *  sees key-reuse-with-alien-content (E_JOURNAL_INTEGRITY) on a benign retry. */
export const opKey = (edge: ServiceEdge, family: string, cid: string): string =>
  `${family}:${cid}:${edge.deps.ids.nextId()}`;
