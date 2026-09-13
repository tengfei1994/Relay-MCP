import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeSampleManagerWorkflowSnapshot,
  runSampleManagerWorkflowSnapshot,
} from "../src/shared/samplemanager-workflow-inspection.ts";

const table = (name: string, rows: Record<string, unknown>[], status = "ok") => ({
  table: name,
  status,
  columns: rows.length ? Object.keys(rows[0]) : [],
  rows,
  rowCount: rows.length,
});

test("Workflow validation reports broken links, cycles, unreachable nodes, and missing contracts", () => {
  const response = analyzeSampleManagerWorkflowSnapshot({
    ok: true,
    target: { workflowId: "WF-1" },
    tables: [
      table("WORKFLOW", [{ ID: "WF-1", NAME: "Review", VERSION: "3", MODE: "interactive" }]),
      table("WORKFLOW_NODE", [
        { ID: "N1", NAME: "Start", NODE_TYPE: "Create", MODE: "interactive", ENTITY_CONTEXT: "Execution" },
        { ID: "N2", NAME: "Review", NODE_TYPE: "Review", MODE: "interactive", ENTITY_CONTEXT: "Execution" },
        { ID: "N3", NAME: "Orphan", NODE_TYPE: "Unused" },
      ]),
      table("WORKFLOW_LINK", [
        { ID: "L1", SOURCE_NODE_ID: "N1", TARGET_NODE_ID: "N2" },
        { ID: "L2", SOURCE_NODE_ID: "N2", TARGET_NODE_ID: "N1" },
        { ID: "L3", SOURCE_NODE_ID: "N2", TARGET_NODE_ID: "MISSING" },
      ]),
      table("WORKFLOW_NODE_PARAMETER", [{ ID: "P1", NODE_ID: "N1", NAME: "mode", TYPE: "Text", VALUE: "interactive" }]),
    ],
  }, { action: "validate", queryId: "workflow-test" });
  const ids = response.violations.map((item) => item.ruleId);
  assert.ok(ids.includes("unresolved_link_endpoint"));
  assert.ok(ids.includes("workflow_cycle"));
  assert.ok(ids.includes("unreachable_node"));
  assert.deepEqual(response.topology.entryNodeIds, ["n3"]);
  assert.equal(response.snapshot.workflow?.name, "Review");
  assert.equal(response.snapshot.nodes[0].nodeType, "Create");
  assert.equal(response.queryMetadata.mutationAttempted, false);
});

test("Workflow baseline comparison returns normalized node and link differences", () => {
  const response = analyzeSampleManagerWorkflowSnapshot({
    ok: true,
    tables: [
      table("WORKFLOW", [{ ID: "WF-1", NAME: "Review", VERSION: "2" }]),
      table("WORKFLOW_NODE", [{ ID: "N1", NAME: "Start", NODE_TYPE: "Create" }, { ID: "N2", NAME: "Approve", NODE_TYPE: "Approve" }]),
      table("WORKFLOW_LINK", [{ ID: "L1", SOURCE_NODE_ID: "N1", TARGET_NODE_ID: "N2" }]),
      table("WORKFLOW_PARAMETER", [{ ID: "P1", NODE_ID: "N1", NAME: "mode", TYPE: "Text", VALUE: "background" }]),
    ],
  }, {
    action: "compare",
    baseline: {
      snapshot: {
        workflow: { id: "WF-1", name: "Review", version: "1" },
        nodes: [{ id: "N1", name: "Start", nodeType: "Create" }, { id: "N3", name: "Finish", nodeType: "Finish" }],
        links: [{ source: "N1", target: "N3" }],
      },
    },
  });
  const diff = response.diff as Record<string, unknown>;
  assert.equal((diff.addedNodes as unknown[]).length, 1);
  assert.equal((diff.removedNodes as unknown[]).length, 1);
  assert.equal((diff.changedNodes as unknown[]).length, 0);
  assert.equal((diff.addedLinks as unknown[]).length, 1);
  assert.equal((diff.removedLinks as unknown[]).length, 1);
  assert.deepEqual((diff.workflow as Record<string, unknown>).version, { expected: "1", actual: "2" });
  assert.ok(response.violations.some((item) => item.ruleId === "workflow_baseline_diff"));
});

test("Workflow remote snapshot validates target and uses bounded dynamic table discovery", async () => {
  let script = "";
  const runner = {
    execPowerShell: async (value: string) => {
      script = value;
      return { stdout: JSON.stringify({ ok: true, tables: [] }), stderr: "", code: 0 };
    },
  } as any;
  const output = await runSampleManagerWorkflowSnapshot(runner, {
    database: "VGSM",
    databaseHost: "localhost\\SQLEXPRESS",
    target: { workflowName: "Review", workflowVersion: "3" },
    maxRows: 42,
  });
  assert.equal(JSON.parse(output).ok, true);
  assert.match(script, /INFORMATION_SCHEMA\.COLUMNS/);
  assert.match(script, /WORKFLOW_NODE/);
  assert.match(script, /WORKFLOW_LINK/);
  assert.match(script, /\$maxRows = 42/);
  await assert.rejects(() => runSampleManagerWorkflowSnapshot(runner, {
    database: "VGSM",
    databaseHost: "localhost",
    target: {},
  }), /At least one workflow target identity is required/);
});
