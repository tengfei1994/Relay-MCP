import { Link, useLocation } from "react-router-dom";

const sections = [
  { label: "Overview", path: "/admin", view: "" },
  { label: "Users & access", path: "/admin?view=users", view: "users" },
  { label: "Token management", path: "/admin?view=tokens", view: "tokens" },
];

export function AdminSectionNav() {
  const { search } = useLocation();
  const view = new URLSearchParams(search).get("view") ?? "";
  return <nav className="admin-section-nav" aria-label="Admin sections">
    <span className="admin-section-nav-label">Admin</span>
    <div className="admin-section-nav-links">
      {sections.map((section) => <Link key={section.path} to={section.path} aria-current={view === section.view ? "page" : undefined}>{section.label}</Link>)}
    </div>
  </nav>;
}
