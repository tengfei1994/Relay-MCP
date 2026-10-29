import { useState, useEffect, useRef } from "react";
import { Plus, Server as ServerIcon, CheckCircle, XCircle, Clock, Copy, Trash2, Key, Pencil, Terminal } from "lucide-react";
import { api } from "../api/client";
import { Button, ConfirmDialog, Dialog, Field, Input, Select } from "../components/ui";

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

export default function ServersPage() {
  const [servers, setServers] = useState<Server[]>([]);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newServer, setNewServer] = useState<ServerForm>({ name: "", host: "", port: "22", sshUser: "root", os: "linux", password: "", connectionMode: "ssh", agentId: "" });
  const [addedKey, setAddedKey] = useState<{ id: number; key: string } | null>(null);
  const [editServer, setEditServer] = useState<Server | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({ name: "", host: "", port: "22", sshUser: "", os: "linux", connectionMode: "ssh", agentId: "" });
  const [error, setError] = useState("");

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
    api.listServers().then((r) => setServers(serversFrom(r)));
  }, []);

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
      setEditServer(null);
    } catch (err: unknown) {
      setError(messageFrom(err));
    }
  };

  const testServer = async (id: number) => {
    const r = await api.testServer(id);
    const ok = typeof r === "object" && r !== null && "ok" in r && r.ok === true;
    setServers((s) =>
      s.map((sv) => (sv.id === id ? { ...sv, status: ok ? "connected" : "failed" } : sv))
    );
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



  return (
    <div className="page max-w-3xl">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="font-display text-[30px] font-semibold tracking-[-0.02em] text-fg">Servers</h1>
          <p className="mt-2 max-w-[60ch] text-sm text-muted">Manage remote hosts and relay agents.</p>
        </div>
        <Button variant="primary" onClick={() => setShowAdd(true)}>
          <Plus size={14} />
          Add server
        </Button>
      </div>

      <div className="space-y-3">
        {servers.map((s) => (
          <div key={s.id} className="glass flex items-center justify-between rounded-panel px-5 py-4">
            <div className="flex items-center gap-3">
              <ServerIcon size={16} className="text-muted" />
              <div>
                <p className="text-sm font-medium text-fg">{s.name}</p>
                <p className="text-xs text-muted">
                  {(s.connectionMode ?? "ssh") === "agent"
                    ? `agent: ${s.agentId ?? "-"}`
                    : `${s.sshUser}@${s.host}:${s.port}`}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1 text-xs text-muted">
                {STATUS_ICON[s.status] ?? STATUS_ICON.pending}
                {s.status}
              </div>
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
              <Button variant="ghost" size="sm" onClick={() => testServer(s.id)}>Test</Button>
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
        {servers.length === 0 && <p className="text-sm text-muted">No servers added yet.</p>}
      </div>

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
            <Select value={newServer.connectionMode} onChange={(e) => setNewServer((s) => ({ ...s, connectionMode: e.target.value }))}>
              <option value="ssh">SSH</option>
              <option value="agent">Relay agent</option>
            </Select>
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
            <Field label="Agent ID" required>
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
            <Select value={editForm.connectionMode} onChange={(e) => setEditForm((f) => ({ ...f, connectionMode: e.target.value }))}>
              <option value="ssh">SSH</option>
              <option value="agent">Relay agent</option>
            </Select>
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
        <div ref={termRef} className="max-h-80 overflow-y-auto rounded-field border border-line bg-[#071418] p-4 font-mono text-xs space-y-1">
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
    </div>
  );
}
