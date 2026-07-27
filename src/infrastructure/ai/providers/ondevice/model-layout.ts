// E8-T03 · layout contract between tools/ondevice-model/build-model.mjs and the
// runtime. The builder pins these numbers; the runtime reads them from HERE —
// drift is impossible without touching both (and check:ondevice-model
// byte-compares the artifacts the numbers describe).
export const MODEL_V = 1;
export const MODEL_CLASS = 'ondevice-fwd-v1';
export const NEEDLE_BASE = 4096;
export const TEXT_PTR = 16384;
export const WEIGHTS_HEADER_BYTES = 28;
export const WEIGHTS_FRAME_REC_BYTES = 32;
export const WEIGHTS_TERM_REC_BYTES = 8;
