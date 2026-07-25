// E3-APP · Mission deliverable "Progress reporting" — one typed progress channel per
// executing command. EES §3.3 timeout law: long operations return Ack immediately and
// continue on a progress stream; §3.5 assigns wire names per family (ImportProgress,
// ExportProgress). The APPLICATION event shape is family-agnostic; the streams hub
// (E3 slice "outbox") translates to the frozen wire names.
/** Progress event emitted inside the application boundary. */
export interface ProgressEvent {
  /** Correlation id of the owning command. */
  readonly cid: string;
  /** Command name (wire name for wire commands, internal name otherwise). */
  readonly command: string;
  /** Monotonic stage ordinal inside the handler (stages are handler-local). */
  readonly stage: number;
  /** Optional absolute positions for bar-style renderers. */
  readonly current?: number | undefined;
  readonly total?: number | undefined;
  /** Optional opaque reference payload (previewId/exportId...) — never display copy. */
  readonly ref?: string | undefined;
}

/** Emitter handed to handlers through the execution context. */
export type ProgressEmitter = (event: Omit<ProgressEvent, 'cid' | 'command'>) => void;

export const emitterFor = (
  cid: string,
  command: string,
  publish: (event: ProgressEvent) => void,
): ProgressEmitter => {
  let lastStage = 0;
  return (event) => {
    // Stage ordinals are clamped monotonic: a handler may emit stages out of order
    // (parallel subphases), the wire must never see them move backwards.
    const stage = event.stage > lastStage ? event.stage : lastStage;
    lastStage = stage;
    publish({ cid, command, ...event, stage });
  };
};
