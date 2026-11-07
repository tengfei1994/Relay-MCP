import { useEffect, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { api } from "../../api/client";
import { ProjectScopeProvider } from "../../context/ProjectScope";
import { ContextRail } from "./ContextRail";
import { MobileMenu } from "./MobileMenu";
import { SubNav } from "./SubNav";
import { TopBar } from "./TopBar";
import "./shell.css";

type Health = {
  version: string;
  commit: string;
  buildTime: string;
};

function ShellContent() {
  const location = useLocation();
  const [health, setHealth] = useState<Health>();
  const requestRef = useRef<Promise<Health> | undefined>(undefined);
  const inKnowledge = location.pathname.startsWith("/knowledge");

  useEffect(() => {
    let active = true;
    const request = requestRef.current ?? (requestRef.current = api.health());
    request
      .then((response) => {
        if (active) setHealth(response);
      })
      .catch(() => {
        if (active) setHealth(undefined);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">Skip to content</a>
      <TopBar />
      <div className="shell-console-layout">
        <ContextRail />
        <div className="shell-content-column">
          {inKnowledge && <SubNav />}
          <main id="main" tabIndex={-1}>
            <Outlet />
          </main>
          {health && (
            <footer className="shell-footer">
              Web/API build {health.version}, commit {health.commit.slice(0, 12)}, built {health.buildTime}
            </footer>
          )}
        </div>
      </div>
    </div>
  );
}

export function AppShell() {
  return (
    <ProjectScopeProvider>
      <ShellContent />
    </ProjectScopeProvider>
  );
}

export { ContextRail, MobileMenu, SubNav, TopBar };
export default AppShell;
