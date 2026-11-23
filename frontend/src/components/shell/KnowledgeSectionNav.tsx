import { Link, useLocation } from "react-router-dom";
import { knowledgeNavigation } from "./navigation";

/** Section navigation for Knowledge stays in the content column so the global
 * sidebar remains stable while switching between Knowledge surfaces. */
export function KnowledgeSectionNav() {
  const { pathname } = useLocation();
  return (
    <nav className="knowledge-section-nav" aria-label="Knowledge sections">
      <span className="knowledge-section-nav-label">Knowledge</span>
      <div className="knowledge-section-nav-links">
        {knowledgeNavigation.map(({ label, path, matches }) => {
          const active = matches(pathname);
          return (
            <Link key={path} to={path} aria-current={active ? "page" : undefined}>
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

export default KnowledgeSectionNav;
