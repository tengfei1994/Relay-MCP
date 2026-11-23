import { Link, useLocation } from "react-router-dom";
import { knowledgeNavigation, matchesPath } from "./navigation";

export function ContextRail({ onNavigate }: { onNavigate?: () => void }) {
  const { pathname } = useLocation();
  const inKnowledge = matchesPath(pathname, "/knowledge");
  if (!inKnowledge) return null;

  const sections = knowledgeNavigation.map(({ label, path, matches }) => ({
    label, path, active: matches(pathname),
  }));
  const label = "Knowledge";

  return (
    <nav className="shell-context-nav" aria-label={label + " sections"}>
      <span className="shell-section-label">{label}</span>
      {sections.map((item) => (
        <Link key={item.path} to={item.path} onClick={onNavigate} className="shell-context-link"
          aria-current={item.active ? "page" : undefined}>{item.label}</Link>
      ))}
    </nav>
  );
}

export default ContextRail;
