import { useAuth } from "../App";
import { PageHeader } from "../components/ui";
import { WikiPane } from "./KnowledgeIntegrated";

export default function KnowledgeWiki() {
  const { user } = useAuth();
  return (
    <div className="mx-auto max-w-[1280px] px-5 py-8 sm:px-8">
      <PageHeader title="Wiki" description="A version-aware directory of reviewed, source-linked operational knowledge." />
      <WikiPane isAdmin={Boolean(user?.isAdmin)} />
    </div>
  );
}
