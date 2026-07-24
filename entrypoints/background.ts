// MV3 law: all listeners must register synchronously at top level (ADR-007).
// M0 scaffold — composition root only. Real wiring arrives in Tier 1 (E2-*); no feature code here.
import { bootstrapBackground } from '@/roots/bg-root';

export default defineBackground(() => {
  bootstrapBackground();
});
