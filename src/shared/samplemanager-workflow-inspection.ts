import { ensureRemoteSuccess, type RemoteExecutionOptions, type RemoteRunner } from "./remote-runner.js";

export interface SampleManagerWorkflowTarget {
  workflowId?: string;
  workflowName?: string;
  workflowVersion?: string;
  nodeType?: string;
}

export interface SampleManagerWorkflowSnapshotOptions {
  database: string;
  databaseHost: string;
  target: SampleManagerWorkflowTarget;
  maxRows?: number;
  execution?: RemoteExecutionOptions;
}

export interface SampleManagerWorkflowBaseline {
  snapshot?: {
    workflow?: Record<string, unknown>;
    nodes?: Array<Record<string, unknown>>;
    links?: Array<Record<string, unknown>>;
    parameters?: Array<Record<string, unknown>>;
  };
  workflow?: Record<string, unknown>;
  nodes?: Array<Record<string, unknown>>;
  links?: Array<Record<string, unknown>>;
  parameters?: Array<Record<string, unknown>>;
}

export interface WorkflowAnalysisOptions {
  action: "export" | "validate" | "compare";
  target?: SampleManagerWorkflowTarget;
  baseline?: SampleManagerWorkflowBaseline;
  queryId?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface WorkflowInspectionEnvelope {
  action: WorkflowAnalysisOptions["action"];
  target: Record<string, unknown>;
  snapshot: {
    workflow: Record<string, unknown> | null;
    nodes: Array<Record<string, unknown>>;
    links: Array<Record<string, unknown>>;
    parameters: Array<Record<string, unknown>>;
  };
  topology: Record<string, unknown>;
  facts: unknown[];
  inferences: unknown[];
  unknowns: string[];
  violations: Array<Record<string, unknown>>;
  diff?: Record<string, unknown>;
  evidence: unknown[];
  errors: Array<Record<string, unknown>>;
  queryMetadata: Record<string, unknown>;
  partial: boolean;
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function safeValue(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256 || /[\r\n\0]/.test(trimmed)) throw new Error(`Invalid ${label}`);
  return trimmed;
}

function safeTarget(target: SampleManagerWorkflowTarget): SampleManagerWorkflowTarget {
  return Object.fromEntries(Object.entries(target).map(([key, value]) => [key, safeValue(value, key)])) as SampleManagerWorkflowTarget;
}

function tableNames(): string[] {
  return [
    "WORKFLOW",
    "WORKFLOW_NODE",
    "WORKFLOW_LINK",
    "WORKFLOW_NODE_PARAMETER",
    "WORKFLOW_PARAMETER",
    "WORKFLOW_PROPERTY",
  ];
}

function serializeTarget(target: SampleManagerWorkflowTarget): string {
  return JSON.stringify(target);
}

/**
 * Export a bounded Workflow snapshot. Table and filter columns are discovered
 * from INFORMATION_SCHEMA so the adapter can survive version-specific names.
 */
export async function runSampleManagerWorkflowSnapshot(
  runner: RemoteRunner,
  options: SampleManagerWorkflowSnapshotOptions,
): Promise<string> {
  if (!/^[A-Za-z0-9_.-]+$/.test(options.database)) throw new Error(`Invalid database name: ${options.database}`);
  if (!options.databaseHost.trim() || /[\r\n";]/.test(options.databaseHost)) throw new Error(`Invalid database host: ${options.databaseHost}`);
  const target = safeTarget(options.target);
  if (!Object.values(target).some(Boolean)) throw new Error("At least one workflow target identity is required");
  const maxRows = Math.max(1, Math.min(Math.trunc(options.maxRows ?? 200), 500));
  const tables = tableNames();
  const script = `
$ErrorActionPreference = "Stop"
$target = ${psQuote(serializeTarget(target))} | ConvertFrom-Json
$tableNames = @(${tables.map(psQuote).join(",")})
$maxRows = ${maxRows}
$startedAt = Get-Date
$script:relayResolvedWorkflowId = $null
$connection = New-Object System.Data.SqlClient.SqlConnection ${psQuote(`Server=${options.databaseHost};Database=${options.database};Integrated Security=True;TrustServerCertificate=True`)}

function Convert-Value($value) {
  if ($value -eq [DBNull]::Value) { return $null }
  if ($value -is [byte[]]) { return "<binary $($value.Length) bytes>" }
  if ($value -is [datetime]) { return $value.ToString("o") }
  $text = [string]$value
  if ($text.Length -gt 2000) { return $text.Substring(0, 2000) + "..." }
  return $value
}

function Get-Columns([string]$tableName) {
  $command = $connection.CreateCommand()
  $command.CommandText = "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='dbo' AND TABLE_NAME=@table ORDER BY ORDINAL_POSITION"
  $null = $command.Parameters.Add('@table',[Data.SqlDbType]::NVarChar,128)
  $command.Parameters['@table'].Value = $tableName
  $reader = $command.ExecuteReader(); $columns = @()
  while ($reader.Read()) { $columns += [string]$reader[0] }
  $reader.Close(); $command.Dispose(); return @($columns)
}

function Get-TargetPairs([string]$tableName) {
  $pairs = @()
  $workflowIds = @('WORKFLOW_ID','ID','IDENTITY','WORKFLOW','WORKFLOW_NUMBER')
  $workflowNames = @('WORKFLOW_NAME','NAME','DESCRIPTION','TITLE')
  $versions = @('WORKFLOW_VERSION','VERSION','REVISION')
  $nodeTypes = @('NODE_TYPE','TYPE','CLASS_NAME','CLASS','NODE_CLASS')
  $workflowId = if ($target.workflowId) { [string]$target.workflowId } else { [string]$script:relayResolvedWorkflowId }
  if ($workflowId) { $pairs += [pscustomobject]@{ columns=$workflowIds; value=$workflowId; label='workflowId' } }
  if ($target.workflowName -and $tableName -eq 'WORKFLOW') { $pairs += [pscustomobject]@{ columns=$workflowNames; value=[string]$target.workflowName; label='workflowName' } }
  if ($target.workflowVersion -and $tableName -eq 'WORKFLOW') { $pairs += [pscustomobject]@{ columns=$versions; value=[string]$target.workflowVersion; label='workflowVersion' } }
  if ($target.nodeType -and $tableName -in @('WORKFLOW_NODE','WORKFLOW_NODE_PARAMETER','WORKFLOW_PROPERTY')) {
    $pairs += [pscustomobject]@{ columns=$nodeTypes; value=[string]$target.nodeType; label='nodeType' }
  }
  return @($pairs)
}

function Read-Table([string]$tableName) {
  $columns = @(Get-Columns $tableName)
  if ($columns.Count -eq 0) {
    return [pscustomobject]@{ table=$tableName; status='missing'; columns=@(); rows=@(); rowCount=0; reason='Table not found in dbo' }
  }
  $pairs = @(Get-TargetPairs $tableName)
  $predicates = @(); $values = @(); $index = 0
  foreach ($pair in $pairs) {
    foreach ($candidate in $pair.columns) {
      if ($columns -contains $candidate) {
        $parameterName = '@relay_workflow_' + $index
        $predicates += "RTRIM([$candidate])=$parameterName"
        $values += [pscustomobject]@{ name=$parameterName; value=$pair.value; label=$pair.label }
        $index++
        break
      }
    }
  }
  if ($predicates.Count -eq 0) {
    return [pscustomobject]@{ table=$tableName; status='unknown'; columns=@($columns | Select-Object -First 100); rows=@(); rowCount=0; reason='No supported workflow target column was present' }
  }
  $selectedColumns = @($columns | Select-Object -First 100)
  $quotedColumns = ($selectedColumns | ForEach-Object { '[' + $_.Replace(']',']]') + ']' }) -join ', '
  $escapedTable = '[' + $tableName.Replace(']',']]') + ']'
  $command = $connection.CreateCommand()
  $command.CommandText = "SELECT TOP ($maxRows) $quotedColumns FROM [dbo].$escapedTable WHERE " + ($predicates -join ' OR ')
  foreach ($value in $values) {
    $null = $command.Parameters.Add($value.name,[Data.SqlDbType]::NVarChar,512)
    $command.Parameters[$value.name].Value = $value.value
  }
  try {
    $reader = $command.ExecuteReader(); $rows = @()
    while ($reader.Read()) {
      $row = [ordered]@{}
      for ($i=0; $i -lt $reader.FieldCount; $i++) { $row[$reader.GetName($i)] = Convert-Value $reader.GetValue($i) }
      $rows += [pscustomobject]$row
    }
    $reader.Close()
    return [pscustomobject]@{ table=$tableName; status='ok'; columns=@($selectedColumns); rows=@($rows); rowCount=@($rows).Count; matchedBy=@($values | ForEach-Object { $_.label }); hasMore=(@($rows).Count -ge $maxRows) }
  } catch {
    return [pscustomobject]@{ table=$tableName; status='error'; columns=@($selectedColumns); rows=@(); rowCount=0; error=$_.Exception.Message }
  } finally { $command.Dispose() }
}

try {
  $connection.Open()
  $identityCommand = $connection.CreateCommand()
  $identityCommand.CommandText = 'SELECT SUSER_SNAME(), ORIGINAL_LOGIN(), DB_NAME(), @@SERVERNAME'
  $identityReader = $identityCommand.ExecuteReader()
  $identity = [ordered]@{ loginName=$null; originalLogin=$null; databaseName=$null; serverName=$null }
  if ($identityReader.Read()) {
    $identity.loginName = [string]$identityReader.GetValue(0)
    $identity.originalLogin = [string]$identityReader.GetValue(1)
    $identity.databaseName = [string]$identityReader.GetValue(2)
    $identity.serverName = [string]$identityReader.GetValue(3)
  }
  $identityReader.Close(); $identityCommand.Dispose()
  $tableResults = @()
  foreach ($tableName in $tableNames) {
    $tableResult = Read-Table $tableName
    $tableResults += $tableResult
    if ($tableName -eq 'WORKFLOW' -and $tableResult.status -eq 'ok') {
      $workflowRow = @($tableResult.rows | Select-Object -First 1)
      foreach ($candidate in @('WORKFLOW_ID','ID','IDENTITY','WORKFLOW','WORKFLOW_NUMBER')) {
        if ($workflowRow.Count -gt 0 -and $workflowRow[0].PSObject.Properties[$candidate] -and $workflowRow[0].PSObject.Properties[$candidate].Value) {
          $script:relayResolvedWorkflowId = [string]$workflowRow[0].PSObject.Properties[$candidate].Value
          break
        }
      }
    }
  }
  [pscustomobject]@{
    ok=$true
    target=$target
    connection=$identity
    tables=$tableResults
    limits=[pscustomobject]@{ maxRows=$maxRows; maxColumns=100; maxStringLength=2000 }
    startedAt=$startedAt.ToUniversalTime().ToString('o')
    finishedAt=(Get-Date).ToUniversalTime().ToString('o')
    readOnly=$true
    mutationAttempted=$false
  } | ConvertTo-Json -Depth 10 -Compress
} catch {
  [pscustomobject]@{ ok=$false; target=$target; connection=$null; tables=@(); error=$_.Exception.Message; readOnly=$true; mutationAttempted=$false } | ConvertTo-Json -Depth 8 -Compress
} finally {
  if ($connection.State -ne [Data.ConnectionState]::Closed) { $connection.Close() }
  $connection.Dispose()
}
`;
  const result = await runner.execPowerShell(script, 120000, options.execution ?? {});
  ensureRemoteSuccess(result);
  const output = (result.stdout || result.stderr).trim();
  if (!output) throw new Error("Workflow snapshot returned no JSON evidence");
  try { JSON.parse(output); } catch { throw new Error(`Workflow snapshot returned invalid JSON: ${output.slice(0, 1000)}`); }
  return output;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asRows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function tableResult(raw: Record<string, unknown>, name: string): Record<string, unknown> {
  return (Array.isArray(raw.tables) ? raw.tables : []).map(asRecord).find((item) => String(item.table ?? "").toLowerCase() === name.toLowerCase()) ?? { table: name, status: "missing", columns: [], rows: [], rowCount: 0 };
}

function value(row: Record<string, unknown>, candidates: string[]): unknown {
  const key = Object.keys(row).find((name) => candidates.some((candidate) => name.toLowerCase() === candidate.toLowerCase()));
  return key ? row[key] : undefined;
}

function text(row: Record<string, unknown>, candidates: string[]): string | undefined {
  const item = value(row, candidates);
  if (item === undefined || item === null) return undefined;
  const result = String(item).trim();
  return result || undefined;
}

function booleanValue(row: Record<string, unknown>, candidates: string[]): boolean | undefined {
  const item = value(row, candidates);
  if (item === undefined || item === null) return undefined;
  if (typeof item === "boolean") return item;
  return /^(true|yes|y|1)$/i.test(String(item).trim()) ? true : /^(false|no|n|0)$/i.test(String(item).trim()) ? false : undefined;
}

function compactAttributes(row: Record<string, unknown>, names: string[]): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  for (const name of names) {
    const item = value(row, [name]);
    if (item !== undefined && item !== null && String(item).trim() !== "") attributes[name] = item;
  }
  return attributes;
}

function normalizeWorkflow(raw: Record<string, unknown>): Record<string, unknown> | null {
  const row = asRows(tableResult(raw, "WORKFLOW").rows)[0];
  if (!row) return null;
  const id = text(row, ["WORKFLOW_ID", "ID", "IDENTITY", "WORKFLOW", "WORKFLOW_NUMBER"]);
  const name = text(row, ["WORKFLOW_NAME", "NAME", "DESCRIPTION", "TITLE"]);
  const mode = text(row, ["MODE", "WORKFLOW_MODE", "EXECUTION_MODE", "INTERACTIVE_MODE"]);
  return {
    id: id ?? null,
    name: name ?? null,
    version: text(row, ["WORKFLOW_VERSION", "VERSION", "REVISION"]) ?? null,
    mode: mode ?? null,
    entityContext: text(row, ["ENTITY_CONTEXT", "ENTITY", "CONTEXT_ENTITY"]) ?? null,
    callback: text(row, ["CALLBACK", "CALLBACK_METHOD", "ON_COMPLETE", "COMPLETION_CALLBACK"]) ?? null,
    returnProperty: text(row, ["RETURN_PROPERTY", "RETURN_PROP", "OUTPUT_PROPERTY"]) ?? null,
    attributes: compactAttributes(row, ["IS_ACTIVE", "ACTIVE", "DESCRIPTION", "OWNER", "UPDATED_AT"]),
  };
}

function normalizeNodes(raw: Record<string, unknown>): Array<Record<string, unknown>> {
  const rows = asRows(tableResult(raw, "WORKFLOW_NODE").rows);
  return rows.map((row, index) => {
    const id = text(row, ["WORKFLOW_NODE_ID", "NODE_ID", "IDENTITY", "ID"]) ?? `row:${index + 1}`;
    const name = text(row, ["NODE_NAME", "NAME", "DISPLAY_NAME", "TITLE"]);
    return {
      id,
      name: name ?? id,
      nodeType: text(row, ["NODE_TYPE", "TYPE", "CLASS_NAME", "CLASS", "NODE_CLASS"]) ?? null,
      mode: text(row, ["MODE", "EXECUTION_MODE", "INTERACTIVE_MODE"]) ?? null,
      entityContext: text(row, ["ENTITY_CONTEXT", "ENTITY", "CONTEXT_ENTITY"]) ?? null,
      callback: text(row, ["CALLBACK", "CALLBACK_METHOD", "ON_COMPLETE", "COMPLETION_CALLBACK"]) ?? null,
      returnProperty: text(row, ["RETURN_PROPERTY", "RETURN_PROP", "OUTPUT_PROPERTY"]) ?? null,
      isStart: booleanValue(row, ["IS_START", "START_NODE", "IS_INITIAL"]),
      isEnd: booleanValue(row, ["IS_END", "END_NODE", "IS_TERMINAL"]),
      attributes: compactAttributes(row, ["ORDER", "SEQUENCE", "ENABLED", "DESCRIPTION", "REGISTERED", "ASSEMBLY"]),
    };
  });
}

function normalizeLinks(raw: Record<string, unknown>): Array<Record<string, unknown>> {
  const rows = asRows(tableResult(raw, "WORKFLOW_LINK").rows);
  return rows.map((row, index) => ({
    id: text(row, ["WORKFLOW_LINK_ID", "LINK_ID", "IDENTITY", "ID"]) ?? `row:${index + 1}`,
    source: text(row, ["SOURCE_NODE_ID", "FROM_NODE_ID", "SOURCE", "FROM_NODE", "START_NODE_ID", "PARENT_NODE_ID"]) ?? null,
    target: text(row, ["TARGET_NODE_ID", "TO_NODE_ID", "TARGET", "TO_NODE", "END_NODE_ID", "CHILD_NODE_ID"]) ?? null,
    condition: text(row, ["CONDITION", "EXPRESSION", "RULE", "LINK_CONDITION"]) ?? null,
    label: text(row, ["LABEL", "NAME", "DESCRIPTION"]) ?? null,
  }));
}

function normalizeParameters(raw: Record<string, unknown>): Array<Record<string, unknown>> {
  return ["WORKFLOW_NODE_PARAMETER", "WORKFLOW_PARAMETER", "WORKFLOW_PROPERTY"]
    .flatMap((table) => asRows(tableResult(raw, table).rows).map((row, index) => ({
      sourceTable: table,
      id: text(row, ["WORKFLOW_NODE_PARAMETER_ID", "WORKFLOW_PARAMETER_ID", "PROPERTY_ID", "PARAMETER_ID", "IDENTITY", "ID"]) ?? `row:${index + 1}`,
      nodeId: text(row, ["WORKFLOW_NODE_ID", "NODE_ID", "NODE", "PARENT_NODE_ID"]) ?? null,
      name: text(row, ["PARAMETER_NAME", "PROPERTY_NAME", "NAME", "KEY"]) ?? null,
      type: text(row, ["PARAMETER_TYPE", "PROPERTY_TYPE", "DATA_TYPE", "TYPE"]) ?? null,
      value: text(row, ["PARAMETER_VALUE", "PROPERTY_VALUE", "VALUE", "DEFAULT_VALUE"]) ?? null,
    })));
}

function nodeKey(valueToNormalize: unknown): string {
  return String(valueToNormalize ?? "").trim().toLowerCase();
}

function compareObjects(actual: Record<string, unknown>, expected: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const field of fields) {
    const actualValue = actual[field] ?? null;
    const expectedValue = expected[field] ?? null;
    if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) changed[field] = { expected: expectedValue, actual: actualValue };
  }
  return changed;
}

function compareBaseline(snapshot: WorkflowInspectionEnvelope["snapshot"], baseline: SampleManagerWorkflowBaseline): Record<string, unknown> {
  const source = baseline.snapshot ?? baseline;
  const baselineNodes = source.nodes ?? [];
  const baselineLinks = source.links ?? [];
  const actualNodes = new Map(snapshot.nodes.map((item) => [nodeKey(item.id ?? item.name), item]));
  const expectedNodes = new Map(baselineNodes.map((item) => [nodeKey(item.id ?? item.name), item]));
  const addedNodes = [...actualNodes.keys()].filter((key) => !expectedNodes.has(key)).map((key) => actualNodes.get(key));
  const removedNodes = [...expectedNodes.keys()].filter((key) => !actualNodes.has(key)).map((key) => expectedNodes.get(key));
  const changedNodes = [...actualNodes.keys()].filter((key) => expectedNodes.has(key)).map((key) => {
    const changes = compareObjects(actualNodes.get(key)!, expectedNodes.get(key)!, ["name", "nodeType", "mode", "entityContext", "callback", "returnProperty"]);
    return Object.keys(changes).length > 0 ? { id: actualNodes.get(key)?.id ?? key, changes } : undefined;
  }).filter(Boolean);
  const edgeKey = (link: Record<string, unknown>) => `${nodeKey(link.source)}->${nodeKey(link.target)}:${nodeKey(link.condition)}`;
  const actualEdges = new Map(snapshot.links.map((item) => [edgeKey(item), item]));
  const expectedEdges = new Map(baselineLinks.map((item) => [edgeKey(item), item]));
  return {
    addedNodes,
    removedNodes,
    changedNodes,
    addedLinks: [...actualEdges.keys()].filter((key) => !expectedEdges.has(key)).map((key) => actualEdges.get(key)),
    removedLinks: [...expectedEdges.keys()].filter((key) => !actualEdges.has(key)).map((key) => expectedEdges.get(key)),
    workflow: compareObjects(snapshot.workflow ?? {}, source.workflow ?? {}, ["id", "name", "version", "mode", "entityContext", "callback", "returnProperty"]),
  };
}

function addViolation(violations: Array<Record<string, unknown>>, ruleId: string, severity: "error" | "warning", details: Record<string, unknown> = {}): void {
  violations.push({ ruleId, severity, ...details });
}

export function analyzeSampleManagerWorkflowSnapshot(rawValue: unknown, options: WorkflowAnalysisOptions): WorkflowInspectionEnvelope {
  const raw = asRecord(rawValue);
  const tables = Array.isArray(raw.tables) ? raw.tables.map(asRecord) : [];
  const snapshot = {
    workflow: normalizeWorkflow(raw),
    nodes: normalizeNodes(raw),
    links: normalizeLinks(raw),
    parameters: normalizeParameters(raw),
  };
  const facts: unknown[] = [];
  const inferences: unknown[] = [];
  const unknowns: string[] = [];
  const violations: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];
  const nodeIds = new Set<string>();
  const duplicateNodeIds = new Set<string>();
  for (const node of snapshot.nodes) {
    const key = nodeKey(node.id);
    if (nodeIds.has(key)) duplicateNodeIds.add(key);
    nodeIds.add(key);
  }
  for (const id of duplicateNodeIds) addViolation(violations, "duplicate_node_identity", "error", { nodeId: id });

  const adjacency = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const id of nodeIds) { adjacency.set(id, []); indegree.set(id, 0); }
  const orphanLinks: string[] = [];
  for (const link of snapshot.links) {
    const source = nodeKey(link.source);
    const target = nodeKey(link.target);
    if (!source || !target || !nodeIds.has(source) || !nodeIds.has(target)) {
      orphanLinks.push(String(link.id));
      addViolation(violations, "unresolved_link_endpoint", "error", { linkId: link.id, source: link.source, target: link.target });
      continue;
    }
    adjacency.get(source)!.push(target);
    indegree.set(target, (indegree.get(target) ?? 0) + 1);
  }
  const entryNodeIds = [...nodeIds].filter((id) => (indegree.get(id) ?? 0) === 0);
  const terminalNodeIds = [...nodeIds].filter((id) => (adjacency.get(id) ?? []).length === 0);
  const reachable = new Set<string>();
  const queue = [...entryNodeIds];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    queue.push(...(adjacency.get(current) ?? []));
  }
  const unreachableNodeIds = [...nodeIds].filter((id) => !reachable.has(id));
  for (const nodeId of unreachableNodeIds) addViolation(violations, "unreachable_node", "error", { nodeId });

  const cycleNodes = new Set<string>();
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) { cycleNodes.add(id); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const child of adjacency.get(id) ?? []) { visit(child); if (cycleNodes.has(child)) cycleNodes.add(id); }
    visiting.delete(id); visited.add(id);
  };
  for (const id of nodeIds) visit(id);
  if (cycleNodes.size > 0) addViolation(violations, "workflow_cycle", "error", { nodeIds: [...cycleNodes] });

  const nodeTable = tableResult(raw, "WORKFLOW_NODE");
  const nodeColumns = Array.isArray(nodeTable.columns) ? nodeTable.columns.map(String).map((item) => item.toLowerCase()) : [];
  for (const node of snapshot.nodes) {
    if (!node.nodeType) addViolation(violations, "node_type_missing", "warning", { nodeId: node.id, nodeName: node.name });
    const mode = String(node.mode ?? "").toLowerCase();
    if (mode.includes("interactive") && !node.entityContext) addViolation(violations, "interactive_entity_context_missing", "warning", { nodeId: node.id });
    if (nodeColumns.some((column) => ["callback", "callback_method", "on_complete", "completion_callback"].includes(column)) && !node.callback) addViolation(violations, "node_callback_missing", "warning", { nodeId: node.id });
    if (nodeColumns.some((column) => ["return_property", "return_prop", "output_property"].includes(column)) && !node.returnProperty) addViolation(violations, "node_return_property_missing", "warning", { nodeId: node.id });
    const registered = asRecord(node.attributes).REGISTERED;
    if (registered === false || registered === "0") addViolation(violations, "node_type_not_registered", "error", { nodeId: node.id, nodeType: node.nodeType });
  }

  if (!snapshot.workflow) unknowns.push("No WORKFLOW row matched the supplied target identity.");
  if (snapshot.nodes.length === 0) unknowns.push("No WORKFLOW_NODE rows matched the supplied target identity.");
  if (snapshot.links.length === 0 && snapshot.nodes.length > 1) unknowns.push("No WORKFLOW_LINK rows were returned; topology may be incomplete.");
  if (!tables.some((table) => String(table.table ?? "").toUpperCase() === "WORKFLOW_NODE_PARAMETER" && table.status === "ok") && !tables.some((table) => String(table.table ?? "").toUpperCase() === "WORKFLOW_PARAMETER" && table.status === "ok")) {
    unknowns.push("Workflow parameter table was not available; node parameter completeness cannot be proven.");
  }
  if (!snapshot.nodes.every((node) => node.nodeType)) unknowns.push("Node registration cannot be proven from the SQL snapshot; inspect the deployed assembly/type when required.");
  for (const table of tables) {
    const status = String(table.status ?? "unknown");
    facts.push({ table: table.table, status, columns: table.columns ?? [], rowCount: table.rowCount ?? 0 });
    if (status === "error") errors.push({ table: table.table, message: table.error ?? "Workflow table query failed" });
    if (status === "unknown" || status === "missing") unknowns.push(`${String(table.table)}: ${String(table.reason ?? "table or target column was not available")}`);
  }
  if (raw.ok === false) errors.push({ kind: "sql", message: raw.error ?? "Workflow snapshot query failed" });
  const topology = {
    nodeCount: snapshot.nodes.length,
    linkCount: snapshot.links.length,
    entryNodeIds,
    terminalNodeIds,
    unreachableNodeIds,
    orphanLinkIds: orphanLinks,
    cycleNodeIds: [...cycleNodes],
    graphComplete: orphanLinks.length === 0 && !(snapshot.nodes.length > 1 && snapshot.links.length === 0),
    bounded: true,
  };
  inferences.push({ statement: "Workflow topology was derived from normalized node and link identities", basis: topology });
  const comparisonBaseline = options.baseline;
  const diff = options.action === "compare" && comparisonBaseline ? compareBaseline(snapshot, comparisonBaseline) : undefined;
  if (diff) {
    const changed = ["addedNodes", "removedNodes", "changedNodes", "addedLinks", "removedLinks"].some((key) => Array.isArray(diff[key]) && (diff[key] as unknown[]).length > 0) || Object.keys(asRecord(diff.workflow)).length > 0;
    if (changed) addViolation(violations, "workflow_baseline_diff", "warning", { diff });
    inferences.push({ statement: "Current Workflow snapshot was compared with the caller-provided baseline", basis: { baselineNodeCount: comparisonBaseline?.snapshot?.nodes?.length ?? comparisonBaseline?.nodes?.length ?? 0, actualNodeCount: snapshot.nodes.length } });
  }
  const partial = Boolean(unknowns.length || errors.length || raw.ok === false || topology.graphComplete === false);
  return {
    action: options.action,
    target: { ...(options.target ?? {}), ...(asRecord(raw.target)) },
    snapshot,
    topology,
    facts,
    inferences,
    unknowns: [...new Set(unknowns)],
    violations,
    ...(diff ? { diff } : {}),
    evidence: [{ connection: raw.connection ?? null, tables: tables.map((table) => ({ table: table.table, status: table.status, rowCount: table.rowCount ?? 0 })) }],
    errors,
    queryMetadata: { queryId: options.queryId, startedAt: options.startedAt, finishedAt: options.finishedAt, readOnly: true, mutationAttempted: false, source: "one bounded version-aware Workflow snapshot" },
    partial,
  };
}
