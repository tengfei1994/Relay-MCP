import { NavLink, useLocation } from "react-router-dom";
import { useAuth } from "../../App";
import { primaryNavigation, matchesPath } from "./navigation";
import { UserMenu } from "./UserMenu";

export function MobileMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const location = useLocation();
  const { user } = useAuth();
  if (!open) return null;
  return (
    <div className="shell-mobile-panel" aria-label="Mobile navigation">
      <nav className="shell-mobile-nav" aria-label="Primary navigation">
        {primaryNavigation.map((item) => {
          if ("adminOnly" in item && item.adminOnly && !user?.isAdmin) return null;
          const active = matchesPath(location.pathname, item.path);
          return (
            <NavLink
              key={item.path}
              to={item.path}
              className="shell-mobile-link"
              aria-current={active ? "page" : undefined}
              onClick={onClose}
            >
              {item.label}
            </NavLink>
          );
        })}
      </nav>
      <UserMenu mobile />
    </div>
  );
}

export default MobileMenu;
