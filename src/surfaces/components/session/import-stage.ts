// E5-T06 · Import stage writer — the surface-side narrowing of the import-bytes
// shelf (A-05 surfaces-are-authority-free: surfaces never see application ports,
// so the page root composes the full ImportBytesStagePort and the panel receives
// exactly the one verb it needs). Structural typing: any full port satisfies this
// interface; the surface cannot asks the shelf questions (takeMatching/sweep are
// SW-side concerns).
export interface StagedFile {
  readonly name: string;
  readonly size: number;
  readonly bytes: Uint8Array;
}

export type StagePutOutcome =
  | { readonly ok: true; readonly value: { readonly staged: true } }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly details?: Readonly<Record<string, unknown>> | undefined;
      };
    };

export interface ImportStageWriter {
  readonly put: (input: StagedFile) => Promise<StagePutOutcome>;
}
