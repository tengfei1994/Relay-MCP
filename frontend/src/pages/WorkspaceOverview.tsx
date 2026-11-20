import { useEffect, useState } from "react";
import { ArrowRight, File, FolderPlus } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useProjectScope } from "../context/ProjectScope";
import { healthLabels, useRelayHealth } from "../context/RelayHealth";
import { AppPageFrame } from "../components/shell/AppPageFrame";
import { useAuth } from "../App";
import "./workspace-overview.css";

type FileEntry = { name: string; type: string; modifiedAt?: string };

function isFile(value: unknown): value is FileEntry {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return row.type === "file" && typeof row.name === "string";
}

export default function WorkspaceOverview() {
  const { projects, selectedProject, loading, error, refresh } = useProjectScope();
  const { user } = useAuth();
  const health = useRelayHealth();
  const projectId = selectedProject?.id;
  const [serverCount, setServerCount] = useState<number | "unavailable">();
  const [serverAttempt, setServerAttempt] = useState(0);
  const [fileAttempt, setFileAttempt] = useState(0);
  const [fileResult, setFileResult] = useState<{ projectId: number; entries: FileEntry[] | "unavailable" }>();

  useEffect(() => {
    let current = true;
    api.listServers().then(({ servers }) => {
      if (current) setServerCount(servers.length);
    }).catch(() => {
      if (current) setServerCount("unavailable");
    });
    return () => { current = false; };
  }, [serverAttempt]);

  useEffect(() => {
    if (projectId === undefined || loading || error) return;
    let current = true;
    api.listFiles(projectId).then(({ entries }) => {
      if (!current) return;
      const files = entries.filter(isFile).sort((left, right) =>
        String(right.modifiedAt ?? "").localeCompare(String(left.modifiedAt ?? "")));
      setFileResult({ projectId, entries: files.slice(0, 6) });
    }).catch(() => {
      if (current) setFileResult({ projectId, entries: "unavailable" });
    });
    return () => { current = false; };
  }, [projectId, loading, error, fileAttempt]);

  const files = fileResult?.projectId === projectId ? fileResult?.entries : undefined;
  const filesUrl = selectedProject ? "/projects?project=" + selectedProject.id : "/projects";

  return (
    <AppPageFrame className="workspace-home">
      <header className="workspace-home-header">
        <h1>Workspace</h1>
        <Link className="workspace-action-primary" to="/projects?create=1"><FolderPlus size={18} aria-hidden="true" />New project</Link>
      </header>
      <dl className="workspace-home-signals" aria-label="Workspace status">
        <div><dt>Relay API</dt><dd data-health={health}><i aria-hidden="true" />{healthLabels[health]}</dd></div>
        <div><dt>Projects</dt><dd>{loading ? "Loading…" : error ? "Unavailable" : projects.length}</dd></div>
        <div><dt>Configured servers</dt><dd>{serverCount === undefined ? "Loading…" : serverCount === "unavailable" ?
          <button className="workspace-text-action" type="button" onClick={() => { setServerCount(undefined); setServerAttempt((attempt) => attempt + 1); }}>Unavailable · Retry</button> : serverCount}</dd></div>
      </dl>
      {(health === "offline" || health === "degraded") && <p className="workspace-notice" role="status">
        {health === "offline" ? "Relay could not be reached. Check your connection." : "Relay reported an issue. Some operations may fail."} Status is checked automatically.
      </p>}
      <nav className="workspace-home-links" aria-label="Workspace actions">
        <Link to="/jobs">View jobs <ArrowRight size={15} aria-hidden="true" /></Link>
        <Link to="/activity">View activity <ArrowRight size={15} aria-hidden="true" /></Link>
        <Link to="/servers">Manage agents &amp; servers <ArrowRight size={15} aria-hidden="true" /></Link>
        <Link to={user?.isAdmin ? "/admin?view=tokens" : "/tokens"}>Manage tokens <ArrowRight size={15} aria-hidden="true" /></Link>
      </nav>
      <section className="workspace-home-files" aria-labelledby="workspace-files-title">
        <header>
          <h2 id="workspace-files-title">{selectedProject ? "Recent files in " + selectedProject.name : "Project files"}</h2>
          {selectedProject && <Link className="workspace-text-action" to={filesUrl}>Browse files <ArrowRight size={15} aria-hidden="true" /></Link>}
        </header>
        {loading ? <div className="workspace-file-state" role="status">Loading projects…<div className="ui-skeleton mt-2 max-w-64" aria-hidden="true" /></div>
          : error ? <div className="workspace-file-state" role="alert">Could not load projects. <button type="button" className="workspace-text-action" onClick={refresh}>Retry</button></div>
          : !selectedProject ? <p className="workspace-file-state">No projects yet. Create a project to add files.</p>
          : files === undefined ? <div className="workspace-file-state" role="status">Loading project files…<div className="ui-skeleton mt-2 max-w-64" aria-hidden="true" /></div>
          : files === "unavailable" ? <div className="workspace-file-state" role="alert">Could not load project files. <button type="button" className="workspace-text-action" onClick={() => { setFileResult(undefined); setFileAttempt((attempt) => attempt + 1); }}>Retry</button></div>
          : files.length === 0 ? <p className="workspace-file-state">No files in the project root. Browse files to open folders or upload files.</p>
          : <ul aria-label="Recent files in the project root">{files.map((file) => (
            <li key={file.name}><File size={17} aria-hidden="true" /><span>{file.name}</span>
              {file.modifiedAt && <time dateTime={file.modifiedAt}>{new Date(file.modifiedAt).toLocaleString()}</time>}
            </li>
          ))}</ul>}
      </section>
    </AppPageFrame>
  );
}
