import { NavLink, useLocation } from "react-router-dom";
import { knowledgeNavigation } from "./navigation";


export function SubNav() {
  const location = useLocation();
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
    </div>
  );
}
export default SubNav;
