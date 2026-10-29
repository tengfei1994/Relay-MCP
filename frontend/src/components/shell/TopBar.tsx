import { Menu, X } from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import { useAuth } from "../../App";
import { MobileMenu } from "./MobileMenu";
import { UserMenu } from "./UserMenu";
import { primaryNavigation, matchesPath } from "./navigation";

export function TopBar() {
  const { user } = useAuth();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  return (
    <>
      <header className="shell-topbar">
        <NavLink to="/projects" className="shell-brand" aria-label="Relay MCP home">
          <span className="shell-brand-mark" aria-hidden="true" />
          <span className="shell-brand-name">Relay MCP</span>
        </NavLink>
        <nav className="shell-primary-nav" aria-label="Primary navigation">
          {primaryNavigation.map((item) => {
            if ("adminOnly" in item && item.adminOnly && !user?.isAdmin) return null;
            const active = matchesPath(location.pathname, item.path);
            return (
              <NavLink
                key={item.path}
                to={item.path}
                className="shell-primary-link"
                aria-current={active ? "page" : undefined}
              >
                {item.label}
              </NavLink>
            );
          })}
        </nav>
        <div className="shell-desktop-user">
          <UserMenu />
        </div>
        <button
          type="button"
          className="shell-menu-button shell-user-trigger"
          aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen((value) => !value)}
        >
          {mobileOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
        </button>
      </header>
      <MobileMenu open={mobileOpen} onClose={() => setMobileOpen(false)} />
    </>
  );
}
export default TopBar;
