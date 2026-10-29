import { NavLink, useLocation } from "react-router-dom";
import { useAuth } from "../../App";
import { pageTabNavigation, matchesPath } from "./navigation";

export type PageTabSection = keyof typeof pageTabNavigation;
export interface PageTab {
  label: string;
  path: string;
  end?: boolean;
  adminOnly?: boolean;
  matches?: (pathname: string) => boolean;
}

export interface PageTabsProps {
  section?: PageTabSection;
  items?: readonly PageTab[];
  className?: string;
}

export function PageTabs({ section, items, className = "" }: PageTabsProps) {
  const { user } = useAuth();
  const location = useLocation();
  const tabs: readonly PageTab[] = items ?? (section ? pageTabNavigation[section] : []);
  const visibleTabs = tabs.filter((tab) => !tab.adminOnly || Boolean(user?.isAdmin));
  if (visibleTabs.length === 0) return null;
  return (
    <nav className={`shell-page-tabs ${className}`.trim()} aria-label="Page navigation">
      {visibleTabs.map((tab) => {
        const active = tab.matches?.(location.pathname)
          ?? matchesPath(location.pathname, tab.path, tab.end);
        return (
          <NavLink
            key={tab.path}
            to={tab.path}
            end={tab.end}
            className={`shell-page-tab${active ? " active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            {tab.label}
          </NavLink>
        );
      })}
    </nav>
  );
}
export default PageTabs;
