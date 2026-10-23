/**
 * Secret resolution boundary for managed providers. Plaintext credentials only
 * exist behind this interface and are injected by the backend host; the
 * registry, DTOs, and audit trail only ever see opaque references.
 */
export interface SecretResolver {
  /** Resolve a secret reference to its current value at call time. */
  resolve(ref: string): Promise<string | undefined>;
}

/**
 * Resolves `env://VAR_NAME` references from the process environment at call
 * time, so rotating the environment value (or the reference) takes effect on
 * the next resolve without any cached plaintext.
 */
export class EnvironmentSecretResolver implements SecretResolver {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async resolve(ref: string): Promise<string | undefined> {
    if (!ref.startsWith("env://")) return undefined;
    const name = ref.slice("env://".length);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined;
    return this.env[name];
  }
}

/**
 * In-memory resolver for tests and local development. Values live in process
 * memory only and are never persisted.
 */
export class InMemorySecretResolver implements SecretResolver {
  private readonly values = new Map<string, string>();
  /** References asked for, in order; lets tests assert which ref was used. */
  readonly resolutions: string[] = [];

  set(ref: string, value: string): void {
    this.values.set(ref, value);
  }

  remove(ref: string): void {
    this.values.delete(ref);
  }

  async resolve(ref: string): Promise<string | undefined> {
    this.resolutions.push(ref);
    return this.values.get(ref);
  }
}

/** Try each resolver in order and return the first defined value. */
export function chainSecretResolvers(...resolvers: Array<SecretResolver | undefined>): SecretResolver {
  const chain = resolvers.filter((resolver): resolver is SecretResolver => Boolean(resolver));
  return {
    async resolve(ref: string): Promise<string | undefined> {
      for (const resolver of chain) {
        const value = await resolver.resolve(ref);
        if (value !== undefined) return value;
      }
      return undefined;
    },
  };
}
