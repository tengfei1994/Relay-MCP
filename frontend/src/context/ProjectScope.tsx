import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api/client";

export interface Project {
  id: number;
  name: string;
  description?: string;
}

interface ProjectScopeValue {
  projects: Project[];
  projectId: number | undefined;
  selectedProject: Project | undefined;
  setProjectId: (projectId: number) => void;
  loading: boolean;
  error: string | undefined;
}

const ProjectScopeContext = createContext<ProjectScopeValue | undefined>(undefined);

function isProject(value: unknown): value is Project {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "number" && typeof candidate.name === "string";
}

export function ProjectScopeProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const requestRef = useRef<Promise<{ projects: unknown[] }> | undefined>(undefined);
  const effectIdRef = useRef(0);
  const [projectId, setProjectIdState] = useState<number>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const effectId = ++effectIdRef.current;
    const request = requestRef.current ?? (requestRef.current = api.listProjects());
    request
      .then((response) => {
        if (effectIdRef.current !== effectId) return;
        const available = response.projects.filter(isProject);
        const stored = Number(localStorage.getItem("knowledge.projectId"));
        const storedProject = Number.isFinite(stored) ? available.find((project) => project.id === stored) : undefined;
        const selected = storedProject ?? available[0];
        setProjects(available);
        setProjectIdState(selected?.id);
        if (selected) localStorage.setItem("knowledge.projectId", String(selected.id));
      })
      .catch((reason: unknown) => {
        if (effectIdRef.current !== effectId) return;
        setError(reason instanceof Error ? reason.message : "Unable to load projects");
      })
      .finally(() => {
        if (effectIdRef.current === effectId) setLoading(false);
      });
    return () => {
      if (effectIdRef.current === effectId) effectIdRef.current += 1;
    };
  }, []);

  const setProjectId = (nextId: number) => {
    if (!projects.some((project) => project.id === nextId)) return;
    setProjectIdState(nextId);
    localStorage.setItem("knowledge.projectId", String(nextId));
  };

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === projectId),
    [projects, projectId],
  );
  const value = useMemo(
    () => ({ projects, projectId, selectedProject, setProjectId, loading, error }),
    [projects, projectId, selectedProject, loading, error],
  );

  return <ProjectScopeContext.Provider value={value}>{children}</ProjectScopeContext.Provider>;
}

export function useProjectScope(): ProjectScopeValue {
  const value = useContext(ProjectScopeContext);
  if (!value) throw new Error("useProjectScope must be used inside ProjectScopeProvider");
  return value;
}
