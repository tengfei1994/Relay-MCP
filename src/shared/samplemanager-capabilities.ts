import { createHash } from "crypto";

export type SampleManagerRuntimeKind = "framework" | "dotnet" | "unknown";
export type SampleManagerCapabilityStatus = "ready" | "planned" | "unavailable";

export interface SampleManagerInspectorCatalogEntry {
  id: string;
  label: string;
  status: SampleManagerCapabilityStatus;
  readOnly: boolean;
  description: string;
  plannedTool?: string;
  relatedEntities?: string[];
  evidenceKinds: Array<"sql" | "schema" | "runtime" | "logs" | "playwright" | "artifact">;
}

export interface SampleManagerEntityCatalogEntry {
  id: string;
  label: string;
  description: string;
  inspectors: SampleManagerInspectorCatalogEntry[];
}

export interface SampleManagerInstanceDescriptor {
  id?: number;
  name: string;
  version: string;
  runtimeKind: SampleManagerRuntimeKind;
  rootPath?: string;
  databaseHost?: string;
  databaseName?: string;
}

export interface SampleManagerCapabilityDescriptor {
  id: string;
  objectType: "instance" | "plate" | "workflow" | "lab_method" | "entity";
  status: SampleManagerCapabilityStatus;
  readOnly: boolean;
  description: string;
  plannedTool?: string;
}

export interface SampleManagerAdapter {
  id: string;
  displayName: string;
  versionRange: string;
  runtimeKind: SampleManagerRuntimeKind;
  schemaProfile: string;
  matches(version: string): boolean;
  capabilities: SampleManagerCapabilityDescriptor[];
}

export interface SampleManagerCapabilityPack {
  packId: string;
  adapterId: string;
  adapterDisplayName: string;
  versionRange: string;
  schemaProfile: string;
  instanceFingerprint: string;
  resolvedAt: string;
  cache: { hit: boolean; ttlMs: number };
  instance: SampleManagerInstanceDescriptor;
  capabilities: SampleManagerCapabilityDescriptor[];
  outputContract: {
    facts: string;
    inferences: string;
    unknowns: string;
    evidence: string;
    provenance: string;
  };
}

const DEFAULT_CACHE_TTL_MS = Number(process.env.RELAY_SAMPLEMANAGER_CAPABILITY_TTL_MS ?? 10 * 60 * 1000);

function parseVersion(value: string): { major: number; minor: number } | undefined {
  const match = String(value ?? "").match(/(\d+)\.(\d+)/);
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : undefined;
}

function matchesMajorMinor(major: number, minor: number) {
  return (version: string) => {
    const parsed = parseVersion(version);
    return parsed?.major === major && parsed.minor === minor;
  };
}

const COMMON_CAPABILITIES: SampleManagerCapabilityDescriptor[] = [
  {
    id: "instance.inspect",
    objectType: "instance",
    status: "ready",
    readOnly: true,
    description: "Resolve instance, runtime, database, paths, services, and capability adapter metadata.",
  },
  {
    id: "plate.diagnose",
    objectType: "plate",
    status: "planned",
    readOnly: true,
    description: "Inspect Plate, Batch, Execution, well, Sample, Test, and Result relationships.",
    plannedTool: "samplemanager_plate_diagnose",
  },
  {
    id: "workflow.validate",
    objectType: "workflow",
    status: "planned",
    readOnly: true,
    description: "Export and validate Workflow topology, parameters, registration, and broken relationships.",
    plannedTool: "samplemanager_workflow_validate",
  },
  {
    id: "lab_method.validate",
    objectType: "lab_method",
    status: "planned",
    readOnly: true,
    description: "Validate Lab Method versions, Steps, Parameters, workflow buttons, and execution compatibility.",
    plannedTool: "samplemanager_lab_method_validate",
  },
];

export const SAMPLEMANAGER_ENTITY_CATALOG: SampleManagerEntityCatalogEntry[] = [
  {
    id: "instance",
    label: "Instance",
    description: "Runtime, database, paths, services, version adapter, and overall instance health.",
    inspectors: [
      { id: "capabilities", label: "Capabilities", status: "ready", readOnly: true, description: "Resolve the instance version adapter and supported semantic inspectors.", plannedTool: "samplemanager_capabilities", evidenceKinds: ["schema", "artifact"] },
      { id: "readiness", label: "Readiness", status: "planned", readOnly: true, description: "Check services, ports, database access, paths, and runtime prerequisites.", plannedTool: "samplemanager_instance_health", evidenceKinds: ["runtime", "sql", "logs"] },
    ],
  },
  {
    id: "plate",
    label: "Plate",
    description: "Plate creation, layout, Batch linkage, well assignment, and Result coverage.",
    inspectors: [
      { id: "readiness", label: "Readiness", status: "planned", readOnly: true, description: "Determine whether Plate Type, Fill Order, Appearance, source entities, and creation workflow are ready.", plannedTool: "samplemanager_inspect_plate_batch", relatedEntities: ["batch", "workflow", "execution"], evidenceKinds: ["sql", "schema", "logs"] },
      { id: "batch_integrity", label: "Batch Integrity", status: "planned", readOnly: true, description: "Compare Plate wells with Batch Template and Batch Entry counts, types, and Test assignments.", plannedTool: "samplemanager_inspect_plate_batch", relatedEntities: ["batch", "test", "sample"], evidenceKinds: ["sql", "artifact"] },
      { id: "layout_integrity", label: "Layout Integrity", status: "planned", readOnly: true, description: "Detect missing, duplicate, extra, and out-of-range wells against an expected layout profile.", plannedTool: "samplemanager_inspect_plate_batch", relatedEntities: ["batch"], evidenceKinds: ["sql", "artifact", "playwright"] },
      { id: "result_coverage", label: "Result Coverage", status: "planned", readOnly: true, description: "Trace occupied wells to Test and Result records and identify incomplete Result generation.", plannedTool: "samplemanager_inspect_test_lineage", relatedEntities: ["test", "analysis"], evidenceKinds: ["sql"] },
    ],
  },
  {
    id: "batch",
    label: "Batch",
    description: "Batch Template expectations, Apply behavior, entries, and Plate assignment.",
    inspectors: [
      { id: "readiness", label: "Readiness", status: "planned", readOnly: true, description: "Check Template, Analysis, entry types, source entities, and Apply prerequisites.", plannedTool: "samplemanager_inspect_plate_batch", relatedEntities: ["plate", "analysis"], evidenceKinds: ["sql", "schema"] },
      { id: "template_integrity", label: "Template Integrity", status: "planned", readOnly: true, description: "Compare Batch Template definitions with actual Batch Entries and expected counts.", plannedTool: "samplemanager_inspect_plate_batch", relatedEntities: ["plate"], evidenceKinds: ["sql", "artifact"] },
      { id: "apply_integrity", label: "Apply Integrity", status: "planned", readOnly: true, description: "Compare pre/post Apply state and detect missing or duplicate Sample and Test creation.", plannedTool: "samplemanager_inspect_plate_batch", relatedEntities: ["sample", "test", "plate"], evidenceKinds: ["sql", "logs", "playwright"] },
    ],
  },
  {
    id: "execution",
    label: "Lab Execution",
    description: "Execution readiness, template alignment, Step state, and runtime entity links.",
    inspectors: [
      { id: "readiness", label: "Readiness", status: "planned", readOnly: true, description: "Validate source object, Method version, Steps, Parameters, Workflow buttons, and start conditions.", plannedTool: "samplemanager_inspect_execution", relatedEntities: ["lab_method", "workflow", "test"], evidenceKinds: ["sql", "schema", "logs"] },
      { id: "template_alignment", label: "Template Alignment", status: "planned", readOnly: true, description: "Compare Execution Steps and Parameters with the selected Lab Method version.", plannedTool: "samplemanager_inspect_execution", relatedEntities: ["lab_method"], evidenceKinds: ["sql", "artifact"] },
      { id: "entity_links", label: "Entity Links", status: "planned", readOnly: true, description: "Check Test, Sample, Plate, Batch, Callback, and return-property linkage.", plannedTool: "samplemanager_inspect_execution", relatedEntities: ["plate", "batch", "test", "workflow"], evidenceKinds: ["sql", "runtime", "logs"] },
    ],
  },
  {
    id: "test",
    label: "Test & Result",
    description: "Sample/Test lineage, Analysis version, Components, Results, and Plate assignment.",
    inspectors: [
      { id: "lineage", label: "Lineage", status: "planned", readOnly: true, description: "Trace source Test and Sample through child Well Tests, Batch Entries, Plate wells, and Results.", plannedTool: "samplemanager_inspect_test_lineage", relatedEntities: ["sample", "plate", "analysis"], evidenceKinds: ["sql", "artifact"] },
      { id: "result_completeness", label: "Result Completeness", status: "planned", readOnly: true, description: "Compare required Analysis Components with generated Result records and values.", plannedTool: "samplemanager_inspect_test_lineage", relatedEntities: ["analysis"], evidenceKinds: ["sql", "schema"] },
      { id: "assignment_integrity", label: "Assignment Integrity", status: "planned", readOnly: true, description: "Detect orphan Tests, duplicate well assignment, incorrect Parent Test, or wrong Sample linkage.", plannedTool: "samplemanager_inspect_test_lineage", relatedEntities: ["sample", "plate", "batch"], evidenceKinds: ["sql"] },
    ],
  },
  {
    id: "lab_method",
    label: "Lab Method",
    description: "Method versions, Steps, Parameters, Variables, Instructions, formulas, and workflow buttons.",
    inspectors: [
      { id: "definition", label: "Definition Integrity", status: "planned", readOnly: true, description: "Validate Step, Parameter, Variable, Instruction, type, formula, and criteria definitions.", plannedTool: "samplemanager_inspect_execution", relatedEntities: ["execution", "workflow"], evidenceKinds: ["sql", "schema", "artifact"] },
      { id: "version_integrity", label: "Version Integrity", status: "planned", readOnly: true, description: "Compare versions and detect missing fields, broken references, and stale Execution definitions.", plannedTool: "samplemanager_inspect_execution", relatedEntities: ["execution"], evidenceKinds: ["sql", "artifact"] },
    ],
  },
  {
    id: "workflow",
    label: "Workflow",
    description: "Workflow topology, Node contracts, entity context, callbacks, and runtime behavior.",
    inspectors: [
      { id: "topology", label: "Topology", status: "planned", readOnly: true, description: "Find unreachable, orphaned, cyclic, and disconnected Workflow nodes.", plannedTool: "samplemanager_inspect_execution", relatedEntities: ["execution", "lab_method"], evidenceKinds: ["sql", "artifact"] },
      { id: "node_contract", label: "Node Contract", status: "planned", readOnly: true, description: "Validate Node Type registration, parameters, entity inputs, outputs, callback, and return properties.", plannedTool: "samplemanager_inspect_execution", relatedEntities: ["execution"], evidenceKinds: ["sql", "runtime", "logs"] },
      { id: "runtime_readiness", label: "Runtime Readiness", status: "planned", readOnly: true, description: "Identify checks that require runtime logs or UI smoke tests beyond static SQL evidence.", plannedTool: "samplemanager_inspect_deployment_runtime", relatedEntities: ["deployment", "instance"], evidenceKinds: ["runtime", "logs", "playwright"] },
    ],
  },
  {
    id: "analysis",
    label: "Analysis",
    description: "Analysis versions, Component definitions, Result generation, formulas, units, and scripts.",
    inspectors: [
      { id: "definition", label: "Definition Integrity", status: "planned", readOnly: true, description: "Validate Component types, units, precision, formulas, limits, and visibility settings.", plannedTool: "samplemanager_inspect_test_lineage", relatedEntities: ["test"], evidenceKinds: ["sql", "schema"] },
      { id: "result_generation", label: "Result Generation", status: "planned", readOnly: true, description: "Compare defined Components with Results generated for actual Tests.", plannedTool: "samplemanager_inspect_test_lineage", relatedEntities: ["test"], evidenceKinds: ["sql"] },
    ],
  },
  {
    id: "deployment",
    label: "Deployment",
    description: "Package state, database changes, files, assemblies, services, runtime loading, and rollback.",
    inspectors: [
      { id: "runtime_drift", label: "Runtime Drift", status: "planned", readOnly: true, description: "Compare package, database, disk files, loaded modules, service state, and logs.", plannedTool: "samplemanager_inspect_deployment_runtime", relatedEntities: ["instance", "workflow"], evidenceKinds: ["artifact", "runtime", "logs", "sql"] },
      { id: "rollback_readiness", label: "Rollback Readiness", status: "planned", readOnly: true, description: "Validate SQL rollback, file backups, hashes, and configuration snapshots.", plannedTool: "samplemanager_inspect_deployment_runtime", relatedEntities: ["instance"], evidenceKinds: ["artifact", "sql"] },
    ],
  },
  {
    id: "form_task",
    label: "Form & Task",
    description: "Form XML identity, controls, task bindings, assembly contracts, compiled cache, and deployment readiness.",
    inspectors: [
      { id: "contract", label: "Contract", status: "ready", readOnly: true, description: "Validate FORM, TASK, MASTER_MENU, form XML controls, assembly members, hashes, and compiled cache evidence.", plannedTool: "samplemanager_validate_form_task_contract", relatedEntities: ["deployment", "instance"], evidenceKinds: ["sql", "schema", "artifact", "runtime"] },
    ],
  },
  {
    id: "data_model",
    label: "Data Model",
    description: "Physical table schema, Entity Definition mapping, SQL access, and data mutation utilities.",
    inspectors: [
      { id: "schema", label: "Schema", status: "ready", readOnly: true, description: "Inspect SQL Server columns, keys, identity, defaults, and physical mappings.", plannedTool: "samplemanager_table_schema", evidenceKinds: ["schema", "sql"] },
    ],
  },
];

export const BUILTIN_SAMPLEMANAGER_ADAPTERS: SampleManagerAdapter[] = [
  {
    id: "samplemanager-21.1",
    displayName: "SampleManager 21.1 Adapter",
    versionRange: "21.1.x",
    runtimeKind: "framework",
    schemaProfile: "samplemanager/21.1",
    matches: matchesMajorMinor(21, 1),
    capabilities: COMMON_CAPABILITIES,
  },
  {
    id: "samplemanager-21.2",
    displayName: "SampleManager 21.2 Adapter",
    versionRange: "21.2.x",
    runtimeKind: "dotnet",
    schemaProfile: "samplemanager/21.2",
    matches: matchesMajorMinor(21, 2),
    capabilities: COMMON_CAPABILITIES,
  },
  {
    id: "samplemanager-21.3",
    displayName: "SampleManager 21.3 Adapter",
    versionRange: "21.3.x",
    runtimeKind: "dotnet",
    schemaProfile: "samplemanager/21.3",
    matches: matchesMajorMinor(21, 3),
    capabilities: COMMON_CAPABILITIES,
  },
  {
    id: "samplemanager-generic",
    displayName: "Generic SampleManager Adapter",
    versionRange: "unknown",
    runtimeKind: "unknown",
    schemaProfile: "samplemanager/generic",
    matches: () => true,
    capabilities: COMMON_CAPABILITIES.map((capability) => capability.objectType === "instance"
      ? capability
      : { ...capability, status: "unavailable", description: `${capability.description} A version-specific adapter is required.` }),
  },
];

interface CacheEntry {
  expiresAt: number;
  pack: SampleManagerCapabilityPack;
}

export class SampleManagerCapabilityRegistry {
  private readonly adapters: SampleManagerAdapter[];
  private readonly cache = new Map<string, CacheEntry>();

  constructor(adapters: SampleManagerAdapter[] = BUILTIN_SAMPLEMANAGER_ADAPTERS, private readonly ttlMs = DEFAULT_CACHE_TTL_MS) {
    this.adapters = [...adapters];
  }

  listAdapters(): Array<Omit<SampleManagerAdapter, "matches">> {
    return this.adapters.map(({ matches: _matches, ...adapter }) => ({
      ...adapter,
      capabilities: adapter.capabilities.map((capability) => ({ ...capability })),
    }));
  }

  resolve(instance: SampleManagerInstanceDescriptor): SampleManagerCapabilityPack {
    const fingerprint = sampleManagerInstanceFingerprint(instance);
    const cached = this.cache.get(fingerprint);
    if (cached && cached.expiresAt > Date.now()) {
      return { ...cached.pack, cache: { hit: true, ttlMs: this.ttlMs } };
    }
    const adapter = this.adapters.find((candidate) => candidate.matches(instance.version))
      ?? this.adapters[this.adapters.length - 1];
    const pack: SampleManagerCapabilityPack = {
      packId: `${adapter.id}:${fingerprint.slice(0, 12)}`,
      adapterId: adapter.id,
      adapterDisplayName: adapter.displayName,
      versionRange: adapter.versionRange,
      schemaProfile: adapter.schemaProfile,
      instanceFingerprint: fingerprint,
      resolvedAt: new Date().toISOString(),
      cache: { hit: false, ttlMs: this.ttlMs },
      instance: { ...instance },
      capabilities: adapter.capabilities.map((capability) => ({ ...capability })),
      outputContract: {
        facts: "Values directly observed from the target instance or database.",
        inferences: "Conclusions derived from one or more facts and named rules.",
        unknowns: "Questions that cannot be proven with the available adapter or evidence.",
        evidence: "SQL query IDs, artifacts, hashes, runtime probes, and source locations.",
        provenance: "Project, environment, server, Agent, instance, version, database, and adapter identity.",
      },
    };
    this.cache.set(fingerprint, { pack, expiresAt: Date.now() + this.ttlMs });
    return pack;
  }

  clear(): void {
    this.cache.clear();
  }
}

export function sampleManagerInstanceFingerprint(instance: SampleManagerInstanceDescriptor): string {
  return createHash("sha256").update(JSON.stringify({
    id: instance.id ?? null,
    name: instance.name,
    version: instance.version,
    runtimeKind: instance.runtimeKind,
    rootPath: instance.rootPath ?? "",
    databaseHost: instance.databaseHost ?? "",
    databaseName: instance.databaseName ?? "",
  })).digest("hex");
}

export function createSampleManagerInspectionEnvelope(input: {
  capability: string;
  provenance: Record<string, unknown>;
  facts?: unknown[];
  inferences?: unknown[];
  unknowns?: unknown[];
  evidence?: unknown[];
}) {
  return {
    capability: input.capability,
    readOnly: true,
    mutationAttempted: false,
    provenance: input.provenance,
    facts: input.facts ?? [],
    inferences: input.inferences ?? [],
    unknowns: input.unknowns ?? [],
    evidence: input.evidence ?? [],
  };
}
