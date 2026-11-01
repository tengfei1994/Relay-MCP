import { useAuth } from "../App";
import { WikiPane } from "./KnowledgeIntegrated";
import { WorkspacePage } from "../components/knowledge/KnowledgeFrame";

export default function KnowledgeWiki() {
  const { user } = useAuth();
  return (
    <WorkspacePage className="wiki-route-shell">
      <WikiPane isAdmin={Boolean(user?.isAdmin)} />
    </WorkspacePage>
  );
}
