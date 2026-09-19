import { ensureRemoteSuccess, type RemoteExecutionOptions, type RemoteRunner } from "./remote-runner.js";

export interface SampleManagerEntitySchemaOptions {
  database: string;
  databaseHost: string;
  table: string;
  entity?: string;
  execution?: RemoteExecutionOptions;
}

export interface SampleManagerEntitySchemaAnalysisOptions {
  queryId?: string;
  startedAt?: string;
  finishedAt?: string;
  instanceVersion?: string;
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function safeIdentifier(value: string, label: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(trimmed)) throw new Error(`Invalid ${label}: ${value}`);
  return trimmed;
}

/** Read physical SQL metadata and SampleManager logical field metadata in one bounded call. */
export async function runSampleManagerEntitySchema(
  runner: RemoteRunner,
  options: SampleManagerEntitySchemaOptions,
): Promise<string> {
  const database = safeIdentifier(options.database, "database name");
  const requestedTable = safeIdentifier(options.table, "table name").split(".").pop()!;
  const entity = options.entity?.trim();
  if (entity && (!entity.length || entity.length > 256 || /[\r\n\0]/.test(entity))) throw new Error("Invalid entity name");
  if (!options.databaseHost.trim() || /[\r\n";]/.test(options.databaseHost)) throw new Error(`Invalid database host: ${options.databaseHost}`);
  const script = `
$ErrorActionPreference = "Stop"
$requestedTable = ${psQuote(requestedTable)}
$requestedEntity = ${psQuote(entity ?? "")}
$connection = New-Object System.Data.SqlClient.SqlConnection ${psQuote(`Server=${options.databaseHost};Database=${database};Integrated Security=True;TrustServerCertificate=True`)}

function Convert-RelayValue($value) {
  if ($value -eq [DBNull]::Value) { return $null }
  if ($value -is [byte[]]) { return "<binary $($value.Length) bytes>" }
  if ($value -is [datetime]) { return $value.ToString('o') }
  $text = [string]$value
  if ($text.Length -gt 4000) { return $text.Substring(0,4000) + '...' }
  return $value
}

function Get-RelayColumns([string]$tableName) {
  $cmd = $connection.CreateCommand()
  $cmd.CommandText = "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='dbo' AND TABLE_NAME=@table ORDER BY ORDINAL_POSITION"
  $null = $cmd.Parameters.Add('@table',[Data.SqlDbType]::NVarChar,128); $cmd.Parameters['@table'].Value=$tableName
  $reader=$cmd.ExecuteReader(); $columns=@()
  while($reader.Read()){ $columns += [string]$reader[0] }
  $reader.Close(); $cmd.Dispose(); return @($columns)
}

function Read-RelayMetadata([string]$tableName,[string[]]$matchColumns,[string[]]$values) {
  $columns=@(Get-RelayColumns $tableName)
  if($columns.Count -eq 0){ return [pscustomobject]@{ table=$tableName; status='missing'; columns=@(); rows=@(); rowCount=0 } }
  $selected=@($columns | Select-Object -First 100)
  $predicates=@(); $parameters=@(); $index=0
  foreach($candidate in $matchColumns){
    if($columns -notcontains $candidate){ continue }
    foreach($value in $values){
      if([string]::IsNullOrWhiteSpace($value)){ continue }
      $name='@relay_meta_'+$index
      $predicates += "RTRIM(CONVERT(nvarchar(512),["+$candidate.Replace(']',']]')+"]))=$name"
      $parameters += [pscustomobject]@{ name=$name; value=$value }
      $index++
    }
  }
  if($predicates.Count -eq 0){ return [pscustomobject]@{ table=$tableName; status='unknown'; columns=$selected; rows=@(); rowCount=0; reason='No supported identity column was found' } }
  $quoted=($selected | ForEach-Object { '['+$_.Replace(']',']]')+']' }) -join ','
  $cmd=$connection.CreateCommand(); $cmd.CommandText="SELECT TOP (500) $quoted FROM [dbo].["+$tableName.Replace(']',']]')+"] WHERE "+($predicates -join ' OR ')
  foreach($parameter in $parameters){ $null=$cmd.Parameters.Add($parameter.name,[Data.SqlDbType]::NVarChar,512); $cmd.Parameters[$parameter.name].Value=$parameter.value }
  try {
    $reader=$cmd.ExecuteReader(); $rows=@()
    while($reader.Read()){
      $row=[ordered]@{}
      for($i=0;$i -lt $reader.FieldCount;$i++){ $row[$reader.GetName($i)]=Convert-RelayValue $reader.GetValue($i) }
      $rows += [pscustomobject]$row
    }
    $reader.Close(); return [pscustomobject]@{ table=$tableName; status='ok'; columns=$selected; rows=@($rows); rowCount=@($rows).Count; bounded=$true }
  } catch { return [pscustomobject]@{ table=$tableName; status='error'; columns=$selected; rows=@(); rowCount=0; error=$_.Exception.Message } }
  finally { $cmd.Dispose() }
}

try {
  $connection.Open()
  $identityCommand=$connection.CreateCommand(); $identityCommand.CommandText='SELECT SUSER_SNAME(), ORIGINAL_LOGIN(), DB_NAME(), @@SERVERNAME'
  $identityReader=$identityCommand.ExecuteReader(); $identity=[ordered]@{ loginName=$null; originalLogin=$null; databaseName=$null; serverName=$null }
  if($identityReader.Read()){
    $identity.loginName=[string]$identityReader.GetValue(0); $identity.originalLogin=[string]$identityReader.GetValue(1)
    $identity.databaseName=[string]$identityReader.GetValue(2); $identity.serverName=[string]$identityReader.GetValue(3)
  }
  $identityReader.Close(); $identityCommand.Dispose()

  $physicalCommand=$connection.CreateCommand()
  $physicalCommand.CommandText=@'
SELECT c.column_id AS ordinal, c.name AS columnName, t.name AS sqlType,
       c.max_length AS maxLength, c.precision, c.scale, c.is_nullable AS nullable,
       c.is_identity AS isIdentity, c.is_computed AS isComputed,
       CASE WHEN pk.column_id IS NULL THEN 0 ELSE 1 END AS isPrimaryKey,
       pk.key_ordinal AS primaryKeyOrdinal, dc.definition AS defaultDefinition
FROM sys.tables st
JOIN sys.schemas ss ON ss.schema_id=st.schema_id
JOIN sys.columns c ON c.object_id=st.object_id
JOIN sys.types t ON t.user_type_id=c.user_type_id
LEFT JOIN sys.default_constraints dc ON dc.parent_object_id=c.object_id AND dc.parent_column_id=c.column_id
LEFT JOIN (
  SELECT ic.object_id,ic.column_id,ic.key_ordinal
  FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id
  WHERE i.is_primary_key=1
) pk ON pk.object_id=c.object_id AND pk.column_id=c.column_id
WHERE ss.name='dbo' AND st.name=@table
ORDER BY c.column_id
'@
  $null=$physicalCommand.Parameters.Add('@table',[Data.SqlDbType]::NVarChar,128); $physicalCommand.Parameters['@table'].Value=$requestedTable
  $physicalReader=$physicalCommand.ExecuteReader(); $physical=@()
  while($physicalReader.Read()){
    $row=[ordered]@{}
    for($i=0;$i -lt $physicalReader.FieldCount;$i++){ $row[$physicalReader.GetName($i)]=Convert-RelayValue $physicalReader.GetValue($i) }
    $physical += [pscustomobject]$row
  }
  $physicalReader.Close(); $physicalCommand.Dispose()
  $values=@($requestedTable,$requestedEntity)
  $logical=Read-RelayMetadata 'SCHEMA_TABLE_FIELD' @('TABLE_ID','TABLE_NAME','TABLE','PARENT_TABLE') $values
  $entityDefinition=Read-RelayMetadata 'ENTITY_DEFINITION' @('TABLE_ID','TABLE_NAME','NAME','IDENTITY','ENTITY_NAME','FORM_ENTITY_DEFINITION') $values
  [pscustomobject]@{
    ok=$true; requestedTable=$requestedTable; requestedEntity=$requestedEntity; connection=[pscustomobject]$identity
    physical=@($physical); logical=$logical; entityDefinition=$entityDefinition
  } | ConvertTo-Json -Depth 9 -Compress
} catch {
  [pscustomobject]@{ ok=$false; requestedTable=$requestedTable; requestedEntity=$requestedEntity; error=$_.Exception.Message } | ConvertTo-Json -Depth 6 -Compress
} finally { $connection.Close() }
`;
  const result = await runner.execPowerShell(script, 120000, options.execution);
  ensureRemoteSuccess(result);
  const output = (result.stdout || result.stderr).trim();
  if (!output) throw new Error("SampleManager entity schema returned no JSON evidence");
  try { JSON.parse(output); } catch { throw new Error(`SampleManager entity schema returned invalid JSON: ${output.slice(0, 1000)}`); }
  return output;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function pick(record: Record<string, unknown>, names: string[]): unknown {
  const entries = new Map(Object.entries(record).map(([key, value]) => [key.toUpperCase(), value]));
  for (const name of names) if (entries.has(name)) return entries.get(name);
  return undefined;
}

export function analyzeSampleManagerEntitySchema(
  raw: Record<string, unknown>,
  options: SampleManagerEntitySchemaAnalysisOptions = {},
) {
  const physical = Array.isArray(raw.physical) ? raw.physical.map(asRecord) : [];
  const logicalSource = asRecord(raw.logical);
  const logicalRows = Array.isArray(logicalSource.rows) ? logicalSource.rows.map(asRecord) : [];
  const entitySource = asRecord(raw.entityDefinition);
  const entityDefinitions = Array.isArray(entitySource.rows) ? entitySource.rows.map(asRecord) : [];
  const physicalNames = new Set(physical.map((column) => String(column.columnName ?? "").trim().toUpperCase()).filter(Boolean));
  const logical = logicalRows.map((row) => {
    const propertyName = pick(row, ["PROPERTY_NAME", "IDENTITY", "FIELD_NAME", "NAME"]);
    const columnName = pick(row, ["COLUMN_NAME", "DATABASE_FIELD", "IDENTITY", "FIELD_NAME"]);
    const logicalType = pick(row, ["FIELD_TYPE", "DATA_TYPE", "PROPERTY_TYPE", "TYPE"]);
    const normalizedType = String(logicalType ?? "unknown");
    const packedDecimal = normalizedType.toLowerCase() === "packeddecimal" || normalizedType.toLowerCase().includes("packed_decimal");
    return {
      propertyName: propertyName ?? null,
      columnName: columnName ?? null,
      logicalType: logicalType ?? null,
      physicalColumnPresent: columnName ? physicalNames.has(String(columnName).trim().toUpperCase()) : null,
      phraseType: pick(row, ["PHRASE_TYPE"]) ?? null,
      promptType: pick(row, ["PROMPT_TYPE"]) ?? null,
      linksTo: pick(row, ["LINKS_TO", "LINK_TABLE", "ENTITY_DEFINITION"]) ?? null,
      serialization: packedDecimal
        ? { kind: "PackedDecimal", sqlConversionIsSufficient: false, requiresRuntimeValidation: true, ruleSource: "SampleManager logical metadata" }
        : { kind: normalizedType, sqlConversionIsSufficient: null, requiresRuntimeValidation: false, ruleSource: "SCHEMA_TABLE_FIELD" },
      raw: row,
    };
  });
  const unknowns: string[] = [];
  const errors: Array<Record<string, unknown>> = [];
  if (physical.length === 0) unknowns.push("The requested physical dbo table was not found or has no columns.");
  if (logicalSource.status !== "ok") unknowns.push("SCHEMA_TABLE_FIELD metadata was unavailable; SampleManager logical types and serialization contracts cannot be proven.");
  if (logicalRows.length === 0) unknowns.push("No SampleManager logical field metadata matched the requested table/entity.");
  if (entitySource.status !== "ok" || entityDefinitions.length === 0) unknowns.push("No ENTITY_DEFINITION mapping matched the requested table/entity.");
  if (raw.ok === false) errors.push({ kind: "sql", message: raw.error ?? "Entity schema query failed" });
  if (logicalSource.status === "error") errors.push({ kind: "logical_metadata", message: logicalSource.error });
  if (entitySource.status === "error") errors.push({ kind: "entity_definition", message: entitySource.error });
  return {
    target: { table: raw.requestedTable ?? null, entity: raw.requestedEntity || null, instanceVersion: options.instanceVersion ?? null },
    physical: { columns: physical, rowCount: physical.length, source: "SQL Server sys.tables/sys.columns/sys.types" },
    logical: { fields: logical, rowCount: logical.length, source: "SampleManager SCHEMA_TABLE_FIELD" },
    entityDefinitions,
    facts: [
      { statement: "Physical SQL columns were read from SQL Server catalog metadata", count: physical.length },
      { statement: "Logical fields were read from SampleManager schema metadata", count: logical.length },
    ],
    inferences: [],
    unknowns,
    evidence: [{ connection: raw.connection ?? null, logicalMetadataStatus: logicalSource.status ?? "unknown", entityDefinitionStatus: entitySource.status ?? "unknown" }],
    errors,
    queryMetadata: { queryId: options.queryId, startedAt: options.startedAt, finishedAt: options.finishedAt, readOnly: true, mutationAttempted: false, source: "physical and logical SampleManager schema inspection" },
    partial: unknowns.length > 0 || errors.length > 0,
  };
}
