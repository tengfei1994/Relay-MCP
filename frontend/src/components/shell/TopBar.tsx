import { Menu } from "lucide-react";
import { useRelayHealth, healthLabels } from "../../context/RelayHealth";
import { useProjectScope } from "../../context/ProjectScope";
import { Combobox } from "../ui";
import { UserMenu } from "./UserMenu";

export function TopBar({ openNavigation }: { openNavigation: () => void }) {
  const { projects, projectId, setProjectId, loading, error } = useProjectScope();
  const health = useRelayHealth();

  return (
    <header className="shell-topbar">
      <button className="shell-icon-button shell-menu-button" type="button" onClick={openNavigation}
        aria-label="Open navigation" title="Open navigation" aria-haspopup="dialog" aria-controls="shell-mobile-navigation">
        <Menu size={20} aria-hidden="true" />
      </button>
      {projects.length >= 8 ? <div className="shell-project-field shell-project-search">
        <Combobox label="Project" value={String(projectId ?? "")}
          options={projects.map((project) => ({ value: String(project.id), label: project.name }))}
          onChange={(value) => setProjectId(Number(value))} />
      </div> : <label className="shell-project-field">
        <span>Project</span>
        <select aria-label="Project" value={projectId ?? ""} disabled={!projects.length}
          onChange={(event) => setProjectId(Number(event.target.value))}>
          {!projects.length && <option value="">{loading ? "Loading…" : error ? "Unavailable" : "No projects"}</option>}
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </label>}
      <div className="shell-topbar-right">
        <span className="shell-connection-state" data-health={health} role="status" title="Relay API status">
          <i aria-hidden="true" />{healthLabels[health]}
        </span>
        <UserMenu />
      </div>
    </header>
  );
}
export default TopBar;
