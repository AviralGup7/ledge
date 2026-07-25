// Public surface of shared-kernel/clock (E1-T05 · EES §2.2).
export type { Hlc } from './hlc.js';
export { advance, compareHlc, equalHlc, isHlc, isRegression, merge, zeroHlc } from './hlc.js';
