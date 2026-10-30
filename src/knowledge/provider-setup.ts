import type { KnowledgeStore } from "./store.js";
import { ProviderRegistry, type ProviderConfigInput, type ProviderProbeReport } from "./provider-registry.js";
import { ProviderCredentialStore } from "./provider-credential-store.js";
import { chainSecretResolvers, EnvironmentSecretResolver } from "./provider-secret.js";
import { callOpenAiChat, callOpenAiEmbedding, callOpenAiRerank, listOpenAiModels, type ManagedHttpOptions } from "./provider-probe.js";
import { admitProviderConfigurationProbe } from "./provider-admission.js";

export function createManagedProviderRegistry(store: KnowledgeStore): ProviderRegistry {
  return new ProviderRegistry(store, undefined, {
    secrets: chainSecretResolvers(new ProviderCredentialStore(store), new EnvironmentSecretResolver()),
  });
}

export function normalizeProviderEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("Enter a valid provider Base URL"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Base URL must use HTTP(S), without credentials, query parameters or fragments");
  }
  if (url.pathname === "/") url.pathname = "/v1";
  return url.toString().replace(/\/+$/, "");
}

export type ProviderSetupInput = Pick<ProviderConfigInput, "id" | "kind" | "provider" | "modelId" | "actorId"> & { baseUrl: string; token: string };

/** Only fixed connectivity probe content is sent before configuration is committed. */
export class ProviderSetupService {
  private readonly credentials: ProviderCredentialStore;
  private readonly registry: ProviderRegistry;
  constructor(private readonly store: KnowledgeStore) {
    this.credentials = new ProviderCredentialStore(store);
    this.registry = createManagedProviderRegistry(store);
  }

  async models(input: { baseUrl: string; token: string }) {
    const baseUrl = normalizeProviderEndpoint(input.baseUrl);
    const models = await listOpenAiModels({ baseUrl, token: input.token, modelId: "", signal: AbortSignal.timeout(15_000) });
    return { baseUrl, models };
  }

  private async probe(input: Pick<ProviderSetupInput, "kind" | "modelId" | "token" | "baseUrl">, dimensions?: number, providerId?: string): Promise<ProviderProbeReport> {
    // Configuration and token validation use candidate credentials, so they
    // cannot resolve the existing handle. They still consume its durable
    // allowance before transport, including failures and disabled-provider validation. An initial, unsaved
    // provider has no configured quota; listing model metadata is not a call.
    if (providerId && this.registry.get(providerId)) admitProviderConfigurationProbe(this.store, providerId);
    const options: ManagedHttpOptions = { ...input, signal: AbortSignal.timeout(30_000) };
    if (input.kind === "embedding") {
      const result = await callOpenAiEmbedding({ ...options, texts: ["relay provider connectivity probe"], expectedDimensions: dimensions });
      return { ok: true, observedDimensions: result.vectors[0].length, latencyMs: result.latencyMs, httpStatus: result.status };
    }
    const result = input.kind === "rerank"
      ? await callOpenAiRerank({ ...options, query: "relay", documents: ["relay connectivity probe"] })
      : await callOpenAiChat({ ...options, prompt: "Reply with the word ok.", maxTokens: 8 });
    return { ok: true, latencyMs: result.latencyMs, httpStatus: result.status };
  }

  private reference(id: string): string | undefined {
    return (this.store.db.prepare("SELECT secret_ref FROM knowledge_provider_configs WHERE id=?").get(id) as { secret_ref?: string } | undefined)?.secret_ref;
  }

  private snapshot(id: string): string {
    return JSON.stringify(this.store.db.prepare("SELECT * FROM knowledge_provider_configs WHERE id=?").get(id) ?? null);
  }

  private assertUnchanged(id: string, snapshot: string): void {
    if (this.snapshot(id) !== snapshot) throw new Error("Provider configuration changed during testing; reload and try again");
  }

  async configure(input: ProviderSetupInput) {
    const snapshot = this.snapshot(input.id);
    const { baseUrl, models } = await this.models(input);
    if (!models.some((model) => model.id === input.modelId)) throw new Error("Select a model returned by this provider");
    const report = await this.probe({ ...input, baseUrl }, undefined, input.id);
    return this.store.db.transaction(() => {
      this.assertUnchanged(input.id, snapshot);
      const previous = this.registry.get(input.id);
      const oldRef = this.reference(input.id);
      const secretRef = this.credentials.save(input.token);
      const provider = this.registry.upsert({
        ...previous, id: input.id, kind: input.kind, provider: input.provider,
        baseUrl, modelId: input.modelId, actorId: input.actorId,
        dimensions: report.observedDimensions, secretRef,
      });
      this.credentials.remove(oldRef);
      this.registry.markTest(input.id, report, input.actorId);
      return { provider: this.registry.get(provider.id)!, report };
    })();
  }

  async updateToken(id: string, token: string | null, actorId: number) {
    const snapshot = this.snapshot(id);
    const provider = this.registry.get(id);
    if (!provider) throw new Error("Provider not found");
    // Validate a replacement before changing anything; never send an old token to a new endpoint.
    if (token !== null) {
      if (!provider.baseUrl) throw new Error("Provider has no Base URL");
      await this.probe({ ...provider, baseUrl: normalizeProviderEndpoint(provider.baseUrl), token }, provider.dimensions, id);
    }
    return this.store.db.transaction(() => {
      this.assertUnchanged(id, snapshot);
      const oldRef = this.reference(id);
      if (token === null) {
        this.store.db.prepare("UPDATE knowledge_provider_configs SET secret_ref=NULL,token_configured=0 WHERE id=?").run(id);
        this.registry.disable(id, actorId);
        this.store.audit({ actorId, action: "knowledge.provider.clear_token", entityType: "provider", entityId: id });
      } else {
        this.registry.rotateSecret(id, this.credentials.save(token), actorId);
        this.registry.markTest(id, { ok: true }, actorId);
      }
      this.credentials.remove(oldRef);
      return { provider: this.registry.get(id)! };
    })();
  }
  async remove(id: string, actorId: number, protectedProviderIds: ReadonlySet<string> = new Set()) {
    if (protectedProviderIds.has(id)) throw new Error("Provider is bound to the active Knowledge engine; switch the engine first");
    const provider = this.registry.get(id);
    if (!provider) throw new Error("Provider not found");
    const activeReindex = this.store.db.prepare("SELECT 1 FROM knowledge_provider_reindex_jobs WHERE provider_id=? AND status IN ('pending','running') LIMIT 1").get(id);
    if (activeReindex) throw new Error("Provider has an active reindex job; complete or stop it first");
    return this.store.db.transaction(() => {
      const oldRef = this.reference(id);
      const deleted = this.store.db.prepare("DELETE FROM knowledge_provider_configs WHERE id=?").run(id);
      if (!deleted.changes) throw new Error("Provider not found");
      this.store.db.prepare("DELETE FROM knowledge_provider_reindex_jobs WHERE provider_id=?").run(id);
      this.credentials.remove(oldRef);
      this.store.audit({ actorId, action: "knowledge.provider.delete", entityType: "provider", entityId: id });
      return { id, deleted: true };
    })();
  }
}
