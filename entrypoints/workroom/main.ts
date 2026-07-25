// Offscreen "workroom" (ADR-008): hosts heavy executors as lanes wire in E3+.
// Composition live since E1-T12: §3.6 liveness protocol answered via offscreen-root.
import { bootstrapWorkroom } from '@/roots/offscreen-root';

bootstrapWorkroom();
