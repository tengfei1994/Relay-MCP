import { NavLink, useLocation } from "react-router-dom";
import { Activity, BookOpen, Box, Database, FileText, KeyRound, ListChecks, Settings2, ShieldCheck, Users, Wrench } from "lucide-react";
import { useAuth } from "../../App";
import { useProjectScope } from "../../context/ProjectScope";
import { knowledgeNavigation, matchesPath } from "./navigation";
import type { PageTab } from "./PageTabs";

const iconByLabel: Record<string, typeof Activity> = {
  Overview: BookOpen,
  "Control plane": Settings2,
  Wiki: FileText,
  "Product docs": FileText,
  Solutions: Wrench,
  Memory: Database,
  Playbooks: ListChecks,
  Operations: Activity,
  Workspace: BookOpen,
  Sessions: Activity,
  Evidence: FileText,
  Observations: Activity,
  "Candidate insights": ListChecks,
  "Confirmed memory": ShieldCheck,
  Submissions: ListChecks,
  Documents: FileText,
  Topics: ListChecks,
  Imports: Box,
  "Versions and diffs": Activity,
  Search: Wrench,
  Capture: Activity,
  Ingest: Box,
  "Index and providers": Database,
  "Wiki generation": Wrench,
  "MCP Access Tokens": KeyRound,
  "Relay Agent Tokens": KeyRound,
  Users,
  "Access requests": Users,
  "Knowledge permissions": ShieldCheck,
  Projects: Box,
  Activity,
  "Knowledge review": ShieldCheck,
  "Audit and release": FileText,
  Providers: Settings2,
  "Release gates": ShieldCheck,
};

function iconFor(label: string) {
  const Icon = iconByLabel[label] ?? Activity;
  return <Icon size={15} aria-hidden="true" />;
}

function tabActive(tab: PageTab, pathname: string) {
  return tab.matches?.(pathname) ?? matchesPath(pathname, tab.path, tab.end);
}

function contextFor(pathname: string, isAdmin: boolean): { label: string; items: readonly PageTab[]; note?: string } {
  if (["/workspace", "/projects", "/activity"].includes(pathname)) {
    return { label: "Selected workspace", items: [{ label: "Overview", path: "/workspace", end: true }, { label: "Projects", path: "/projects", end: true }, { label: "Activity", path: "/activity", end: true }] };
  }
  if (pathname === "/admin" && isAdmin) {
    return { label: "Relay control plane", items: [{ label: "Access requests", path: "/users/requests", end: true }, { label: "Knowledge review", path: "/knowledge/memory", end: true }, { label: "Audit and release", path: "/knowledge/integrated/gates", end: true }] };
  }
  if (pathname.startsWith("/knowledge")) {
    return { label: "Knowledge", items: knowledgeNavigation as unknown as readonly PageTab[] };
  }
  if (pathname.startsWith("/tokens")) {
    return { label: "Access", items: [{ label: "MCP Access Tokens", path: "/tokens", end: true }, { label: "Relay Agent Tokens", path: "/tokens/agents", end: true }] };
  }
  if (pathname.startsWith("/users") && isAdmin) {
    return { label: "Administrator", items: [{ label: "Users", path: "/users", end: true }, { label: "Access requests", path: "/users/requests", end: true }, { label: "Knowledge permissions", path: "/users/permissions", end: true }] };
  }
  if (pathname === "/account") return { label: "Account", items: [] };
  if (["/servers", "/instances", "/tools"].includes(pathname)) return { label: "Runtime", items: [] };
  return { label: "Workspace", items: [] };
}

export function ContextRail() {
  const location = useLocation();
  const { user } = useAuth();
  const { selectedProject, loading: projectLoading } = useProjectScope();
  const context = contextFor(location.pathname, Boolean(user?.isAdmin));
  const projectName = selectedProject?.name ?? (projectLoading ? "Loading project…" : "No project selected");
  const heading = context.label === "Selected workspace" || context.label === "Knowledge" ? projectName : context.label === "Relay control plane" ? "Admin overview" : context.label;

  if (context.items.length === 0 && !context.note) return null;

  return (
    <aside className="shell-context-rail" aria-label={`${context.label} navigation`}>
      <div className="shell-context-heading">
        <span>{context.label}</span>
        {heading && heading !== context.label ? <strong>{heading}</strong> : null}
      </div>
      {context.items.length > 0 ? (
        <nav className="shell-context-nav" aria-label={`${context.label} sections`}>
          {context.items.map((item) => {
            const active = tabActive(item, location.pathname);
            return (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.end}
                className={`shell-context-link${active ? " active" : ""}`}
                aria-current={active ? "page" : undefined}
              >
                <span>{iconFor(item.label)}{item.label}</span>
                {item.adminOnly ? <small>admin</small> : null}
              </NavLink>
            );
          })}
        </nav>
      ) : context.note ? (
        <div className="shell-context-note">
          <span>Context</span>
          <p>{context.note}</p>
        </div>
      ) : null}
      <div className="shell-context-footer">
        <div><span>Relay API</span><i aria-label="Connected" /></div>
        <div><span>scope</span><code>{selectedProject ? `project: ${selectedProject.name}` : "account"}</code></div>
      </div>
    </aside>
  );
}

export default ContextRail;
