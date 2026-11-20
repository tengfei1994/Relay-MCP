import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
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
  refresh: () => void;
}

const ProjectScopeContext = createContext<ProjectScopeValue | undefined>(undefined);

function isProject(value: unknown): value is Project {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "number" && typeof candidate.name === "string";
}

export function ProjectScopeProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const requestRef = useRef<Promise<{ projects: unknown[] }> | undefined>(undefined);
  const effectIdRef = useRef(0);
  const [storedId, setProjectIdState] = useState<number>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const [attempt, setAttempt] = useState(0);
  const refresh = useCallback(() => {
    requestRef.current = undefined;
    setLoading(true);
    setError(undefined);
    setAttempt((value) => value + 1);
  }, []);

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
  }, [attempt]);

  const inProjects = location.pathname === "/projects";
  const requestedId = inProjects ? Number(new URLSearchParams(location.search).get("project")) : 0;
  const projectId = projects.some((project) => project.id === requestedId) ? requestedId : storedId;

  useEffect(() => {
    if (!inProjects || !projectId) return;
    if (requestedId !== projectId) {
      const next = new URLSearchParams(location.search);
      next.set("project", String(projectId));
      next.delete("path");
      next.delete("view");
      navigate({ pathname: location.pathname, search: next.toString() }, { replace: true });
      return;
    }
    if (storedId !== projectId) {
      setProjectIdState(projectId);
      localStorage.setItem("knowledge.projectId", String(projectId));
    }
  }, [inProjects, projectId, requestedId, storedId, location.pathname, location.search, navigate]);

  const setProjectId = (nextId: number) => {
    if (!projects.some((project) => project.id === nextId) || nextId === projectId) return;
    if (inProjects) {
      navigate("/projects?project=" + nextId);
      return;
    }
    setProjectIdState(nextId);
    localStorage.setItem("knowledge.projectId", String(nextId));
  };

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === projectId),
    [projects, projectId],
  );
  const value = useMemo(
    () => ({ projects, projectId, selectedProject, setProjectId, loading, error, refresh }),
    [projects, projectId, selectedProject, loading, error, refresh, location.pathname, navigate],
  );

  return <ProjectScopeContext.Provider value={value}>{children}</ProjectScopeContext.Provider>;
}

export function useProjectScope(): ProjectScopeValue {
  const value = useContext(ProjectScopeContext);
  if (!value) throw new Error("useProjectScope must be used inside ProjectScopeProvider");
  return value;
}
