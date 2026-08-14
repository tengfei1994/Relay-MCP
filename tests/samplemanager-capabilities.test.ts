import assert from "node:assert/strict";
import test from "node:test";
import {
  SampleManagerCapabilityRegistry,
  SAMPLEMANAGER_ENTITY_CATALOG,
  createSampleManagerInspectionEnvelope,
  sampleManagerInstanceFingerprint,
} from "../src/shared/samplemanager-capabilities.ts";

const instance = {
  id: 4,
  name: "VGSM",
  version: "21.3.0.0",
  runtimeKind: "dotnet" as const,
  rootPath: "C:\\Thermo\\SampleManager\\Server\\VGSM",
  databaseHost: "localhost\\SQLEXPRESS",
  databaseName: "VGSM",
};

test("capability registry resolves a version-specific adapter and caches by instance fingerprint", () => {
  const registry = new SampleManagerCapabilityRegistry(undefined, 60000);
  const first = registry.resolve(instance);
  const second = registry.resolve(instance);
  assert.equal(first.adapterId, "samplemanager-21.3");
  assert.equal(first.cache.hit, false);
  assert.equal(second.cache.hit, true);
  assert.equal(first.instanceFingerprint, second.instanceFingerprint);
  assert.equal(first.capabilities.find((item) => item.id === "instance.inspect")?.status, "ready");
});

test("unknown SampleManager versions use the generic adapter without claiming semantic support", () => {
  const registry = new SampleManagerCapabilityRegistry();
  const pack = registry.resolve({ ...instance, version: "24.0.0", runtimeKind: "unknown" });
  assert.equal(pack.adapterId, "samplemanager-generic");
  assert.equal(pack.capabilities.find((item) => item.id === "workflow.validate")?.status, "unavailable");
});

test("instance fingerprints change when the database target changes", () => {
  assert.notEqual(
    sampleManagerInstanceFingerprint(instance),
    sampleManagerInstanceFingerprint({ ...instance, databaseName: "OTHER" })
  );
});

test("inspection envelopes separate facts, inferences, unknowns, and evidence", () => {
  const envelope = createSampleManagerInspectionEnvelope({
    capability: "instance.inspect",
    provenance: { instance: "VGSM" },
    facts: [{ path: "instance.version", value: "21.3.0.0" }],
    unknowns: ["runtime module load state was not requested"],
  });
  assert.equal(envelope.readOnly, true);
  assert.equal(envelope.mutationAttempted, false);
  assert.equal(envelope.facts.length, 1);
  assert.equal(envelope.unknowns.length, 1);
});

test("entity catalog groups inspectors by stable entity and inspector ids", () => {
  const entityIds = SAMPLEMANAGER_ENTITY_CATALOG.map((item) => item.id);
  assert.equal(new Set(entityIds).size, entityIds.length);
  const plate = SAMPLEMANAGER_ENTITY_CATALOG.find((item) => item.id === "plate");
  assert.ok(plate);
  assert.ok(plate.inspectors.some((item) => item.id === "readiness"));
  assert.ok(plate.inspectors.some((item) => item.id === "batch_integrity"));
  for (const entity of SAMPLEMANAGER_ENTITY_CATALOG) {
    assert.ok(entity.inspectors.length > 0);
    assert.equal(new Set(entity.inspectors.map((item) => item.id)).size, entity.inspectors.length);
    for (const inspector of entity.inspectors) {
      assert.ok(inspector.description.length >= 20);
      assert.ok(inspector.evidenceKinds.length > 0);
    }
  }
});
