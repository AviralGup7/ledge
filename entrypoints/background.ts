// MV3 law: all listeners must register synchronously at top level (ADR-007).
// Composition root only (ADR-025); feature wiring attaches to the graph in E2.
import { bootstrapBackground } from '@/roots/bg-root';

export default defineBackground(() => {
  bootstrapBackground();
});
