import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useProjectScope } from "../../context/ProjectScope";

export function ScopeChip() {
  const { projects, selectedProject, projectId, setProjectId, loading } = useProjectScope();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [open]);

  const label = loading ? "Loading…" : selectedProject?.name ?? "No project";
  return (
    <div ref={containerRef} className="shell-scope-wrap">
      <button
        type="button"
        className="shell-scope-trigger"
        aria-label="Choose project scope"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="shell-scope-name">Project: {label}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="shell-scope-list" role="menu" aria-label="Project scope">
          {projects.length === 0 ? (
            <p className="shell-popover-item">No projects available</p>
          ) : (
            projects.map((project) => {
              const selected = project.id === projectId;
              return (
                <button
                  key={project.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  aria-current={selected ? "true" : undefined}
                  className="shell-scope-option"
                  onClick={() => {
                    setProjectId(project.id);
                    setOpen(false);
                  }}
                >
                  <span>{project.name}</span>
                  {selected && <Check size={15} aria-hidden="true" />}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
export default ScopeChip;
