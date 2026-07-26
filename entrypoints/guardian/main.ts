// Guardian surface entrypoint (ADR-025: composition lives in roots, markup stays thin).
import { bootstrapGuardian } from '@/roots/guardian-root';

bootstrapGuardian(document);
