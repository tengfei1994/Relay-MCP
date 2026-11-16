import { useEffect, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import { knowledgeNavigation } from "./navigation";


export function SubNav() {
  const location = useLocation();
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const active = navRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    active?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [location.pathname]);

  return (
    <div className="shell-subnav">
      <nav ref={navRef} className="shell-subnav-scroll" aria-label="Knowledge navigation">
        {knowledgeNavigation.map((item) => {
          const active = item.matches(location.pathname);
          return (
            <Link
              key={item.path}
              to={item.path}
              className={`shell-subnav-link${active ? " active" : ""}`}
              aria-current={active ? "page" : undefined}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
export default SubNav;
