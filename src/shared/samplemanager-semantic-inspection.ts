import { ensureRemoteSuccess, type RemoteExecutionOptions, type RemoteRunner } from "./remote-runner.js";

export const SAMPLEMANAGER_INSPECTION_ENTRY_POINTS = [
  "execution_readiness",
  "plate_batch_integrity",
  "test_result_lineage",
  "lab_method_definition",
] as const;

export type SampleManagerInspectionEntryPoint = typeof SAMPLEMANAGER_INSPECTION_ENTRY_POINTS[number];

export interface SampleManagerInspectionTarget {
  executionId?: string;
  labMethodId?: string;
  labMethodVersion?: string;
  plateId?: string;
  batchId?: string;
  batchTemplateId?: string;
  testNumber?: string;
  sampleNumber?: string;
}

export interface SampleManagerSemanticInspectionOptions {
  database: string;
  databaseHost: string;
  entryPoint: SampleManagerInspectionEntryPoint;
  target: SampleManagerInspectionTarget;
  maxRows?: number;
  execution?: RemoteExecutionOptions;
}

export interface SampleManagerPlatePlan {
  rows: number;
  columns: number;
  startPosition?: string;
  fillDirection?: "row-major" | "column-major";
  expectedEmptyPositions?: string[];
  expectedEntries?: Array<{
    name?: string;
    entryType?: string;
    count?: number;
    positions?: string[];
  }>;
}

export interface SemanticInspectionEnvelope {
  target: Record<string, unknown>;
  facts: unknown[];
  inferences: unknown[];
  unknowns: string[];
  violations: Array<Record<string, unknown>>;
  evidence: unknown[];
  recommendedNextChecks: string[];
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

function safeTarget(target: SampleManagerInspectionTarget): SampleManagerInspectionTarget {
  return Object.fromEntries(Object.entries(target).map(([key, value]) => [key, safeValue(value, key)])) as SampleManagerInspectionTarget;
}

function tablesFor(entryPoint: SampleManagerInspectionEntryPoint): string[] {
  switch (entryPoint) {
    case "execution_readiness":
      return ["LAB_EXECUTION", "LAB_EXECUTION_STEP", "LAB_EXECUTION_STEP_PARAMETER", "LAB_METHOD", "LAB_METHOD_STEP", "LAB_METHOD_STEP_PARAMETER", "TEST", "SAMPLE", "PLATE", "BATCH", "BATCH_ENTRY", "WORKFLOW", "WORKFLOW_NODE", "WORKFLOW_LINK"];
    case "plate_batch_integrity":
      return ["PLATE", "BATCH", "BATCH_ENTRY", "TEST", "RESULT", "LIST_RESULT", "SAMPLE", "VERSIONED_ANALYSIS", "VERSIONED_COMPONENT"];
    case "test_result_lineage":
      return ["TEST", "SAMPLE", "RESULT", "LIST_RESULT", "PLATE", "BATCH_ENTRY", "VERSIONED_ANALYSIS", "VERSIONED_COMPONENT", "LAB_EXECUTION"];
    case "lab_method_definition":
      return ["LAB_METHOD", "LAB_METHOD_STEP", "LAB_METHOD_STEP_PARAMETER", "LAB_METHOD_PARAMETER", "LAB_METHOD_VARIABLE", "WORKFLOW", "WORKFLOW_NODE"];
  }
}

function serializeTarget(target: SampleManagerInspectionTarget): string {
  return JSON.stringify(target);
}

/** Run a bounded, schema-aware read of all tables needed by one semantic entry point. */
export async function runSampleManagerSemanticInspection(
  runner: RemoteRunner,
  options: SampleManagerSemanticInspectionOptions,
): Promise<string> {
  if (!/^[A-Za-z0-9_.-]+$/.test(options.database)) throw new Error(`Invalid database name: ${options.database}`);
  if (!options.databaseHost.trim() || /[\r\n";]/.test(options.databaseHost)) throw new Error(`Invalid database host: ${options.databaseHost}`);
  const target = safeTarget(options.target);
  if (!Object.values(target).some(Boolean)) throw new Error("At least one inspection target identity is required");
  const maxRows = Math.max(1, Math.min(Math.trunc(options.maxRows ?? 200), 500));
  const tables = tablesFor(options.entryPoint);
  const script = `
$ErrorActionPreference = "Stop"
$entryPoint = ${psQuote(options.entryPoint)}
$targetJson = ${psQuote(serializeTarget(target))}
$tableNames = @(${tables.map(psQuote).join(",")})
$maxRows = ${maxRows}
$cn = New-Object System.Data.SqlClient.SqlConnection ${psQuote(`Server=${options.databaseHost};Database=${options.database};Integrated Security=True;TrustServerCertificate=True`)}
function Convert-Value($value) {
  if ($value -eq [DBNull]::Value) { return $null }
  if ($value -is [byte[]]) { return "<binary $($value.Length) bytes>" }
  if ($value -is [datetime]) { return $value.ToString("o") }
  return $value
}
function Get-Columns([string]$tableName) {
  $command = $cn.CreateCommand()
  $command.CommandText = "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='dbo' AND TABLE_NAME=@table ORDER BY ORDINAL_POSITION"
  $null = $command.Parameters.Add('@table',[Data.SqlDbType]::NVarChar,128); $command.Parameters['@table'].Value=$tableName
  $reader = $command.ExecuteReader(); $columns=@()
  while($reader.Read()){ $columns += [string]$reader[0] }
  $reader.Close(); $command.Dispose(); return @($columns)
}
function Get-Pairs([string]$tableName) {
  $target = $targetJson | ConvertFrom-Json
  $pairs = @()
  switch ($tableName.ToUpperInvariant()) {
    'LAB_EXECUTION' {
      if ($target.executionId) { $pairs += [pscustomobject]@{ columns=@('LAB_EXECUTION_ID','IDENTITY','ID'); value=[string]$target.executionId; label='executionId' } }
      if ($target.labMethodId) { $pairs += [pscustomobject]@{ columns=@('LAB_METHOD_ID'); value=[string]$target.labMethodId; label='labMethodId' } }
    }
    'LAB_EXECUTION_STEP' { if ($target.executionId) { $pairs += [pscustomobject]@{ columns=@('LAB_EXECUTION_ID','EXECUTION_ID','LAB_EXECUTION'); value=[string]$target.executionId; label='executionId' } } }
    'LAB_EXECUTION_STEP_PARAMETER' { if ($target.executionId) { $pairs += [pscustomobject]@{ columns=@('LAB_EXECUTION_ID','EXECUTION_ID','LAB_EXECUTION'); value=[string]$target.executionId; label='executionId' } } }
    'LAB_METHOD' {
      if ($target.labMethodId) { $pairs += [pscustomobject]@{ columns=@('LAB_METHOD_ID','IDENTITY','ID'); value=[string]$target.labMethodId; label='labMethodId' } }
      if ($target.labMethodVersion) { $pairs += [pscustomobject]@{ columns=@('LAB_METHOD_VERSION','VERSION'); value=[string]$target.labMethodVersion; label='labMethodVersion' } }
    }
    'LAB_METHOD_STEP' { if ($target.labMethodId) { $pairs += [pscustomobject]@{ columns=@('LAB_METHOD_ID','METHOD_ID'); value=[string]$target.labMethodId; label='labMethodId' } }; if ($target.labMethodVersion) { $pairs += [pscustomobject]@{ columns=@('LAB_METHOD_VERSION','VERSION'); value=[string]$target.labMethodVersion; label='labMethodVersion' } } }
    'LAB_METHOD_STEP_PARAMETER' { if ($target.labMethodId) { $pairs += [pscustomobject]@{ columns=@('LAB_METHOD_ID','METHOD_ID'); value=[string]$target.labMethodId; label='labMethodId' } }; if ($target.labMethodVersion) { $pairs += [pscustomobject]@{ columns=@('LAB_METHOD_VERSION','VERSION'); value=[string]$target.labMethodVersion; label='labMethodVersion' } } }
    'LAB_METHOD_PARAMETER' { if ($target.labMethodId) { $pairs += [pscustomobject]@{ columns=@('LAB_METHOD_ID','METHOD_ID'); value=[string]$target.labMethodId; label='labMethodId' } }; if ($target.labMethodVersion) { $pairs += [pscustomobject]@{ columns=@('LAB_METHOD_VERSION','VERSION'); value=[string]$target.labMethodVersion; label='labMethodVersion' } } }
    'LAB_METHOD_VARIABLE' { if ($target.labMethodId) { $pairs += [pscustomobject]@{ columns=@('LAB_METHOD_ID','METHOD_ID'); value=[string]$target.labMethodId; label='labMethodId' } }; if ($target.labMethodVersion) { $pairs += [pscustomobject]@{ columns=@('LAB_METHOD_VERSION','VERSION'); value=[string]$target.labMethodVersion; label='labMethodVersion' } } }
    'PLATE' { if ($target.plateId) { $pairs += [pscustomobject]@{ columns=@('PLATE_ID','IDENTITY','ID'); value=[string]$target.plateId; label='plateId' } } }
    'BATCH' { if ($target.batchId) { $pairs += [pscustomobject]@{ columns=@('BATCH','BATCH_ID','IDENTITY','ID'); value=[string]$target.batchId; label='batchId' } }; if ($target.batchTemplateId) { $pairs += [pscustomobject]@{ columns=@('BATCH_TEMPLATE_ID','TEMPLATE_ID'); value=[string]$target.batchTemplateId; label='batchTemplateId' } } }
    'BATCH_ENTRY' { if ($target.plateId) { $pairs += [pscustomobject]@{ columns=@('PLATE_ID'); value=[string]$target.plateId; label='plateId' } }; if ($target.batchId) { $pairs += [pscustomobject]@{ columns=@('BATCH','BATCH_ID'); value=[string]$target.batchId; label='batchId' } } }
    'TEST' { if ($target.testNumber) { $pairs += [pscustomobject]@{ columns=@('TEST_NUMBER','IDENTITY','ID'); value=[string]$target.testNumber; label='testNumber' } }; if ($target.sampleNumber) { $pairs += [pscustomobject]@{ columns=@('SAMPLE_NUMBER','SAMPLE','SAMPLE_ID'); value=[string]$target.sampleNumber; label='sampleNumber' } }; if ($target.plateId) { $pairs += [pscustomobject]@{ columns=@('PLATE_ID'); value=[string]$target.plateId; label='plateId' } } }
    'RESULT' { if ($target.testNumber) { $pairs += [pscustomobject]@{ columns=@('TEST_NUMBER','TEST','TEST_ID'); value=[string]$target.testNumber; label='testNumber' } } }
    'LIST_RESULT' { if ($target.testNumber) { $pairs += [pscustomobject]@{ columns=@('TEST_NUMBER','TEST','TEST_ID'); value=[string]$target.testNumber; label='testNumber' } } }
  }
  return @($pairs)
}
function Read-Table([string]$tableName) {
  $columns = @(Get-Columns $tableName)
  if ($columns.Count -eq 0) { return [pscustomobject]@{ table=$tableName; status='missing'; columns=@(); rows=@(); rowCount=0; reason='Table not found in dbo' } }
  $pairs = @(Get-Pairs $tableName)
  $predicates=@(); $parameterValues=@(); $index=0
  foreach($pair in $pairs) {
    foreach($candidate in $pair.columns) {
      if ($columns -contains $candidate) {
        $parameterName = '@relay_target_' + $index
        $predicates += "RTRIM([$candidate])=$parameterName"
        $parameterValues += [pscustomobject]@{ name=$parameterName; value=$pair.value; label=$pair.label }
        $index++; break
      }
    }
  }
  if ($predicates.Count -eq 0) { return [pscustomobject]@{ table=$tableName; status='unknown'; columns=@($columns); rows=@(); rowCount=0; reason='No supported target column was present' } }
  $selectedColumns = @($columns | Select-Object -First 80)
  $quotedColumns = ($selectedColumns | ForEach-Object { '[' + $_.Replace(']',']]') + ']' }) -join ', '
  $command = $cn.CreateCommand()
  $command.CommandText = "SELECT TOP ($maxRows) $quotedColumns FROM [dbo].[$($tableName.Replace(']',']]'))] WHERE " + ($predicates -join ' OR ')
  foreach($parameterValue in $parameterValues) { $null = $command.Parameters.Add($parameterValue.name,[Data.SqlDbType]::NVarChar,512); $command.Parameters[$parameterValue.name].Value=$parameterValue.value }
  try {
    $reader=$command.ExecuteReader(); $rows=@()
    while($reader.Read()) { $row=[ordered]@{}; for($i=0;$i -lt $reader.FieldCount;$i++){ $row[$reader.GetName($i)]=Convert-Value $reader.GetValue($i) }; $rows += [pscustomobject]$row }
    $reader.Close()
    return [pscustomobject]@{ table=$tableName; status='ok'; columns=@($selectedColumns); rows=@($rows); rowCount=@($rows).Count; matchedBy=@($parameterValues | ForEach-Object { $_.label }) }
  } catch { return [pscustomobject]@{ table=$tableName; status='error'; columns=@($selectedColumns); rows=@(); rowCount=0; error=$_.Exception.Message } }
  finally { $command.Dispose() }
}
try {
  $cn.Open()
  $identityCommand=$cn.CreateCommand(); $identityCommand.CommandText='SELECT SUSER_SNAME(), ORIGINAL_LOGIN(), DB_NAME(), @@SERVERNAME'; $identityReader=$identityCommand.ExecuteReader(); $connection=[ordered]@{ loginName=$null; originalLogin=$null; databaseName=$null; serverName=$null }; if($identityReader.Read()){ $connection.loginName=[string]$identityReader.GetValue(0); $connection.originalLogin=[string]$identityReader.GetValue(1); $connection.databaseName=[string]$identityReader.GetValue(2); $connection.serverName=[string]$identityReader.GetValue(3) }; $identityReader.Close(); $identityCommand.Dispose()
  $tableResults=@(); foreach($tableName in $tableNames){ $tableResults += Read-Table $tableName }
  [pscustomobject]@{ ok=$true; entryPoint=$entryPoint; target=($targetJson | ConvertFrom-Json); connection=$connection; tables=@($tableResults); readOnly=$true; bounded=$true; maxRows=$maxRows } | ConvertTo-Json -Depth 10 -Compress
} catch { [pscustomobject]@{ ok=$false; entryPoint=$entryPoint; target=($targetJson | ConvertFrom-Json); readOnly=$true; error=$_.Exception.Message } | ConvertTo-Json -Depth 8 -Compress }
finally { if($cn.State -ne [Data.ConnectionState]::Closed){$cn.Close()}; $cn.Dispose() }
`;
  const result = await runner.execPowerShell(script, 120000, options.execution ?? {});
  ensureRemoteSuccess(result);
  const output = (result.stdout || result.stderr).trim();
  if (!output) throw new Error("Semantic inspection returned no JSON evidence");
  return output;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asRows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row)) : [];
}

function rowValue(row: Record<string, unknown>, candidates: string[]): unknown {
  const key = Object.keys(row).find((name) => candidates.some((candidate) => name.toLowerCase() === candidate.toLowerCase()));
  return key ? row[key] : undefined;
}

function rowText(row: Record<string, unknown>, candidates: string[]): string | undefined {
  const value = rowValue(row, candidates);
  return value === undefined || value === null ? undefined : String(value).trim();
}

function tableResult(raw: Record<string, unknown>, name: string): Record<string, unknown> {
  return (Array.isArray(raw.tables) ? raw.tables : []).map(asRecord).find((item) => String(item.table ?? "").toLowerCase() === name.toLowerCase()) ?? { table: name, status: "missing", rows: [], columns: [], rowCount: 0 };
}

function addDuplicateViolations(rows: Array<Record<string, unknown>>, fieldCandidates: string[], ruleId: string, violations: Array<Record<string, unknown>>): void {
  const seen = new Map<string, number>();
  for (const row of rows) {
    const value = rowText(row, fieldCandidates);
    if (!value) continue;
    seen.set(value.toLowerCase(), (seen.get(value.toLowerCase()) ?? 0) + 1);
  }
  for (const [value, count] of seen) if (count > 1) violations.push({ ruleId, severity: "error", value, count });
}

function analyzeLabMethod(raw: Record<string, unknown>, violations: Array<Record<string, unknown>>, unknowns: string[], inferences: unknown[]): void {
  const methodRows = asRows(tableResult(raw, "LAB_METHOD").rows);
  const stepRows = asRows(tableResult(raw, "LAB_METHOD_STEP").rows);
  const parameterRows = ["LAB_METHOD_STEP_PARAMETER", "LAB_METHOD_PARAMETER"].flatMap((name) => asRows(tableResult(raw, name).rows));
  const variableRows = asRows(tableResult(raw, "LAB_METHOD_VARIABLE").rows);
  if (!methodRows.length && !stepRows.length) unknowns.push("No Lab Method or Lab Method Step rows matched the supplied identity.");
  addDuplicateViolations(stepRows, ["LAB_METHOD_STEP_ID", "STEP_ID", "IDENTITY", "ID"], "duplicate_step_id", violations);
  addDuplicateViolations(stepRows, ["NAME", "STEP_NAME"], "duplicate_step_name", violations);
  addDuplicateViolations(parameterRows, ["PARAMETER_ID", "ID", "IDENTITY"], "duplicate_parameter_id", violations);
  addDuplicateViolations(parameterRows, ["PARAMETER_NAME", "NAME"], "duplicate_parameter_name", violations);
  addDuplicateViolations(variableRows, ["VARIABLE_ID", "ID", "IDENTITY"], "duplicate_variable_id", violations);
  const knownNames = new Set([...parameterRows, ...variableRows, ...stepRows].map((row) => rowText(row, ["NAME", "PARAMETER_NAME", "VARIABLE_NAME", "STEP_NAME"])).filter(Boolean).map((name) => name!.toLowerCase()));
  const sources: Array<[string, Record<string, unknown>]> = [
    ...methodRows.map((row) => ["LAB_METHOD", row] as [string, Record<string, unknown>]),
    ...stepRows.map((row) => ["LAB_METHOD_STEP", row] as [string, Record<string, unknown>]),
    ...parameterRows.map((row) => ["LAB_METHOD_PARAMETER", row] as [string, Record<string, unknown>]),
    ...variableRows.map((row) => ["LAB_METHOD_VARIABLE", row] as [string, Record<string, unknown>]),
  ];
  for (const [source, row] of sources) {
    const name = rowText(row, ["NAME", "PARAMETER_NAME", "VARIABLE_NAME", "STEP_NAME"]);
    if (name && /[^\x00-\x7F]/.test(name)) violations.push({ ruleId: "non_english_internal_name", severity: "warning", name });
    const type = rowText(row, ["PARAMETER_TYPE", "DATA_TYPE", "TYPE"]);
    const formula = rowText(row, ["FORMULA", "DEFAULT_EVALUATION", "EVALUATION"]);
    const defaultValue = rowText(row, ["DEFAULT_VALUE", "DEFAULT"]);
    const formulaOrDefault = formula ?? defaultValue;
    if (formulaOrDefault && /(?:\{\{|\$\{)[^}]+(?:\}\})/.test(formulaOrDefault)) {
      const placeholders = [...formulaOrDefault.matchAll(/(?:\{\{|\$\{)\s*([A-Za-z_][A-Za-z0-9_.]*)\s*(?:\}\}|\})/g)].map((match) => match[1].toLowerCase());
      for (const placeholder of placeholders) if (!knownNames.has(placeholder)) violations.push({ ruleId: "unresolved_placeholder", severity: "error", placeholder, source: name ?? "unknown" });
    }
    if (formula && /(?:empty|string\.empty|\"\")/i.test(formula) && type && /numeric|number|decimal|float|double|int/i.test(type)) {
      violations.push({ ruleId: "numeric_empty_string", severity: "warning", severityReason: "Version-specific runtime behavior must be confirmed", name: name ?? "unknown" });
    }
    if (type && !/bool/i.test(type) && (rowValue(row, ["TRUE_WORD", "FALSE_WORD"]) !== undefined)) violations.push({ ruleId: "non_boolean_true_false_words", severity: "warning", name: name ?? "unknown", type });
    const readOnly = rowValue(row, ["READ_ONLY", "IS_READ_ONLY", "READONLY"]);
    if (formula && readOnly !== undefined && ![true, 1, "1", "true", "yes", "y"].includes(readOnly as never)) {
      violations.push({ ruleId: "calculation_not_readonly", severity: "warning", name: name ?? "unknown" });
    }
    if (defaultValue !== undefined && type) {
      const numericType = /numeric|number|decimal|float|double|int/i.test(type);
      const booleanType = /bool/i.test(type);
      if (numericType && defaultValue !== "" && !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(defaultValue)) {
        violations.push({ ruleId: "default_value_type_mismatch", severity: "warning", name: name ?? "unknown", type, defaultValue });
      }
      if (booleanType && !/^(true|false|yes|no|0|1)$/i.test(defaultValue)) {
        violations.push({ ruleId: "default_value_type_mismatch", severity: "warning", name: name ?? "unknown", type, defaultValue });
      }
    }
    const maxLength = Number(rowValue(row, ["MAX_LENGTH", "LENGTH", "MAX_LEN"]));
    if (defaultValue !== undefined && Number.isInteger(maxLength) && maxLength >= 0 && defaultValue.length > maxLength) {
      violations.push({ ruleId: "default_value_length_exceeded", severity: "error", name: name ?? "unknown", maxLength, actualLength: defaultValue.length });
    }
    const instruction = rowValue(row, ["INSTRUCTION_BLOB", "INSTRUCTION", "INSTRUCTION_TEXT"]);
    const instructionColumnsPresent = Object.keys(row).some((key) => ["INSTRUCTION_BLOB", "INSTRUCTION", "INSTRUCTION_TEXT"].includes(key.toUpperCase()));
    if ((source === "LAB_METHOD_STEP" || instructionColumnsPresent) && (instruction === undefined || instruction === null || String(instruction).trim() === "")) violations.push({ ruleId: "instruction_missing", severity: "error", name: name ?? "unknown" });
    if (typeof instruction === "string" && /<binary|�|\?{3,}/.test(instruction)) violations.push({ ruleId: "instruction_encoding_unknown", severity: "warning", name: name ?? "unknown" });
    if (formula) {
      for (const reference of formula.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
        const qualified = `${reference[1]}.${reference[2]}`.toLowerCase();
        if (!knownNames.has(qualified) && !knownNames.has(reference[2].toLowerCase())) {
          violations.push({ ruleId: "cross_step_reference_unknown", severity: "warning", source: name ?? "unknown", reference: `${reference[1]}.${reference[2]}` });
        }
      }
    }
  }
  inferences.push({ statement: "Lab Method definition was inspected with duplicate identity and formula/reference checks", basis: { methodRows: methodRows.length, stepRows: stepRows.length, parameterRows: parameterRows.length, variableRows: variableRows.length } });
}

function parseWell(row: Record<string, unknown>): { key: string; row: number; column: number } | undefined {
  const rowNumber = Number(rowValue(row, ["PLATE_ROW_NUMBER", "ROW_NUMBER", "ROW"]));
  const columnNumber = Number(rowValue(row, ["PLATE_COLUMN_NUMBER", "COLUMN_NUMBER", "COLUMN"]));
  if (!Number.isInteger(rowNumber) || !Number.isInteger(columnNumber)) return undefined;
  return { key: `${rowNumber}:${columnNumber}`, row: rowNumber, column: columnNumber };
}

function parsePosition(value: string): { row: number; column: number } | undefined {
  const trimmed = value.trim().toUpperCase();
  const numeric = trimmed.match(/^(?:R)?(\d+)[,:]?(?:C)?(\d+)$/);
  if (numeric) return { row: Number(numeric[1]), column: Number(numeric[2]) };
  const alpha = trimmed.match(/^([A-Z]+)(\d+)$/);
  if (!alpha) return undefined;
  let column = 0;
  for (const char of alpha[1]) column = column * 26 + char.charCodeAt(0) - 64;
  return { row: Number(alpha[2]), column };
}

function wellLabel(well: { row: number; column: number }): string {
  return `R${well.row}C${well.column}`;
}

function analyzePlateBatch(raw: Record<string, unknown>, violations: Array<Record<string, unknown>>, unknowns: string[], inferences: unknown[]): void {
  const entries = asRows(tableResult(raw, "BATCH_ENTRY").rows);
  if (!entries.length) unknowns.push("No BATCH_ENTRY rows matched the supplied Plate/Batch identity.");
  const wells = entries.map(parseWell).filter((well): well is { key: string; row: number; column: number } => Boolean(well));
  const counts = new Map<string, number>();
  for (const well of wells) counts.set(well.key, (counts.get(well.key) ?? 0) + 1);
  for (const [position, count] of counts) if (count > 1) violations.push({ ruleId: "duplicate_well_position", severity: "error", position, count });
  for (const row of entries) {
    const test = rowText(row, ["TEST", "TEST_NUMBER", "TEST_ID"]);
    if (test === undefined || test === "" || /^0+$/.test(test)) violations.push({ ruleId: "batch_entry_test_missing", severity: "warning", position: parseWell(row)?.key ?? null });
  }
  inferences.push({ statement: "Plate/Batch integrity was assessed from matched BATCH_ENTRY rows", basis: { batchEntries: entries.length, parseableWells: wells.length } });
}

function analyzeLineage(raw: Record<string, unknown>, violations: Array<Record<string, unknown>>, unknowns: string[], inferences: unknown[]): void {
  const tests = asRows(tableResult(raw, "TEST").rows);
  const results = [...asRows(tableResult(raw, "RESULT").rows), ...asRows(tableResult(raw, "LIST_RESULT").rows)];
  if (!tests.length) unknowns.push("No TEST rows matched the supplied lineage identity.");
  const testIds = new Set(tests.map((row) => rowText(row, ["TEST_NUMBER", "IDENTITY", "ID"])).filter(Boolean));
  const resultIds = new Set(results.map((row) => rowText(row, ["TEST_NUMBER", "TEST", "TEST_ID"])).filter(Boolean));
  for (const testId of testIds) if (!resultIds.has(testId)) violations.push({ ruleId: "test_without_result", severity: "warning", testNumber: testId });
  for (const resultId of resultIds) if (!testIds.has(resultId)) violations.push({ ruleId: "orphan_result", severity: "error", testNumber: resultId });
  inferences.push({ statement: "Test/Result lineage was compared by preserved fixed-width identity values", basis: { tests: tests.length, results: results.length } });
}

function analyzeExecution(raw: Record<string, unknown>, violations: Array<Record<string, unknown>>, unknowns: string[], inferences: unknown[]): void {
  const executions = asRows(tableResult(raw, "LAB_EXECUTION").rows);
  const executionSteps = asRows(tableResult(raw, "LAB_EXECUTION_STEP").rows);
  const methodSteps = asRows(tableResult(raw, "LAB_METHOD_STEP").rows);
  if (!executions.length) unknowns.push("No LAB_EXECUTION row matched the supplied identity.");
  const executionMethod = executions[0] ? rowText(executions[0], ["LAB_METHOD_ID", "METHOD_ID"]) : undefined;
  if (executions.length && !executionMethod) violations.push({ ruleId: "execution_lab_method_missing", severity: "error" });
  if (executionSteps.length && methodSteps.length && executionSteps.length !== methodSteps.length) violations.push({ ruleId: "execution_step_count_mismatch", severity: "warning", executionSteps: executionSteps.length, methodSteps: methodSteps.length });
  inferences.push({ statement: "Execution readiness was assessed from Execution, Step, Method, Plate, Batch, and Workflow evidence", basis: { executions: executions.length, executionSteps: executionSteps.length, methodSteps: methodSteps.length } });
}

export function analyzeSampleManagerSemanticInspection(
  rawValue: unknown,
  options: { entryPoint: SampleManagerInspectionEntryPoint; queryId?: string; startedAt?: string; finishedAt?: string; plan?: SampleManagerPlatePlan },
): SemanticInspectionEnvelope {
  const raw = asRecord(rawValue);
  const facts: unknown[] = [];
  const inferences: unknown[] = [];
  const unknowns: string[] = [];
  const violations: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];
  const tables = Array.isArray(raw.tables) ? raw.tables.map(asRecord) : [];
  for (const table of tables) {
    const status = String(table.status ?? "unknown");
    facts.push({ table: table.table, status, columns: table.columns ?? [], rowCount: table.rowCount ?? 0, rows: table.rows ?? [] });
    if (status === "missing" || status === "unknown") unknowns.push(`${String(table.table)}: ${String(table.reason ?? "table or target column was not available")}`);
    if (status === "error") errors.push({ table: table.table, message: table.error ?? "Table query failed" });
  }
  if (raw.ok === false) errors.push({ kind: "sql", message: raw.error ?? "Semantic inspection query failed" });
  switch (options.entryPoint) {
    case "lab_method_definition": analyzeLabMethod(raw, violations, unknowns, inferences); break;
    case "plate_batch_integrity": analyzePlateBatch(raw, violations, unknowns, inferences); break;
    case "test_result_lineage": analyzeLineage(raw, violations, unknowns, inferences); break;
    case "execution_readiness": analyzeExecution(raw, violations, unknowns, inferences); break;
  }
  if (options.entryPoint === "plate_batch_integrity" && options.plan) {
    const entries = asRows(tableResult(raw, "BATCH_ENTRY").rows);
    const wells = entries.map(parseWell).filter((well): well is { key: string; row: number; column: number } => Boolean(well));
    const expectedEmpty = new Set((options.plan.expectedEmptyPositions ?? []).map((position) => position.toUpperCase()));
    for (const well of wells) {
      if (well.row < 1 || well.row > options.plan.rows || well.column < 1 || well.column > options.plan.columns) violations.push({ ruleId: "well_out_of_range", severity: "error", position: well.key, expected: `${options.plan.rows}x${options.plan.columns}` });
      const label = `R${well.row}C${well.column}`;
      if (expectedEmpty.has(label)) violations.push({ ruleId: "expected_empty_position_occupied", severity: "error", position: label });
    }
    if (options.plan.startPosition !== undefined) {
      const start = parsePosition(options.plan.startPosition);
      if (!start || start.row < 1 || start.row > options.plan.rows || start.column < 1 || start.column > options.plan.columns) {
        violations.push({ ruleId: "invalid_start_position", severity: "error", position: options.plan.startPosition, expected: `${options.plan.rows}x${options.plan.columns}` });
      } else if (wells.length > 0 && (wells[0].row !== start.row || wells[0].column !== start.column)) {
        violations.push({ ruleId: "start_position_mismatch", severity: "warning", expected: wellLabel(start), actual: wellLabel(wells[0]) });
      }
    }
    if (options.plan.fillDirection && wells.length > 1) {
      const expectedOrder = [...wells].sort((left, right) => options.plan!.fillDirection === "column-major"
        ? left.column - right.column || left.row - right.row
        : left.row - right.row || left.column - right.column);
      const actualOrder = wells.map((well) => well.key).join(",");
      const sortedOrder = expectedOrder.map((well) => well.key).join(",");
      if (actualOrder !== sortedOrder) violations.push({ ruleId: "fill_direction_mismatch", severity: "warning", expected: options.plan.fillDirection, actualOrder: wells.map(wellLabel).slice(0, 20) });
    }
    for (const expected of options.plan.expectedEntries ?? []) {
      const actualCount = entries.filter((entry) => !expected.entryType || rowText(entry, ["ENTRY_TYPE", "TYPE", "BATCH_ENTRY_TYPE"])?.toLowerCase() === expected.entryType.toLowerCase()).length;
      if (expected.count !== undefined && actualCount !== expected.count) violations.push({ ruleId: "entry_count_mismatch", severity: "error", entryType: expected.entryType ?? expected.name ?? "unnamed", expected: expected.count, actual: actualCount });
      if (expected.positions?.length) {
        const expectedPositions = new Set(expected.positions.map((position) => parsePosition(position)).filter((position): position is { row: number; column: number } => Boolean(position)).map(wellLabel));
        const actualPositions = new Set(entries
          .filter((entry) => !expected.entryType || rowText(entry, ["ENTRY_TYPE", "TYPE", "BATCH_ENTRY_TYPE"])?.toLowerCase() === expected.entryType.toLowerCase())
          .map(parseWell)
          .filter((well): well is { key: string; row: number; column: number } => Boolean(well))
          .map((well) => wellLabel(well)));
        const missing = [...expectedPositions].filter((position) => !actualPositions.has(position));
        const unexpected = [...actualPositions].filter((position) => !expectedPositions.has(position));
        if (missing.length || unexpected.length) violations.push({ ruleId: "entry_positions_mismatch", severity: "error", entryType: expected.entryType ?? expected.name ?? "unnamed", missing, unexpected });
      }
    }
    inferences.push({ statement: "Actual Plate/Batch entries were compared with the supplied layout plan", basis: { planRows: options.plan.rows, planColumns: options.plan.columns, actualWells: wells.length } });
  }
  const partial = Boolean(unknowns.length || errors.length || raw.ok === false);
  return {
    target: { entryPoint: options.entryPoint, ...(asRecord(raw.target)) },
    facts,
    inferences,
    unknowns: [...new Set(unknowns)],
    violations,
    evidence: [{ connection: raw.connection ?? null, tables: tables.map((table) => ({ table: table.table, status: table.status, rowCount: table.rowCount })) }],
    recommendedNextChecks: options.entryPoint === "lab_method_definition"
      ? ["Confirm Instruction Blob decoding and client refresh with a fresh Lab Execution."]
      : options.entryPoint === "plate_batch_integrity"
        ? ["Confirm Apply behavior and visible Plate layout with a controlled UI smoke test."]
        : options.entryPoint === "test_result_lineage"
          ? ["Verify Analysis Component and Result generation for the same fixed-width Test identities."]
          : ["Confirm Workflow callbacks and runtime entity context from logs or a fresh Execution."],
    errors,
    queryMetadata: { queryId: options.queryId, startedAt: options.startedAt, finishedAt: options.finishedAt, readOnly: true, mutationAttempted: false, source: "one bounded schema-aware remote inspection" },
    partial,
  };
}
