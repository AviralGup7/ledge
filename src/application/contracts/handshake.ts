// E1-T11 · ADR-010 handshake-checked channels. At Port open the surface sends Hello;
// SW answers with its own build facts. Agreement = {v, contractHash} equality. Skew ⇒
// schema-mismatch — the caller then emits ResyncRequired{schema} with the calm update
// prompt (§3.5 compat law: never silent partial rendering).
import { ledgeError, type LedgeError } from '@/shared-kernel/result/index.js';
import { CONTRACT_V, SENDER_CONTEXTS, type SenderContext } from './envelope.js';

export interface Hello {
  readonly v: number;
  readonly senderContext: SenderContext;
  readonly contractHash: string;
}

export type HandshakeOutcome =
  | { readonly status: 'compatible'; readonly hello: Hello }
  | {
      readonly status: 'schema-mismatch';
      readonly reason: 'version' | 'hash';
      readonly remote: Hello;
    }
  | { readonly status: 'rejected'; readonly error: LedgeError };

/** Total: any wire garbage ⇒ a typed outcome, never a throw (same fuzz law as messages). */
export function checkHello(
  raw: unknown,
  local: { readonly contractHash: string },
): HandshakeOutcome {
  if (typeof raw !== 'object' || raw === null) {
    return {
      status: 'rejected',
      error: ledgeError('E_OUTPUT_MALFORMED', { what: 'hello-not-record' }),
    };
  }
  const h = raw as Record<string, unknown>;
  const ctx = h['senderContext'];
  if (
    typeof ctx !== 'string' ||
    !(SENDER_CONTEXTS as readonly string[]).includes(ctx) ||
    typeof h['contractHash'] !== 'string' ||
    !Number.isSafeInteger(h['v'])
  ) {
    return {
      status: 'rejected',
      error: ledgeError('E_OUTPUT_MALFORMED', { what: 'hello-fields' }),
    };
  }
  const hello: Hello = {
    v: h['v'] as number,
    senderContext: ctx as SenderContext,
    contractHash: h['contractHash'] as string,
  };
  if (hello.v !== CONTRACT_V)
    return { status: 'schema-mismatch', reason: 'version', remote: hello };
  if (hello.contractHash !== local.contractHash) {
    return { status: 'schema-mismatch', reason: 'hash', remote: hello };
  }
  return { status: 'compatible', hello };
}

/** Build this side's Hello (SW + surfaces both originate). */
export const makeHello = (senderContext: SenderContext, contractHash: string): Hello => ({
  v: CONTRACT_V,
  senderContext,
  contractHash,
});
