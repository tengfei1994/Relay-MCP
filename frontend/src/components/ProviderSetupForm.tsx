import { useState } from "react";
import { api } from "../api/client";
import { Field, Button, Input, Select } from "./ui";

const providerKinds = ["embedding", "rerank", "wiki_llm", "candidate_llm"] as const;
export type ProviderKind = typeof providerKinds[number];
export const isProviderKind = (value: string): value is ProviderKind => providerKinds.some((kind) => kind === value);
type ProviderForm = { id: string; kind: ProviderKind; provider: string; baseUrl: string; modelId: string; token: string };
const empty: ProviderForm = { id: "", kind: "embedding", provider: "openai-compatible", baseUrl: "", modelId: "", token: "" };
export type ProviderSetupDefaults = Partial<Omit<ProviderForm, "token">>;
const isProviderRecord = (value: unknown): value is { dimensions?: number } =>
  typeof value === "object" && value !== null &&
  (!("dimensions" in value) || value.dimensions === undefined || typeof value.dimensions === "number");

export function ProviderSetupForm({ initial, onSaved, onCancel }: { initial?: ProviderSetupDefaults; onSaved: (dimensions?: number) => void; onCancel: () => void }) {
  const [form, setForm] = useState<ProviderForm>({
    ...empty,
    id: initial?.id ?? empty.id,
    kind: initial?.kind ?? empty.kind,
    provider: initial?.provider ?? empty.provider,
    baseUrl: initial?.baseUrl ?? empty.baseUrl,
    modelId: initial?.modelId ?? empty.modelId,
    token: "",
  });
  const [models, setModels] = useState<Array<{ id: string }> | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<"" | "loading" | "saving">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const updateKind = (value: string) => {
    if (isProviderKind(value)) setForm((current) => ({ ...current, kind: value }));
  };
  const updateConnection = (key: "baseUrl" | "token", value: string) => {
    setForm((current) => ({ ...current, [key]: value, modelId: "" }));
    setModels(null); setFilter(""); setError(""); setNotice("");
  };
  const discover = async () => {
    setBusy("loading"); setError(""); setNotice(""); setModels(null); setForm((current) => ({ ...current, modelId: "" }));
    try {
      const result = await api.knowledgeProviderModels({ baseUrl: form.baseUrl.trim(), token: form.token.trim() });
      setModels(result.models);
      setNotice(result.models.length ? `${result.models.length} models available. Choose a model below.` : "No models returned. Check this token's model permissions.");
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to fetch models"); }
    finally { setBusy(""); }
  };
  const save = async () => {
    if (!models?.some((model) => model.id === form.modelId)) return;
    setBusy("saving"); setError(""); setNotice("");
    try {
      const result = await api.knowledgeProviderConfigure(form.id.trim(), { kind: form.kind, provider: form.provider.trim(), baseUrl: form.baseUrl.trim(), modelId: form.modelId, token: form.token.trim() });
      setForm(empty); setModels(null); setFilter(""); onSaved(isProviderRecord(result.provider) ? result.provider.dimensions : undefined);
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to save provider"); }
    finally { setBusy(""); }
  };
  const shown = models?.filter((model) => model.id.toLowerCase().includes(filter.toLowerCase()) || model.id === form.modelId) ?? [];
  return <section className="glass p-5" aria-label="Provider setup">
    <h2 className="font-display text-lg font-semibold">{initial ? "Edit provider" : "Configure provider"}</h2>
    <p className="mt-1 max-w-prose text-sm text-muted">Enter a gateway connection, fetch its models, then test and save your selection.</p>
    <fieldset disabled={Boolean(busy)} className="mt-4 space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Provider ID"><Input value={form.id} disabled={Boolean(initial)} onChange={(event) => setForm({ ...form, id: event.target.value })} placeholder="For example, botcf-embedding" /></Field>
        <Field label="Provider name"><Input value={form.provider} onChange={(event) => setForm({ ...form, provider: event.target.value })} /></Field>
        <Field label="Base URL"><Input type="url" value={form.baseUrl} onChange={(event) => updateConnection("baseUrl", event.target.value)} placeholder="https://gateway.example/v1" autoComplete="off" /></Field>
        <Field label="API token"><Input type="password" value={form.token} onChange={(event) => updateConnection("token", event.target.value)} autoComplete="new-password" spellCheck={false} placeholder={initial ? "Enter token to reconnect" : "Enter gateway token"} /></Field>
      </div>
      <p className="text-xs text-muted">Tokens are encrypted on the server and never returned to this page.</p>
      <Button type="button" disabled={Boolean(busy) || !form.baseUrl.trim() || !form.token.trim()} onClick={() => void discover}>{busy === "loading" ? "Fetching models" : "Fetch models"}</Button>
      {notice && <p role="status" className="text-sm text-fg">{notice}</p>}
      {models && models.length > 0 && <div className="space-y-3 border-t border-white/10 pt-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Purpose"><Select value={form.kind} onChange={(event) => updateKind(event.target.value)}><option value="embedding">Embedding</option><option value="rerank">Rerank</option><option value="wiki_llm">Wiki generation</option><option value="candidate_llm">Candidate generation</option></Select></Field>
          <Field label="Search models"><Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter by model name" /></Field>
        </div>
        <Field label="Model"><Select value={form.modelId} onChange={(event) => setForm({ ...form, modelId: event.target.value })}><option value="">Select a model</option>{shown.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}</Select></Field>
        {!shown.length && <p className="text-sm text-muted">No models match this search.</p>}
        <p className="text-xs text-muted">The selected purpose is verified with a small API request before saving.{form.kind === "embedding" ? " Embedding dimensions are detected automatically." : ""}</p>
        <Button type="button" disabled={Boolean(busy) || !form.id.trim() || !form.provider.trim() || !models.some((model) => model.id === form.modelId)} onClick={() => void save}>{busy === "saving" ? "Testing and saving" : "Test and save"}</Button>
      </div>}
      {initial && <Button type="button" variant="ghost" onClick={onCancel}>Cancel editing</Button>}
    </fieldset>
    {error && <p role="alert" className="mt-3 rounded-field border border-coral/40 bg-coral/10 p-3 text-sm text-coral">{error}</p>}
  </section>;
}
