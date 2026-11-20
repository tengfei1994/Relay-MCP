import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../../App";
import { knowledgeNavigation, matchesPath } from "./navigation";

const adminSections = [
  { label: "Overview", path: "/admin", view: "" },
  { label: "Users & access", path: "/admin?view=users", view: "users" },
  { label: "Token management", path: "/admin?view=tokens", view: "tokens" },
];

export function ContextRail({ onNavigate }: { onNavigate?: () => void }) {
  const { pathname, search } = useLocation();
  const { user } = useAuth();
  const inAdmin = pathname === "/admin" && user?.isAdmin;
  const inKnowledge = matchesPath(pathname, "/knowledge");
  if (!inAdmin && !inKnowledge) return null;

  const view = new URLSearchParams(search).get("view") ?? "";
  const sections = inAdmin ? adminSections.map(({ label, path, view: key }) => ({
    label, path, active: view === key || (key === "" && !adminSections.some((section) => section.view === view)),
  })) : knowledgeNavigation.map(({ label, path, matches }) => ({
    label, path, active: matches(pathname),
  }));
  const label = inAdmin ? "Admin" : "Knowledge";

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
