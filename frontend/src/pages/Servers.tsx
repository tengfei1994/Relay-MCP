import { useState, useEffect, useRef } from "react";
import { Plus, RefreshCw, Server as ServerIcon, CheckCircle, XCircle, Clock, Copy, Trash2, Key, Pencil, Terminal } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { Button, ConfirmDialog, Dialog, Field, Input, Select, Skeleton, StatusPill } from "../components/ui";
import { AppPageFrame } from "../components/shell/AppPageFrame";

type ServerStatus = "connected" | "failed" | "pending" | string;
type Server = {
  id: number;
  name: string;
  host?: string;
  port?: number;
  sshUser?: string;
  os?: "linux" | "windows" | string;
  connectionMode?: "ssh" | "agent" | string;
  agentId?: string;
  heartbeat?: string;
  lastSeenAt?: string;
  status: ServerStatus;
};
type ServerFormKey = "name" | "host" | "port" | "sshUser" | "os" | "password" | "connectionMode" | "agentId";
type EditFormKey = Exclude<ServerFormKey, "password">;
type ServerForm = Record<ServerFormKey, string>;
type EditForm = Record<EditFormKey, string>;
type TerminalLine = { type: "log" | "success" | "error"; message: string };
type ConfirmState = { kind: "server"; id: number } | null;
function messageFrom(error: unknown): string { return error instanceof Error ? error.message : "Request failed"; }
function present<T>(value: T | null): value is T {
  return value !== null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function serverFrom(value: unknown): Server | null {
  if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "number" || !("name" in value) || typeof value.name !== "string" || !("status" in value) || typeof value.status !== "string") return null;
  const record = value as Record<string, unknown>;
  return {
    id: value.id,
    name: value.name,
    host: optionalString(record.host),
    port: typeof record.port === "number" ? record.port : undefined,
    sshUser: optionalString(record.sshUser),
    os: optionalString(record.os),
    connectionMode: optionalString(record.connectionMode),
    agentId: optionalString(record.agentId),
    heartbeat: optionalString(record.heartbeat),
    lastSeenAt: optionalString(record.lastSeenAt),
    status: value.status,
  };
}

function serversFrom(value: unknown): Server[] {
  return typeof value === "object" && value !== null && "servers" in value && Array.isArray(value.servers) ? value.servers.map(serverFrom).filter(present) : [];
}

function addedServerFrom(value: unknown): { server: Server; publicKey: string } | null {
  if (typeof value !== "object" || value === null || !("server" in value)) return null;
  const server = serverFrom(value.server);
  if (!server) return null;
  return { server, publicKey: "publicKey" in value && typeof value.publicKey === "string" ? value.publicKey : "" };
}

const STATUS_ICON: Record<string, JSX.Element> = {
  connected: <CheckCircle size={13} className="text-mint" />,
  failed: <XCircle size={13} className="text-coral" />,
  pending: <Clock size={13} className="text-sun" />,
};

function heartbeatAge(value: string) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
  if (!Number.isFinite(seconds)) return "Unknown heartbeat time";
  if (seconds < 60) return seconds + " s ago";
  if (seconds < 3600) return Math.floor(seconds / 60) + " min ago";
  if (seconds < 86400) return Math.floor(seconds / 3600) + " h ago";
  return Math.floor(seconds / 86400) + " d ago";
}

export default function ServersPage() {
  const [servers, setServers] = useState<Server[]>([]);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newServer, setNewServer] = useState<ServerForm>({ name: "", host: "", port: "22", sshUser: "root", os: "linux", password: "", connectionMode: "ssh", agentId: "" });
  const [addedKey, setAddedKey] = useState<{ id: number; key: string } | null>(null);
  const [editServer, setEditServer] = useState<Server | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({ name: "", host: "", port: "22", sshUser: "", os: "linux", connectionMode: "ssh", agentId: "" });
  const [error, setError] = useState("");
  const [listError, setListError] = useState(false);
  const [loadingServers, setLoadingServers] = useState(true);
  const [serverAttempt, setServerAttempt] = useState(0);

  // Terminal modal
  const [terminal, setTerminal] = useState<{ serverId: number; password: string } | null>(null);
  const [termLines, setTermLines] = useState<TerminalLine[]>([]);
  const [termRunning, setTermRunning] = useState(false);
  const termRef = useRef<HTMLDivElement>(null);

  // Password confirmation before pushing an SSH key
  const [setupTarget, setSetupTarget] = useState<Server | null>(null);
  const [setupPassword, setSetupPassword] = useState("");
  const [setupError, setSetupError] = useState("");
  const [setupLoading, setSetupLoading] = useState(false);

  useEffect(() => {
    let active = true;
    let next: number | undefined;
    async function updateList() {
      try {
        const result = await api.listServers();
        if (!active) return;
        setServers(serversFrom(result));
        setListError(false);
      } catch {
        if (active) setListError(true);
      } finally {
        if (active) {
          setLoadingServers(false);
          next = window.setTimeout(updateList, 30000);
        }
      }
    }
    void updateList();
    return () => { active = false; window.clearTimeout(next); };
  }, [serverAttempt]);

  // Auto-scroll terminal
  useEffect(() => {
    if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight;
  }, [termLines]);

  // Start setup stream when terminal modal opens
  useEffect(() => {
    if (!terminal) return;
    setTermLines([]);
    setTermRunning(true);
    api
      .setupServer(terminal.serverId, terminal.password, (type, message) => {
        setTermLines((l) => [...l, { type, message }]);
      })
      .then(() => {
        setTermRunning(false);
        // Refresh server status
        api.listServers().then((r) => setServers(serversFrom(r)));
      })
      .catch((err: unknown) => {
        setTermLines((l) => [...l, { type: "error", message: messageFrom(err) }]);
        setTermRunning(false);
      });
  }, [terminal]);

  const addServer = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const r = await api.addServer({
        name: newServer.name,
        host: newServer.host,
        port: Number(newServer.port),
        sshUser: newServer.sshUser,
        os: newServer.os as "linux" | "windows",
        connectionMode: newServer.connectionMode as "ssh" | "agent",
        agentId: newServer.agentId,
      });
      const added = addedServerFrom(r);
      if (!added) throw new Error("The server returned an invalid server.");
      setServers((s) => [...s, added.server]);
      setShowAdd(false);
      const pwd = newServer.password.trim();
      setNewServer({ name: "", host: "", port: "22", sshUser: "root", os: "linux", password: "", connectionMode: "ssh", agentId: "" });

      if (newServer.connectionMode === "ssh" && pwd) {
        // Auto-launch terminal setup
        setTerminal({ serverId: added.server.id, password: pwd });
      } else if (newServer.connectionMode === "ssh") {
        // Show public key for manual copy
        setAddedKey({ id: added.server.id, key: added.publicKey });
      }
    } catch (err: unknown) {
      setError(messageFrom(err));
    }
  };

  const openSetup = (s: Server) => {
    setSetupTarget(s);
    setSetupPassword("");
    setSetupError("");
  };

  const startSetup = () => {
    if (!setupTarget) return;
    const password = setupPassword.trim();
    if (!password) {
      setSetupError("Enter the SSH password to continue.");
      return;
    }
    setSetupError("");
    setSetupLoading(true);
    setTerminal({ serverId: setupTarget.id, password });
    setSetupTarget(null);
    setSetupPassword("");
    setSetupLoading(false);
  };

  const openEdit = (s: Server) => {
    setEditServer(s);
    setEditForm({ name: s.name, host: s.host ?? "", port: String(s.port ?? 22), sshUser: s.sshUser ?? "", os: s.os ?? "linux", connectionMode: s.connectionMode ?? "ssh", agentId: s.agentId ?? "" });
    setError("");
  };

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editServer) return;
    const serverId = editServer.id;
    setError("");
    try {
      const r = await api.updateServer(serverId, {
        name: editForm.name,
        host: editForm.host,
        port: Number(editForm.port),
        sshUser: editForm.sshUser,
        os: editForm.os as "linux" | "windows",
        connectionMode: editForm.connectionMode as "ssh" | "agent",
        agentId: editForm.agentId,
      });
      const server = serverFrom(typeof r === "object" && r !== null && "server" in r ? r.server : null);
      if (!server) throw new Error("The server returned an invalid server.");
      setServers((s) => s.map((sv) => (sv.id === serverId ? server : sv)));
      setServerAttempt((attempt) => attempt + 1);
      setEditServer(null);
    } catch (err: unknown) {
      setError(messageFrom(err));
    }
  };

  const testLocks = useRef(new Set<number>());
  const [sshTests, setSshTests] = useState<Record<number, { pending: boolean; at?: string; error?: string }>>({});
  const testServer = async (id: number) => {
    if (testLocks.current.has(id)) return;
    testLocks.current.add(id);
    setSshTests((tests) => ({ ...tests, [id]: { pending: true } }));
    let failure: string | undefined;
    try {
      const result = await api.testServer(id);
      if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true) {
        failure = result && typeof result === "object" && "error" in result && typeof result.error === "string"
          ? result.error : "SSH test failed.";
      }
      setServers((items) => items.map((item) => item.id === id ? { ...item, status: failure ? "failed" : "connected" } : item));
    } catch (reason) { failure = messageFrom(reason); }
    finally {
      testLocks.current.delete(id);
      setSshTests((tests) => ({ ...tests, [id]: { pending: false, at: new Date().toISOString(), error: failure } }));
    }
  };

  const deleteServer = async (id: number) => {
    setConfirm({ kind: "server", id });
  };

  const confirmDeleteServer = async () => {
    if (!confirm || confirm.kind !== "server") return;
    await api.deleteServer(confirm.id);
    setServers((s) => s.filter((sv) => sv.id !== confirm.id));
    setConfirm(null);
  };



  const isAgentServer = (server: Server) => server.connectionMode === "agent";

  return (
    <AppPageFrame>
      <div className="runtime-page-head">
        <div>
          <h1 className="text-2xl font-semibold">Agents &amp; servers</h1>
          {!loadingServers && !listError && <p className="runtime-page-summary">{servers.length ? servers.length + " configured" : "No servers added yet."}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" loading={loadingServers} onClick={() => { setLoadingServers(true); setServerAttempt((attempt) => attempt + 1); }}><RefreshCw size={15} aria-hidden="true" />Refresh</Button>
        <Button variant="primary" onClick={() => setShowAdd(true)}><Plus size={14} /> Add server</Button></div>
      </div>

      {listError && <p className="mb-4 rounded-field border border-coral/40 bg-coral/10 p-3 text-sm text-coral" role="alert">Could not refresh servers. Use Refresh to try again.</p>}
      {loadingServers && !servers.length && <div role="status" aria-label="Loading servers"><Skeleton className="h-16 w-full" /></div>}
      {servers.length > 0 && <div className="space-y-3">
        {servers.map((s) => (
          <div key={s.id} className="glass flex flex-wrap items-center justify-between gap-4 rounded-panel px-5 py-4">
            <div className="flex min-w-0 items-center gap-3">
              <ServerIcon size={16} className="text-muted" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-fg">{s.name}</p>
                <p className="truncate text-xs text-muted" title={(s.connectionMode ?? "ssh") === "agent" ? `agent: ${s.agentId ?? "-"}` : `${s.sshUser}@${s.host}:${s.port}`}>
                  {(s.connectionMode ?? "ssh") === "agent"
                    ? `agent: ${s.agentId ?? "-"}`
                    : `${s.sshUser}@${s.host}:${s.port}`}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-3">
              {isAgentServer(s) ? (
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <StatusPill status={listError ? "Agent status unavailable" : s.heartbeat === "never_seen" ? "Agent never connected" : s.heartbeat === "online" ? "Agent online" : s.heartbeat === "offline" ? "Agent offline" : "Agent status unavailable"}
                    tone={listError ? "neutral" : s.heartbeat === "online" ? "ok" : s.heartbeat === "offline" ? "warn" : "neutral"} />
                  {s.lastSeenAt && <time dateTime={s.lastSeenAt} title={new Date(s.lastSeenAt).toLocaleString()}>Heartbeat {heartbeatAge(s.lastSeenAt)}</time>}
                  {!listError && s.heartbeat !== "online" && <Link className="inline-flex min-h-10 items-center font-medium text-mint hover:underline" to="/tokens/agents">Agent tokens</Link>}
                </div>
              ) : <div className="flex items-center gap-1 text-xs text-muted">
                {STATUS_ICON[s.status] ?? STATUS_ICON.pending}
                {s.status}
              </div>}
              {(s.connectionMode ?? "ssh") === "ssh" && (
                <button
                  type="button"
                  onClick={() => openSetup(s)}
                  className="text-muted transition-colors hover:text-sun"
                  title="Push key and set up"
                  aria-label={`Push key and set up ${s.name}`}
                >
                  <Key size={14} />
                </button>
              )}
              {!isAgentServer(s) && <div className="flex flex-wrap items-center gap-2">
                <Button variant="ghost" size="sm" loading={sshTests[s.id]?.pending} onClick={() => void testServer(s.id)}>
                  {sshTests[s.id]?.pending ? "Testing" : sshTests[s.id]?.error ? "Retry SSH" : "Test SSH"}
                </Button>
                {sshTests[s.id]?.error && <Button variant="ghost" size="sm" onClick={() => openEdit(s)}>Edit connection</Button>}
                {sshTests[s.id]?.at && <time className="text-xs text-muted" dateTime={sshTests[s.id].at}>{new Date(sshTests[s.id].at!).toLocaleTimeString()}</time>}
                {sshTests[s.id]?.error && <p className="w-full break-words text-sm text-coral" role="alert">{sshTests[s.id]?.error}</p>}
              </div>}
              <button
                type="button"
                onClick={() => openEdit(s)}
                className="text-muted transition-colors hover:text-mint"
                title="Edit"
                aria-label={`Edit ${s.name}`}
              >
                <Pencil size={14} />
              </button>
              <button
                type="button"
                onClick={() => deleteServer(s.id)}
                className="text-muted transition-colors hover:text-coral"
                aria-label={`Delete ${s.name}`}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>}

      <Dialog
        open={showAdd}
        onClose={() => setShowAdd(false)}
        title="Add server"
        description="Connect a remote host or relay agent."
        footer={
          <>
            <Button type="button" variant="ghost" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button type="submit" form="add-server-form">
              {newServer.connectionMode === "agent" ? "Add agent server" : newServer.password ? "Add and set up" : "Generate SSH key and add"}
            </Button>
          </>
        }
      >
        <form id="add-server-form" onSubmit={addServer} className="space-y-3">
          <Field label="Name" required>
            <Input value={newServer.name} onChange={(e) => setNewServer((s) => ({ ...s, name: e.target.value }))} placeholder="my-prod-server" required />
          </Field>
          <Field label="Connection">
            <div role="group" aria-label="Connection" className="flex flex-wrap gap-2">
              {(["ssh", "agent"] as const).map((mode) => <Button key={mode} type="button"
                variant={newServer.connectionMode === mode ? "primary" : "ghost"}
                aria-pressed={newServer.connectionMode === mode} onClick={() => setNewServer((s) => ({ ...s, connectionMode: mode }))}>{mode === "ssh" ? "SSH" : "Relay agent"}</Button>)}
            </div>
          </Field>
          {newServer.connectionMode === "ssh" ? (
            <>
              <Field label="Host" required>
                <Input value={newServer.host} onChange={(e) => setNewServer((s) => ({ ...s, host: e.target.value }))} placeholder="192.168.1.100" required />
              </Field>
              <Field label="Port">
                <Input value={newServer.port} onChange={(e) => setNewServer((s) => ({ ...s, port: e.target.value }))} placeholder="22" inputMode="numeric" />
              </Field>
              <Field label="SSH user">
                <Input value={newServer.sshUser} onChange={(e) => setNewServer((s) => ({ ...s, sshUser: e.target.value }))} placeholder="root" />
              </Field>
            </>
          ) : (
            <Field label="Agent ID" required hint="Choose an ID now and use the same ID in the Relay Agent client. The agent does not need to be connected to add this server.">
              <Input value={newServer.agentId} onChange={(e) => setNewServer((s) => ({ ...s, agentId: e.target.value }))} placeholder="VGSM-SERVER" required />
            </Field>
          )}
          <Field label="Operating system">
            <Select value={newServer.os} onChange={(e) => setNewServer((s) => ({ ...s, os: e.target.value }))}>
              <option value="linux">Linux / Unix</option>
              <option value="windows">Windows</option>
            </Select>
          </Field>
          {newServer.connectionMode === "ssh" && (
            <Field label="SSH password" hint="Optional; used to push the key automatically.">
              <Input type="password" value={newServer.password} onChange={(e) => setNewServer((s) => ({ ...s, password: e.target.value }))} placeholder="Leave blank to copy the key manually" />
            </Field>
          )}
          {error && <p className="text-sm text-coral" role="alert">{error}</p>}
        </form>
      </Dialog>

      <Dialog
        open={editServer !== null}
        onClose={() => { setEditServer(null); setError(""); }}
        title="Edit server"
        description="Update the connection details for this server."
        footer={
          <>
            <Button type="button" variant="ghost" onClick={() => { setEditServer(null); setError(""); }}>Cancel</Button>
            <Button type="submit" form="edit-server-form">Save</Button>
          </>
        }
      >
        <form id="edit-server-form" onSubmit={saveEdit} className="space-y-3">
          <Field label="Name" required>
            <Input value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} required />
          </Field>
          <Field label="Connection">
            <div role="group" aria-label="Connection" className="flex flex-wrap gap-2">
              {(["ssh", "agent"] as const).map((mode) => <Button key={mode} type="button"
                variant={editForm.connectionMode === mode ? "primary" : "ghost"}
                aria-pressed={editForm.connectionMode === mode} onClick={() => setEditForm((f) => ({ ...f, connectionMode: mode }))}>{mode === "ssh" ? "SSH" : "Relay agent"}</Button>)}
            </div>
          </Field>
          {editForm.connectionMode === "ssh" ? (
            <>
              <Field label="Host" required>
                <Input value={editForm.host} onChange={(e) => setEditForm((f) => ({ ...f, host: e.target.value }))} required />
              </Field>
              <Field label="Port">
                <Input value={editForm.port} onChange={(e) => setEditForm((f) => ({ ...f, port: e.target.value }))} inputMode="numeric" />
              </Field>
              <Field label="SSH user">
                <Input value={editForm.sshUser} onChange={(e) => setEditForm((f) => ({ ...f, sshUser: e.target.value }))} />
              </Field>
            </>
          ) : (
            <Field label="Agent ID" required>
              <Input value={editForm.agentId} onChange={(e) => setEditForm((f) => ({ ...f, agentId: e.target.value }))} required />
            </Field>
          )}
          <Field label="Operating system">
            <Select value={editForm.os} onChange={(e) => setEditForm((f) => ({ ...f, os: e.target.value }))}>
              <option value="linux">Linux / Unix</option>
              <option value="windows">Windows</option>
            </Select>
          </Field>
          {error && <p className="text-sm text-coral" role="alert">{error}</p>}
          <p className="text-sm text-sun">Changing host or user will reset status to pending.</p>
        </form>
      </Dialog>

      <Dialog
        open={setupTarget !== null}
        onClose={() => {
          if (setupLoading) return;
          setSetupTarget(null);
          setSetupPassword("");
          setSetupError("");
        }}
        title="Set up SSH access"
        description={setupTarget ? `Enter the SSH password for ${setupTarget.sshUser}@${setupTarget.host}.` : "Enter the SSH password to push the key."}
        busy={setupLoading}
        footer={
          <>
            <Button
              type="button"
              variant="ghost"
              disabled={setupLoading}
              onClick={() => {
                setSetupTarget(null);
                setSetupPassword("");
                setSetupError("");
              }}
            >
              Cancel
            </Button>
            <Button type="button" onClick={startSetup} loading={setupLoading}>
              Push key and set up
            </Button>
          </>
        }
      >
        <Field label="SSH password" required>
          <Input
            type="password"
            autoFocus
            value={setupPassword}
            onChange={(event) => {
              setSetupPassword(event.target.value);
              if (setupError) setSetupError("");
            }}
            placeholder="Enter password"
            required
          />
        </Field>
        {setupError && <p className="mt-3 text-sm text-coral" role="alert">{setupError}</p>}
      </Dialog>

      <Dialog
        open={addedKey !== null}
        onClose={() => setAddedKey(null)}
        title="SSH key generated"
        description="Add this public key to the server's ~/.ssh/authorized_keys file."
        footer={<Button onClick={() => setAddedKey(null)}>Done</Button>}
        wide
      >
        {addedKey && (
          <div className="relative">
            <pre className="rounded-field border border-line bg-field p-3 font-mono text-xs text-mint break-all whitespace-pre-wrap">{addedKey.key}</pre>
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(addedKey.key)}
              className="absolute right-2 top-2 text-muted hover:text-fg"
              aria-label="Copy public key"
            >
              <Copy size={13} />
            </button>
          </div>
        )}
      </Dialog>

      <Dialog
        open={terminal !== null}
        onClose={() => setTerminal(null)}
        title="Server setup"
        description={termRunning ? "Setup is running…" : "Setup output"}
        wide
        busy={termRunning}
        footer={<Button variant="ghost" disabled={termRunning} onClick={() => setTerminal(null)}>{termRunning ? "Running…" : "Close"}</Button>}
      >
        <div ref={termRef} className="max-h-80 overflow-y-auto rounded-field border border-line bg-[var(--bg-0)] p-4 font-mono text-xs space-y-1">
          {termLines.map((l, i) => (
            <div key={i} className={l.type === "success" ? "text-mint" : l.type === "error" ? "text-coral" : "text-fg"}>
              <span className="mr-2 select-none text-muted">{l.type === "success" ? "✓" : l.type === "error" ? "✗" : "›"}</span>
              {l.message}
            </div>
          ))}
          {termRunning && <div className="animate-pulse text-muted">█</div>}
        </div>
      </Dialog>
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title="Delete server?"
        description="This removes the server connection and cannot be undone."
        confirmLabel="Delete server"
        tone="danger"
        onConfirm={confirmDeleteServer}
      />
    </AppPageFrame>
  );
}
