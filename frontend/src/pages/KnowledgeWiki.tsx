import { useAuth } from "../App";
import { WikiPane } from "./KnowledgeIntegrated";

export default function KnowledgeWiki() {
  const { user } = useAuth();
  return (
    <div className="wiki-route-shell">
      <WikiPane isAdmin={Boolean(user?.isAdmin)} />
    </div>
  );
}
