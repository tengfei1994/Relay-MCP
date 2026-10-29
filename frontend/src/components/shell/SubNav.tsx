import { NavLink, useLocation } from "react-router-dom";
import { knowledgeNavigation } from "./navigation";
import { ScopeChip } from "./ScopeChip";

function showsScope(pathname: string): boolean {
  if (pathname === "/knowledge" || pathname.startsWith("/knowledge/product-docs") || pathname.startsWith("/knowledge/operations")) return false;
  return pathname.startsWith("/knowledge");
}

export function SubNav() {
  const location = useLocation();
  const showScope = showsScope(location.pathname);
  return (
    <div className="shell-subnav">
      <nav className="shell-subnav-scroll" aria-label="Knowledge navigation">
        {knowledgeNavigation.map((item) => {
          const active = item.matches(location.pathname);
          return (
            <NavLink
              key={item.path}
              to={item.path}
              className="shell-subnav-link"
              aria-current={active ? "page" : undefined}
            >
              {item.label}
            </NavLink>
          );
        })}
      </nav>
      {showScope && <ScopeChip />}
    </div>
  );
}
export default SubNav;
