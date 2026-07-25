// E3-APP · Handler registries — the closed-world parity table. Contracts freeze which
// names EXIST (EES §3 registry, ADR-010); this registry records which names this build
// SERVES. The parity test asserts: every v1 command/query name contracts know is served
// by exactly one command bus handler — any name in contracts without a handler here is
// a CI red, any handler without a contracts name is a CI red (closed world both ways).
import type { CommandRegistration, QueryRegistration, Handler } from './types.js';

export type { CommandRegistration, QueryRegistration } from './types.js';

export interface HandlerRegistry<S> {
  readonly command: (name: string) => CommandRegistration<S> | undefined;
  readonly query: (name: string) => QueryRegistration<S> | undefined;
  readonly commandNames: () => readonly string[];
  readonly queryNames: () => readonly string[];
}

/** Build the immutable registries; duplicate registration is a boot-time defect. */
export const createHandlerRegistry = <S>(deps: {
  readonly commands: readonly CommandRegistration<S>[];
  readonly queries: readonly QueryRegistration<S>[];
}): HandlerRegistry<S> => {
  const commands = new Map<string, CommandRegistration<S>>();
  for (const registration of deps.commands) {
    if (commands.has(registration.name))
      throw new Error(`dispatch registry: duplicate command handler "${registration.name}"`);
    commands.set(registration.name, registration);
  }
  const queries = new Map<string, QueryRegistration<S>>();
  for (const registration of deps.queries) {
    if (queries.has(registration.name))
      throw new Error(`dispatch registry: duplicate query handler "${registration.name}"`);
    queries.set(registration.name, registration);
  }
  return {
    command: (name) => commands.get(name),
    query: (name) => queries.get(name),
    commandNames: () => [...commands.keys()],
    queryNames: () => [...queries.keys()],
  };
};

/** Convenience: register a command with lane default (interactive). */
export const commandOf = <S>(
  name: string,
  handler: Handler<S>,
  options?: Omit<CommandRegistration<S>, 'name' | 'handler'>,
): CommandRegistration<S> => ({ name, handler, ...options });

/** Convenience: register a query. */
export const queryOf = <S>(name: string, handler: Handler<S>): QueryRegistration<S> => ({
  name,
  handler,
});
