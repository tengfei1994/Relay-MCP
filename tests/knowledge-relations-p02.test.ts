import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createKnowledgeStore } from "../src/knowledge/store.ts";
import { analyzeRelationImpact, extractSampleManagerRelations, persistRelations, queryRelations } from "../src/knowledge/relations.ts";

test("P02 relation extractors cover deterministic source kinds and preserve scope", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-p02-relations-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db"), appDbPath: join(root, "app.db") });
  try {
    store.grantAcl("p1", 7, true);
    const form = extractSampleManagerRelations({ content: '<Form name="Order"><Control name="Status" property="Mandatory"/> <Property control="Status" name="Display"/></Form>', sourceLocator: "Forms/Order.xml", kind: "form-xml", sampleManagerVersion: "21.1", environment: "test" });
    const menu = extractSampleManagerRelations({ content: "Orders|OrderTask", sourceLocator: "MASTER_MENU", kind: "master-menu", sampleManagerVersion: "21.1", environment: "test" });
    const manifest = extractSampleManagerRelations({ content: JSON.stringify({ tasks: ["OrderTask"], assemblies: ["Order.dll"] }), sourceLocator: "deploy.json", kind: "deployment-manifest", sampleManagerVersion: "21.1", environment: "test" });
    assert.ok(form.some((edge) => edge.relationType === "control_property"));
    assert.ok(menu.some((edge) => edge.relationType === "menu_task"));
    assert.ok(manifest.some((edge) => edge.relationType === "deployment_component"));
    assert.ok(form.every((edge) => edge.sourceSha256 && edge.sampleManagerVersion === "21.1" && edge.environment === "test"));
    persistRelations(store, form, "p1"); persistRelations(store, menu, "p1");
    const queried = queryRelations(store, { userId: 7, projectId: "p1", relationType: "form_control", sampleManagerVersion: "21.1", environment: "test" });
    assert.equal(queried.length, 1); assert.equal(queried[0].sampleManagerVersion, "21.1"); assert.equal(queried[0].environment, "test");
    const impact = analyzeRelationImpact(store, { userId: 7, projectId: "p1", objectId: queried[0].from.id, direction: "downstream", maxDepth: 2 });
    assert.ok(impact.nodes.length >= 2); assert.ok(impact.relations.some((edge) => edge.relationType === "form_control"));
  } finally { store.close(); }
});

test("P02 object ids are version scoped", () => {
  const a = extractSampleManagerRelations({ content: '<Form name="Order"><Control name="Status"/></Form>', sourceLocator: "order.xml", kind: "form-xml", sampleManagerVersion: "21.1" });
  const b = extractSampleManagerRelations({ content: '<Form name="Order"><Control name="Status"/></Form>', sourceLocator: "order.xml", kind: "form-xml", sampleManagerVersion: "22.0" });
  assert.notEqual(a[0].from, b[0].from);
});
