import { ensureRemoteSuccess, type RemoteExecutionOptions, type RemoteRunner } from "./remote-runner.js";

export interface SampleManagerEnhTarget {
  dashboardId?: string;
  folderId?: string;
  criteriaId?: string;
  formConfigId?: string;
  entity?: string;
  name?: string;
}

export interface SampleManagerEnhInspectionOptions {
  database: string;
  databaseHost: string;
  target: SampleManagerEnhTarget;
  maxRows?: number;
  execution?: RemoteExecutionOptions;
}

export interface SampleManagerEnhAnalysisOptions {
  mode: "dashboard" | "criteria" | "validate";
  target: SampleManagerEnhTarget;
  queryId?: string;
  startedAt?: string;
  finishedAt?: string;
  instanceVersion?: string;
}

function psQuote(value: string): string { return `'${value.replace(/'/g, "''")}'`; }

function safeTarget(target: SampleManagerEnhTarget): SampleManagerEnhTarget {
  const result: SampleManagerEnhTarget = {};
  for (const [key, value] of Object.entries(target)) {
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 256 || /[\r\n\0]/.test(trimmed)) throw new Error(`Invalid ENH target ${key}`);
    result[key as keyof SampleManagerEnhTarget] = trimmed;
  }
  if (!Object.values(result).some(Boolean)) throw new Error("At least one ENH dashboard, folder, criteria, form config, entity, or name target is required");
  return result;
}

/** Discover ENH tables and related rows without assuming one solution-kit schema. */
export async function runSampleManagerEnhInspection(
  runner: RemoteRunner,
  options: SampleManagerEnhInspectionOptions,
): Promise<string> {
  if (!/^[A-Za-z0-9_.-]+$/.test(options.database)) throw new Error(`Invalid database name: ${options.database}`);
  if (!options.databaseHost.trim() || /[\r\n";]/.test(options.databaseHost)) throw new Error(`Invalid database host: ${options.databaseHost}`);
  const target = safeTarget(options.target);
  const maxRows = Math.max(1, Math.min(Math.trunc(options.maxRows ?? 200), 500));
  const script = `
$ErrorActionPreference = "Stop"
$target = ${psQuote(JSON.stringify(target))} | ConvertFrom-Json
$maxRows = ${maxRows}
$connection = New-Object System.Data.SqlClient.SqlConnection ${psQuote(`Server=${options.databaseHost};Database=${options.database};Integrated Security=True;TrustServerCertificate=True`)}

function Convert-RelayValue($value) {
  if($value -eq [DBNull]::Value){ return $null }
  if($value -is [byte[]]){ return "<binary $($value.Length) bytes>" }
  if($value -is [datetime]){ return $value.ToString('o') }
  $text=[string]$value; if($text.Length -gt 4000){ return $text.Substring(0,4000)+'...' }; return $value
}
function Get-RelayColumns([string]$tableName){
  $cmd=$connection.CreateCommand(); $cmd.CommandText="SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='dbo' AND TABLE_NAME=@table ORDER BY ORDINAL_POSITION"
  $null=$cmd.Parameters.Add('@table',[Data.SqlDbType]::NVarChar,128); $cmd.Parameters['@table'].Value=$tableName
  $reader=$cmd.ExecuteReader(); $columns=@(); while($reader.Read()){ $columns += [string]$reader[0] }; $reader.Close(); $cmd.Dispose(); return @($columns)
}
function Get-RelayTargetValues {
  $values=@(); foreach($property in $target.PSObject.Properties){ if($property.Value){ $values += [string]$property.Value } }; return @($values | Select-Object -Unique)
}
function Test-RelaySearchColumn([string]$column){
  return $column -match '(?i)(ID|IDENTITY|NAME|ENTITY|FOLDER|DASHBOARD|CRITERIA|FORM|TEMPLATE|GRID|GROUP|PROCEDURE|ACTION|NAVIGATION)'
}
function Read-RelayTable([string]$tableName,[string[]]$values,[string]$phase){
  $columns=@(Get-RelayColumns $tableName)
  if($columns.Count -eq 0){ return [pscustomobject]@{ table=$tableName; role=$null; status='missing'; phase=$phase; columns=@(); rows=@(); rowCount=0 } }
  $selected=@($columns | Select-Object -First 100); $search=@($selected | Where-Object { Test-RelaySearchColumn $_ } | Select-Object -First 20)
  if($search.Count -eq 0 -or $values.Count -eq 0){ return [pscustomobject]@{ table=$tableName; status='unknown'; phase=$phase; columns=$selected; rows=@(); rowCount=0; reason='No supported target column/value' } }
  $predicates=@(); $parameters=@(); $index=0
  foreach($column in $search){ foreach($value in ($values | Select-Object -First 40)){
    $name='@relay_enh_'+$phase+'_'+$index; $predicates += "RTRIM(CONVERT(nvarchar(512),["+$column.Replace(']',']]')+"]))=$name"
    $parameters += [pscustomobject]@{ name=$name; value=$value }; $index++
  }}
  $quoted=($selected | ForEach-Object { '['+$_.Replace(']',']]')+']' }) -join ','
  $cmd=$connection.CreateCommand(); $cmd.CommandTimeout=120
  $cmd.CommandText="SELECT TOP ($maxRows) $quoted FROM [dbo].["+$tableName.Replace(']',']]')+"] WHERE "+($predicates -join ' OR ')
  foreach($parameter in $parameters){ $null=$cmd.Parameters.Add($parameter.name,[Data.SqlDbType]::NVarChar,512); $cmd.Parameters[$parameter.name].Value=$parameter.value }
  try {
    $reader=$cmd.ExecuteReader(); $rows=@()
    while($reader.Read()){ $row=[ordered]@{}; for($i=0;$i -lt $reader.FieldCount;$i++){ $row[$reader.GetName($i)]=Convert-RelayValue $reader.GetValue($i) }; $rows += [pscustomobject]$row }
    $reader.Close(); return [pscustomobject]@{ table=$tableName; status='ok'; phase=$phase; columns=$selected; rows=@($rows); rowCount=@($rows).Count; hasMore=(@($rows).Count -ge $maxRows) }
  } catch { return [pscustomobject]@{ table=$tableName; status='error'; phase=$phase; columns=$selected; rows=@(); rowCount=0; error=$_.Exception.Message } }
  finally { $cmd.Dispose() }
}
function Get-RelayTokens([object[]]$tableResults){
  $tokens=New-Object 'System.Collections.Generic.List[string]'
  foreach($table in $tableResults){ foreach($row in @($table.rows)){ foreach($property in $row.PSObject.Properties){
    if((Test-RelaySearchColumn $property.Name) -and $null -ne $property.Value){ $value=([string]$property.Value).Trim(); if($value -and $value.Length -le 256 -and -not $tokens.Contains($value)){ $tokens.Add($value) } }
    if($tokens.Count -ge 80){ return @($tokens) }
  }}}
  return @($tokens)
}
function Test-RelayFormats([object[]]$tableResults){
  $checks=@()
  foreach($table in $tableResults){ foreach($row in @($table.rows)){ foreach($property in $row.PSObject.Properties){
    if($property.Name -notmatch '(?i)(XML|JSON|CONFIG|SETTINGS|LAYOUT|DEFINITION)'){ continue }
    $value=[string]$property.Value; if([string]::IsNullOrWhiteSpace($value)){ continue }
    $kind=$null; $valid=$null; $error=$null
    if($value.TrimStart().StartsWith('<')){ $kind='xml'; try{ $null=[xml]$value; $valid=$true }catch{ $valid=$false; $error=$_.Exception.Message } }
    elseif($value.TrimStart().StartsWith('{') -or $value.TrimStart().StartsWith('[')){ $kind='json'; try{ $null=$value | ConvertFrom-Json; $valid=$true }catch{ $valid=$false; $error=$_.Exception.Message } }
    if($kind){ $checks += [pscustomobject]@{ table=$table.table; column=$property.Name; kind=$kind; valid=$valid; error=$error } }
  }}}
  return @($checks)
}
function Test-RelayFieldReferences([object[]]$tableResults){
  $checks=@(); $seen=New-Object 'System.Collections.Generic.HashSet[string]'
  $schemaColumns=@(Get-RelayColumns 'SCHEMA_TABLE_FIELD')
  $schemaTableColumn=@('TABLE_ID','TABLE_NAME','TABLE') | Where-Object { $schemaColumns -contains $_ } | Select-Object -First 1
  $schemaFieldColumn=@('IDENTITY','FIELD_NAME','COLUMN_NAME','PROPERTY_NAME') | Where-Object { $schemaColumns -contains $_ } | Select-Object -First 1
  $logicalPredicate = if($schemaTableColumn -and $schemaFieldColumn){
    " OR EXISTS(SELECT 1 FROM [dbo].[SCHEMA_TABLE_FIELD] WHERE CONVERT(nvarchar(512),["+$schemaTableColumn.Replace(']',']]')+"])=@table AND CONVERT(nvarchar(512),["+$schemaFieldColumn.Replace(']',']]')+"])=@field)"
  } else { '' }
  foreach($table in $tableResults){ foreach($row in @($table.rows)){
    $tableValue=$null; foreach($name in @('TABLE_NAME','TABLE_ID','ENTITY','ENTITY_NAME')){ if($row.PSObject.Properties[$name] -and $row.PSObject.Properties[$name].Value){ $tableValue=[string]$row.PSObject.Properties[$name].Value; break } }
    $fieldValue=$null; foreach($name in @('FIELD_NAME','COLUMN_NAME','PROPERTY_NAME')){ if($row.PSObject.Properties[$name] -and $row.PSObject.Properties[$name].Value){ $fieldValue=[string]$row.PSObject.Properties[$name].Value; break } }
    if(-not $tableValue -or -not $fieldValue){ continue }; $key=$tableValue+'|'+$fieldValue; if(-not $seen.Add($key)){ continue }
    $cmd=$connection.CreateCommand(); $cmd.CommandText="SELECT CASE WHEN EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='dbo' AND TABLE_NAME=@table AND COLUMN_NAME=@field)$logicalPredicate THEN 1 ELSE 0 END"
    $null=$cmd.Parameters.Add('@table',[Data.SqlDbType]::NVarChar,256); $cmd.Parameters['@table'].Value=$tableValue
    $null=$cmd.Parameters.Add('@field',[Data.SqlDbType]::NVarChar,256); $cmd.Parameters['@field'].Value=$fieldValue
    try{ $valid=[bool]$cmd.ExecuteScalar(); $checks += [pscustomobject]@{ sourceTable=$table.table; table=$tableValue; field=$fieldValue; valid=$valid } }
    catch{ $checks += [pscustomobject]@{ sourceTable=$table.table; table=$tableValue; field=$fieldValue; valid=$null; error=$_.Exception.Message } }
    finally{ $cmd.Dispose() }
    if($checks.Count -ge 100){ return @($checks) }
  }}
  return @($checks)
}

try {
  $connection.Open()
  $identityCommand=$connection.CreateCommand(); $identityCommand.CommandText='SELECT SUSER_SNAME(), ORIGINAL_LOGIN(), DB_NAME(), @@SERVERNAME'
  $identityReader=$identityCommand.ExecuteReader(); $identity=[ordered]@{ loginName=$null; originalLogin=$null; databaseName=$null; serverName=$null }
  if($identityReader.Read()){ $identity.loginName=[string]$identityReader[0]; $identity.originalLogin=[string]$identityReader[1]; $identity.databaseName=[string]$identityReader[2]; $identity.serverName=[string]$identityReader[3] }
  $identityReader.Close(); $identityCommand.Dispose()
  $tableCommand=$connection.CreateCommand(); $tableCommand.CommandText=@'
SELECT TOP (40) t.name
FROM sys.tables t
WHERE t.name LIKE 'ENH%'
   OR t.name LIKE '%DASHBOARD%' OR t.name LIKE '%EXPLORER%'
   OR t.name LIKE '%FORM_CONFIG%' OR t.name LIKE '%GRID_CONFIG%'
   OR t.name IN ('CRITERIA_SAVED','CRITERIA_CONDITION','CRITERIA_VARIABLE','CRITERIA_ORDER')
ORDER BY CASE WHEN t.name LIKE 'ENH%' THEN 0 ELSE 1 END,t.name
'@
  $tableReader=$tableCommand.ExecuteReader(); $tableNames=@(); while($tableReader.Read()){ $tableNames += [string]$tableReader[0] }; $tableReader.Close(); $tableCommand.Dispose()
  $direct=@(); $targetValues=@(Get-RelayTargetValues)
  foreach($tableName in $tableNames){ $direct += Read-RelayTable $tableName $targetValues 'direct' }
  $tokens=@(Get-RelayTokens $direct); $related=@()
  if($tokens.Count -gt 0){ foreach($tableName in $tableNames){
    $directTable=@($direct | Where-Object { $_.table -eq $tableName } | Select-Object -First 1)
    if($directTable.Count -gt 0 -and $directTable[0].rowCount -gt 0){ continue }
    $related += Read-RelayTable $tableName $tokens 'related'
  }}
  $tables=@($direct | Where-Object { $_.rowCount -gt 0 -or $_.status -eq 'error' }) + @($related | Where-Object { $_.rowCount -gt 0 -or $_.status -eq 'error' })
  [pscustomobject]@{
    ok=$true; target=$target; connection=[pscustomobject]$identity; discoveredTables=@($tableNames); tokens=@($tokens)
    tables=@($tables); formatChecks=@(Test-RelayFormats $tables); fieldReferences=@(Test-RelayFieldReferences $tables); bounded=$true; maxRows=$maxRows
  } | ConvertTo-Json -Depth 10 -Compress
} catch { [pscustomobject]@{ ok=$false; target=$target; error=$_.Exception.Message; tables=@() } | ConvertTo-Json -Depth 6 -Compress }
finally { $connection.Close() }
`;
  const result = await runner.execPowerShell(script, 120000, options.execution);
  ensureRemoteSuccess(result);
  const output = (result.stdout || result.stderr).trim();
  if (!output) throw new Error("ENH inspection returned no JSON evidence");
  try { JSON.parse(output); } catch { throw new Error(`ENH inspection returned invalid JSON: ${output.slice(0, 1000)}`); }
  return output;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function roleFor(table: string): string {
  const name = table.toUpperCase();
  if (name.includes("FOLDER")) return "folders";
  if (name.includes("CRITERIA")) return "criteria";
  if (name.includes("TEMPLATE")) return "templates";
  if (name.includes("FORM") && name.includes("CONFIG")) return "formConfigs";
  if (name.includes("COLUMN")) return "columns";
  if (name.includes("GROUP")) return "grouping";
  if (name.includes("GRID")) return "grids";
  if (name.includes("PROCEDURE")) return "procedures";
  if (name.includes("ACTION")) return "actions";
  if (name.includes("NAV") || name.includes("EXPLORER")) return "navigation";
  if (name.includes("DASHBOARD")) return "dashboards";
  return "other";
}

function pick(record: Record<string, unknown>, names: string[]): unknown {
  const entries = new Map(Object.entries(record).map(([key, value]) => [key.toUpperCase(), value]));
  for (const name of names) if (entries.has(name)) return entries.get(name);
  return undefined;
}

export function analyzeSampleManagerEnhInspection(raw: Record<string, unknown>, options: SampleManagerEnhAnalysisOptions) {
  const tables = Array.isArray(raw.tables) ? raw.tables.map(asRecord) : [];
  const components: Record<string, Array<Record<string, unknown>>> = {
    dashboards: [], folders: [], criteria: [], templates: [], formConfigs: [], grids: [], columns: [], grouping: [], procedures: [], actions: [], navigation: [], other: [],
  };
  const violations: Array<Record<string, unknown>> = [];
  const unknowns: string[] = [];
  const errors: Array<Record<string, unknown>> = [];
  const facts: Array<Record<string, unknown>> = [];
  const identities = new Set<string>();
  for (const table of tables) {
    const tableName = String(table.table ?? "unknown");
    const rows = Array.isArray(table.rows) ? table.rows.map(asRecord) : [];
    const role = roleFor(tableName);
    for (const row of rows) {
      components[role].push({ table: tableName, ...row });
      const identity = pick(row, ["ID", "IDENTITY", "NAME", `${tableName}_ID`]);
      if (identity !== undefined && identity !== null) identities.add(String(identity).trim().toUpperCase());
      else if (options.mode === "validate") violations.push({ ruleId: "entity_key_missing", severity: "warning", table: tableName, row });
    }
    const sequenceGroups = new Map<string, number>();
    for (const row of rows) {
      const sequence = pick(row, ["ORDER_NUM", "ORDER", "SEQUENCE", "SEQ", "POSITION"]);
      if (sequence === undefined || sequence === null) continue;
      const key = String(sequence);
      sequenceGroups.set(key, (sequenceGroups.get(key) ?? 0) + 1);
    }
    for (const [sequence, count] of sequenceGroups) if (count > 1) violations.push({ ruleId: "duplicate_sequence", severity: "error", table: tableName, sequence, count });
    facts.push({ table: tableName, role, status: table.status ?? "unknown", rowCount: rows.length, phase: table.phase ?? null });
    if (table.status === "error") errors.push({ kind: "table_query", table: tableName, message: table.error ?? "ENH table query failed" });
  }
  const formatChecks = Array.isArray(raw.formatChecks) ? raw.formatChecks.map(asRecord) : [];
  for (const check of formatChecks) if (check.valid === false) violations.push({ ruleId: "invalid_storage_format", severity: "error", ...check });
  const fieldReferences = Array.isArray(raw.fieldReferences) ? raw.fieldReferences.map(asRecord) : [];
  for (const reference of fieldReferences) {
    if (reference.valid === false) violations.push({ ruleId: "invalid_field_reference", severity: "error", ...reference });
    if (reference.valid === null || reference.valid === undefined) unknowns.push(`Could not validate field reference ${String(reference.table)}.${String(reference.field)}.`);
  }
  const referencePattern = /(ENH|DASHBOARD|FOLDER|CRITERIA|FORM_CONFIG|GRID|TEMPLATE|PROCEDURE|ACTION|NAVIGATION).*(ID|IDENTITY|NAME)$/i;
  for (const rows of Object.values(components)) for (const row of rows) for (const [column, value] of Object.entries(row)) {
    if (!referencePattern.test(column) || value === null || value === undefined || value === "") continue;
    const normalized = String(value).trim().toUpperCase();
    if (!identities.has(normalized)) violations.push({ ruleId: "unresolved_enh_reference", severity: "warning", table: row.table, column, value });
  }
  if (options.mode === "validate") {
    if (components.grids.length === 0) violations.push({ ruleId: "grid_definition_missing", severity: "warning" });
    if (components.templates.length === 0 && components.formConfigs.length === 0) violations.push({ ruleId: "template_or_form_config_missing", severity: "warning" });
  }
  const progressionOrder = ["dashboards", "folders", "criteria", "templates", "formConfigs", "grids", "actions", "navigation"];
  const progression = progressionOrder.map((role) => ({ role, count: components[role].length, present: components[role].length > 0 }));
  if (options.mode === "validate" && options.target.dashboardId) {
    for (const required of ["folders", "criteria", "grids", "actions", "navigation"]) {
      if (components[required].length === 0) violations.push({ ruleId: "configuration_progression_gap", severity: "warning", missingRole: required });
    }
  }
  if (components.criteria.length > 0) unknowns.push("Current-user variables and the final server-side criteria count require an explicit runtime user context; stored SQL rows alone cannot prove the effective filter.");
  if (raw.ok === false) errors.push({ kind: "sql", message: raw.error ?? "ENH inspection failed" });
  const componentCounts = Object.fromEntries(Object.entries(components).map(([key, rows]) => [key, rows.length]));
  return {
    target: { ...options.target, instanceVersion: options.instanceVersion ?? null },
    components,
    componentCounts,
    progression,
    criteriaExplanation: options.mode === "criteria"
      ? {
          storedCriteriaRows: components.criteria,
          originalConditionCount: components.criteria.length,
          currentUserVariablesResolved: false,
          effectiveCondition: null,
          effectiveRecordCount: null,
        }
      : undefined,
    facts,
    inferences: [{ statement: "ENH component roles were classified from discovered table names and bounded relationship tokens", basis: { discoveredTableCount: Array.isArray(raw.discoveredTables) ? raw.discoveredTables.length : 0, tokenCount: Array.isArray(raw.tokens) ? raw.tokens.length : 0 } }],
    unknowns: [...new Set(unknowns)],
    violations,
    evidence: [{ connection: raw.connection ?? null, discoveredTables: raw.discoveredTables ?? [], fieldReferences, formatChecks, bounded: raw.bounded ?? true }],
    errors,
    queryMetadata: { queryId: options.queryId, startedAt: options.startedAt, finishedAt: options.finishedAt, readOnly: true, mutationAttempted: false, mode: options.mode, source: "one bounded version-aware ENH discovery and relationship inspection" },
    partial: unknowns.length > 0 || errors.length > 0,
  };
}
