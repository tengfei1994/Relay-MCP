import { Suspense, useEffect, useRef, useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { useAuth } from "../../App";
import { ProjectScopeProvider } from "../../context/ProjectScope";
import { RelayHealthProvider } from "../../context/RelayHealth";
import { ContextRail } from "./ContextRail";
import { KnowledgeSectionNav } from "./KnowledgeSectionNav";
import { TopBar } from "./TopBar";
import { primaryNavigation, matchesPath } from "./navigation";
import "./shell.css";

function SidebarLinks({ onNavigate }: { onNavigate?: () => void }) {
  const { user } = useAuth();
  const { pathname } = useLocation();

  return (
    <>
      <nav className="shell-primary-nav" aria-label="Primary navigation">
        {primaryNavigation.filter((item) => (!item.adminOnly || user?.isAdmin) && (!item.userOnly || !user?.isAdmin)).map(({ label, path, icon: Icon }) => (
          <Link key={path} to={path} onClick={onNavigate} title={label} className="shell-primary-link"
            aria-current={matchesPath(pathname, path) ? "page" : undefined}>
            <Icon size={18} aria-hidden="true" /><span>{label}</span>
          </Link>
        ))}
      </nav>
      <ContextRail onNavigate={onNavigate} />
    </>
  );
}

function ShellContent() {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const drawer = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const openDrawer = () => {
    drawer.current?.showModal();
    closeButton.current?.focus();
  };
  const closeDrawer = () => drawer.current?.close();

  useEffect(() => {
    closeDrawer();
  }, [location.pathname, location.search]);

  useEffect(() => {
    const wide = matchMedia("(min-width: 761px)");
    const closeOnDesktop = () => { if (wide.matches) closeDrawer(); };
    wide.addEventListener("change", closeOnDesktop);
    return () => wide.removeEventListener("change", closeOnDesktop);
  }, []);

  return (
    <div className={collapsed ? "app-shell shell-collapsed" : "app-shell"}>
      <a className="skip-link" href="#main">Skip to content</a>
      <aside className="shell-sidebar" aria-label="Console navigation">
        <div className="shell-sidebar-heading">
          <Link className="shell-brand" to="/workspace" aria-label="Relay MCP workspace"><img src="/relay-mcp-logo.svg" alt="" /><span>Relay MCP</span></Link>
          <button className="shell-icon-button shell-collapse-button" type="button" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
            {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
        </div>
        <SidebarLinks />
      </aside>
      <div className="shell-content-column">
        <TopBar openNavigation={openDrawer} />
        {matchesPath(location.pathname, "/knowledge") && <KnowledgeSectionNav />}
        <main id="main" tabIndex={-1}>
          <Suspense fallback={<p className="p-5 text-muted" role="status">Loading page…</p>}><Outlet /></Suspense>
        </main>
      </div>
      <dialog id="shell-mobile-navigation" ref={drawer} className="shell-mobile-panel" aria-label="Console navigation" onClick={(event) => {
        if (event.target === event.currentTarget) closeDrawer();
      }}>
        <div className="shell-mobile-inner">
          <div className="shell-sidebar-heading">
            <Link className="shell-brand" to="/workspace" onClick={closeDrawer}><img src="/relay-mcp-logo.svg" alt="" /><span>Relay MCP</span></Link>
            <button type="button" className="shell-icon-button" ref={closeButton} onClick={closeDrawer} aria-label="Close navigation" title="Close navigation"><X size={20} /></button>
          </div>
          <SidebarLinks onNavigate={closeDrawer} />
        </div>
      </dialog>
    </div>
  );
}

export function AppShell() {
  return <ProjectScopeProvider><RelayHealthProvider><ShellContent /></RelayHealthProvider></ProjectScopeProvider>;
}

export default AppShell;
