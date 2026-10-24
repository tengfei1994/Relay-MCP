import { useState } from "react";
import { api } from "../api/client";
import { cardClass, inputClass } from "./KnowledgePrimitives";

const control = inputClass + " w-full !h-11";
const button = "min-h-11 rounded-md bg-indigo-600 px-4 text-sm text-white hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400 disabled:opacity-50";
const empty = { id: "", kind: "embedding", provider: "openai-compatible", baseUrl: "", modelId: "", token: "" };
export type ProviderSetupDefaults = Partial<Omit<typeof empty, "token">>;

export function ProviderSetupForm({ initial, onSaved, onCancel }: {
  initial?: ProviderSetupDefaults; onSaved: (dimensions?: number) => void; onCancel: () => void;
}) {
  const [form, setForm] = useState({ ...empty, ...initial, token: "" });
  const [models, setModels] = useState<Array<{ id: string }> | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<"" | "loading" | "saving">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const updateConnection = (key: "baseUrl" | "token", value: string) => {
    setForm({ ...form, [key]: value, modelId: "" });
    setModels(null); setFilter(""); setError(""); setNotice("");
  };
  const discover = async () => {
    setBusy("loading"); setError(""); setNotice(""); setModels(null);
    setForm((current) => ({ ...current, modelId: "" }));
    try {
      const result = await api.knowledgeProviderModels({ baseUrl: form.baseUrl.trim(), token: form.token.trim() });
      setModels(result.models);
      setNotice(result.models.length ? result.models.length + " models available. Choose a model below." : "No models returned. Check this token's model permissions.");
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to fetch models"); }
    finally { setBusy(""); }
  };
  const save = async () => {
    if (!models?.some((model) => model.id === form.modelId)) return;
    setBusy("saving"); setError(""); setNotice("");
    try {
      const result = await api.knowledgeProviderConfigure(form.id.trim(), {
        kind: form.kind, provider: form.provider.trim(), baseUrl: form.baseUrl.trim(), modelId: form.modelId, token: form.token.trim(),
      });
      setForm(empty); setModels(null); setFilter("");
      onSaved(result.provider.dimensions);
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to save provider"); }
    finally { setBusy(""); }
  };
  const shown = models?.filter((model) => model.id.toLowerCase().includes(filter.toLowerCase()) || model.id === form.modelId) ?? [];
  return <section className={cardClass} aria-label="Configure provider">
    <h3 className="font-medium text-gray-100">{initial ? "Edit provider" : "Configure provider (admin)"}</h3>
    <p className="mt-1 text-sm text-gray-400">Enter your gateway connection, fetch its models, then test and save your selection.</p>
    <fieldset disabled={Boolean(busy)} className="mt-4 space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 text-sm text-gray-300"><span>Provider ID</span><input className={control} value={form.id} disabled={Boolean(initial)} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="e.g. botcf-embedding" /></label>
        <label className="space-y-1 text-sm text-gray-300"><span>Provider name</span><input className={control} value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} /></label>
        <label className="space-y-1 text-sm text-gray-300"><span>Base URL</span><input className={control} type="url" value={form.baseUrl} onChange={(e) => updateConnection("baseUrl", e.target.value)} placeholder="https://gateway.example/v1" autoComplete="off" /></label>
        <label className="space-y-1 text-sm text-gray-300"><span>API token</span><input className={control} type="password" value={form.token} onChange={(e) => updateConnection("token", e.target.value)} autoComplete="new-password" spellCheck={false} placeholder={initial ? "Enter token to reconnect" : "Enter gateway token"} /></label>
      </div>
      <p className="text-xs text-gray-400">Tokens are encrypted on the server and never returned to this page.</p>
      <button type="button" className={button} disabled={Boolean(busy) || !form.baseUrl.trim() || !form.token.trim()} onClick={discover}>{busy === "loading" ? "Fetching models…" : "Fetch models"}</button>
      {notice && <p role="status" className="text-sm text-gray-300">{notice}</p>}
      {models && models.length > 0 && <div className="space-y-3 border-t border-gray-800 pt-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1 text-sm text-gray-300"><span>Purpose</span><select className={control} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            <option value="embedding">Embedding</option><option value="rerank">Rerank</option><option value="wiki_llm">Wiki generation</option><option value="candidate_llm">Candidate generation</option>
          </select></label>
          <label className="space-y-1 text-sm text-gray-300"><span>Search models</span><input className={control} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by model name" /></label>
        </div>
        <label className="block space-y-1 text-sm text-gray-300"><span>Model</span><select className={control} value={form.modelId} onChange={(e) => setForm({ ...form, modelId: e.target.value })}>
          <option value="">Select a model</option>{shown.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}
        </select></label>
        {!shown.length && <p className="text-sm text-gray-400">No models match this search.</p>}
        <p className="text-xs text-gray-400">The selected purpose is verified with a small API request before saving.{form.kind === "embedding" ? " Embedding dimensions are detected automatically." : ""}</p>
        <button type="button" className={button} disabled={Boolean(busy) || !form.id.trim() || !form.provider.trim() || !models.some((m) => m.id === form.modelId)} onClick={save}>{busy === "saving" ? "Testing and saving…" : "Test and save"}</button>
      </div>}
      {initial && <button type="button" className="min-h-11 px-4 text-sm text-gray-300 underline" onClick={onCancel}>Cancel editing</button>}
    </fieldset>
    {error && <p role="alert" className="mt-3 rounded-md border border-rose-900 bg-rose-950/30 p-3 text-sm text-rose-300">{error}</p>}
  </section>;
}
