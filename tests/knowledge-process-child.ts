import { join } from "node:path";
import { createKnowledgeStore } from "../src/knowledge/store.ts";
import { captureKnowledgeCandidates } from "../src/knowledge/capture-worker.ts";
import { drainRelayEventSpool } from "../src/knowledge/event-sink.ts";
import { configureJobStore, getJob, startJob } from "../src/shared/job-store.ts";
import { configureDeploymentStore, finishDeployment, startDeployment } from "../src/shared/deployment-store.ts";

const root = process.env.RELAY_STATE_ROOT;
if (!root) throw new Error("RELAY_STATE_ROOT is required");

const store = createKnowledgeStore({
  dbPath: join(root, "knowledge.db"),
  appDbPath: join(root, "app.db"),
});
configureJobStore({ eventSink: store, resolveProjectId: () => 42 });
configureDeploymentStore({ eventSink: store, resolveProjectId: () => 42 });

try {
  const job = startJob(
    { id: 7, username: "process-test" },
    "Demo",
    "knowledge-process-e2e",
    { request: "capture" },
    async (context) => {
      context.phase("working");
      return "job completed";
    },
  );

  const deadline = Date.now() + 5_000;
  let current = getJob(job.id);
  while (current?.status === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    current = getJob(job.id);
  }
  if (current?.status !== "succeeded") throw new Error(`Job did not complete: ${current?.status}`);

  const deployment = startDeployment({
    userId: 7,
    username: "process-test",
    project: "Demo",
    environment: "test",
    host: "local",
    kind: "git",
    rollbackRequested: false,
  });
  finishDeployment(deployment.id, {
    status: "succeeded",
    rollback: { requested: false, attempted: false, status: "not-needed" },
  });

  drainRelayEventSpool(store);
  const captured = await captureKnowledgeCandidates(store, "knowledge-capture", 50, () => 42);
  store.grantAcl("42", 7);
  const documents = store.listDocuments(7, "42");
  process.stdout.write(JSON.stringify({ jobStatus: current.status, captured, documents }));
} finally {
  configureJobStore({});
  configureDeploymentStore({});
  store.close();
}

