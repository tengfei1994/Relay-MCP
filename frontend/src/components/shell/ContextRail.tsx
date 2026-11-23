import { useLocation } from "react-router-dom";
import { matchesPath } from "./navigation";

export function ContextRail({ onNavigate }: { onNavigate?: () => void }) {
  const { pathname } = useLocation();
  const inKnowledge = matchesPath(pathname, "/knowledge");
  if (inKnowledge) return null;
  return null;
}

export default ContextRail;
