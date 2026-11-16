import { Outlet, useLocation } from "react-router-dom";
import { ProjectScopeProvider } from "../../context/ProjectScope";
import { ContextRail } from "./ContextRail";
import { MobileMenu } from "./MobileMenu";
import { SubNav } from "./SubNav";
import { TopBar } from "./TopBar";
import "./shell.css";

function ShellContent() {
  const location = useLocation();
  const inKnowledge = location.pathname.startsWith("/knowledge");

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
