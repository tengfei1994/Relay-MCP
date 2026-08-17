import { ensureRemoteSuccess, type RemoteExecutionOptions, type RemoteRunner } from "./remote-runner.js";
import { compactText } from "./output.js";
import { validateRelativeRemotePath, validateSampleManagerIdentifier } from "./shell-utils.js";

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function psArray(values: string[]): string {
  return `@(${values.map(psQuote).join(", ")})`;
}

export interface SampleManagerInstanceTarget {
  name: string;
  rootPath?: string;
  exePath?: string;
  formsPath?: string;
  formsBinPath?: string;
  solutionAssembliesPath?: string;
  logfilePath?: string;
  dataPath?: string;
  services?: Array<{ name: string }>;
}

export type SampleManagerInstanceRef = string | SampleManagerInstanceTarget;

function instanceName(instance: SampleManagerInstanceRef): string {
  return typeof instance === "string" ? instance : instance.name;
}

export function instancePaths(instance: SampleManagerInstanceRef) {
  const name = instanceName(instance);
  const configured = typeof instance === "string" ? undefined : instance;
  const root = configured?.rootPath || `C:\\Thermo\\SampleManager\\Server\\${name}`;
  const exe = configured?.exePath || `${root}\\Exe`;
  return {
    root,
    exe,
    formsBin: configured?.formsBinPath || `${exe}\\FormsBin`,
    forms: configured?.formsPath || `${exe}\\Forms`,
    logfile: configured?.logfilePath || `${root}\\Logfile`,
    data: configured?.dataPath || `${root}\\Data`,
    solutionAssemblies: configured?.solutionAssembliesPath || `${exe}\\SolutionAssemblies`,
    resourceIcon: `${root}\\Resource\\Icon`,
    relayBackups: `${root}\\RelayBackups`,
  };
}

export async function restartSampleManagerInstance(
  runner: RemoteRunner,
  instance: SampleManagerInstanceRef,
  execution: RemoteExecutionOptions = {}
): Promise<string> {
  const name = instanceName(instance);
  const suffix = name.toLowerCase();
  const paths = instancePaths(instance);
  const configuredServices = typeof instance === "string" ? [] : (instance.services ?? []).map((service) => service.name);
  const serviceNames = configuredServices.length > 0
    ? configuredServices
    : [`smptq${suffix}`, `smpSTAT${suffix}`, `smp${suffix}`, `SMDaemon${suffix}`];
  const script = `
$ErrorActionPreference = "Stop"
$instanceName = ${psQuote(name)}
$instanceRoot = ${psQuote(paths.root)}
$services = ${psArray(serviceNames)}
$existing = @($services | ForEach-Object { Get-Service $_ -ErrorAction SilentlyContinue })
$stopOrder = @($existing)
[array]::Reverse($stopOrder)
foreach ($svc in $stopOrder) {
  if ($svc.Status -ne 'Stopped') {
    Stop-Service -Name $svc.Name -Force -ErrorAction Stop
  }
}
$terminated = @()
Get-CimInstance Win32_Process -Filter "Name='SampleManagerServerHost.exe'" -ErrorAction SilentlyContinue |
  ForEach-Object {
    $belongsToInstance =
      ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($instanceRoot, [StringComparison]::OrdinalIgnoreCase)) -or
      ($_.CommandLine -and $_.CommandLine.IndexOf($instanceName, [StringComparison]::OrdinalIgnoreCase) -ge 0)
    if ($belongsToInstance) {
      $terminated += $_.ProcessId
      Invoke-CimMethod -InputObject $_ -MethodName Terminate -ErrorAction SilentlyContinue | Out-Null
    }
  }
foreach ($svc in $existing) {
  Start-Service -Name $svc.Name -ErrorAction Stop
}
[pscustomobject]@{
  instance = $instanceName
  configuredServices = $services
  terminatedProcessIds = $terminated
  services = @(Get-Service $services -ErrorAction SilentlyContinue | Select-Object Name, Status)
} | ConvertTo-Json -Depth 4 -Compress
`;
  const result = await runner.execPowerShell(script, 120000, execution);
  ensureRemoteSuccess(result);
  return compactText(`${result.stdout}\n${result.stderr}`.trim());
}

export async function clearFormCache(
  runner: RemoteRunner,
  instance: SampleManagerInstanceRef,
  formName: string,
  execution: RemoteExecutionOptions = {}
): Promise<string> {
  const paths = instancePaths(instance);
  const script = `
$ErrorActionPreference = "Stop"
$formsBin = ${psQuote(paths.formsBin)}
$formName = ${psQuote(formName)}
$expectedName = "$formName.binform"
$matched = @()
$removed = @()
if (-not (Test-Path -LiteralPath $formsBin -PathType Container)) {
  throw "FormsBin path does not exist: $formsBin"
}

$matched = @(
  Get-ChildItem -LiteralPath $formsBin -Recurse -File -ErrorAction Stop |
    Where-Object { $_.Name -ieq $expectedName } |
    ForEach-Object { $_.FullName }
)

foreach ($path in $matched) {
  Remove-Item -LiteralPath $path -Force -ErrorAction Stop
  if (Test-Path -LiteralPath $path -PathType Leaf) {
    throw "Cache file still exists after deletion: $path"
  }
  $removed += $path
}

$remaining = @(
  Get-ChildItem -LiteralPath $formsBin -Recurse -File -ErrorAction Stop |
    Where-Object { $_.Name -ieq $expectedName } |
    ForEach-Object { $_.FullName }
)
if ($remaining.Count -gt 0) {
  throw "Form cache cleanup incomplete. Remaining: $($remaining -join ', ')"
}

[pscustomobject]@{
  Instance = ${psQuote(instanceName(instance))}
  Form = $formName
  FormsBin = $formsBin
  ExpectedName = $expectedName
  Recursive = $true
  Matched = $matched
  Removed = $removed
  Remaining = $remaining
  Success = $true
} | ConvertTo-Json -Depth 4 -Compress
`;
  const result = await runner.execPowerShell(script, 30000, execution);
  ensureRemoteSuccess(result);
  return compactText(result.stdout || result.stderr);
}

export async function recentErrors(
  runner: RemoteRunner,
  instance: SampleManagerInstanceRef,
  minutes = 30,
  keywords: string[] = ["ERROR", "Exception", "NewPharma", "SampleManager"]
): Promise<string> {
  const paths = instancePaths(instance);
  const pattern = keywords.join("|");
  const script = `
$ErrorActionPreference = "Continue"
$since = (Get-Date).AddMinutes(-${minutes})
$until = Get-Date
$root = ${psQuote(paths.logfile)}
$pattern = ${psQuote(pattern)}
$matches = @()
$filesScanned = 0
$timestampPatterns = @(
  '(?<ts>\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?)',
  '(?<ts>\\d{1,2}/\\d{1,2}/\\d{4}\\s+\\d{1,2}:\\d{2}:\\d{2}(?:\\s*[AP]M)?)'
)
if (Test-Path -LiteralPath $root) {
  Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -ge $since -and ($_.Extension -in '.log','.txt','.lis' -or $_.Name -like '*log*') } |
    ForEach-Object {
      $filesScanned++
      Select-String -LiteralPath $_.FullName -Pattern $pattern -ErrorAction SilentlyContinue |
        ForEach-Object {
          $parsedTimestamp = $null
          foreach ($timestampPattern in $timestampPatterns) {
            $timestampMatch = [regex]::Match($_.Line, $timestampPattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
            if ($timestampMatch.Success) {
              $candidate = [datetimeoffset]::MinValue
              if ([datetimeoffset]::TryParse($timestampMatch.Groups['ts'].Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeLocal, [ref]$candidate) -or
                  [datetimeoffset]::TryParse($timestampMatch.Groups['ts'].Value, [ref]$candidate)) {
                $parsedTimestamp = $candidate
                break
              }
            }
          }
          if ($parsedTimestamp -and $parsedTimestamp.LocalDateTime -ge $since -and $parsedTimestamp.LocalDateTime -le $until) {
            $matches += [pscustomobject]@{
              timestamp = $parsedTimestamp.ToString('o')
              file = $_.Path
              line = $_.LineNumber
              text = $_.Line
            }
          }
        }
    }
}
[pscustomobject]@{
  requestedMinutes = ${minutes}
  searchedFrom = $since.ToString('o')
  searchedUntil = $until.ToString('o')
  filesScanned = $filesScanned
  matches = @($matches | Sort-Object timestamp | Select-Object -Last 80)
} | ConvertTo-Json -Depth 5 -Compress
`;
  const result = await runner.execPowerShell(script, 60000);
  ensureRemoteSuccess(result);
  return compactText(result.stdout || result.stderr);
}

export async function sampleManagerTableSchema(
  runner: RemoteRunner,
  database: string,
  table: string,
  databaseHost = "localhost"
): Promise<string> {
  if (!/^[A-Za-z0-9_.-]+$/.test(database)) {
    throw new Error(`Invalid database name: ${database}`);
  }
  if (!databaseHost.trim() || /[\r\n";]/.test(databaseHost)) {
    throw new Error(`Invalid database host: ${databaseHost}`);
  }
  const parts = table.split(".");
  if (parts.length > 2 || parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_$#@]*$/.test(part))) {
    throw new Error(`Invalid table name: ${table}`);
  }
  const schema = parts.length === 2 ? parts[0] : undefined;
  const tableName = parts.length === 2 ? parts[1] : parts[0];
  const script = `
$ErrorActionPreference = "Stop"
$cn = New-Object System.Data.SqlClient.SqlConnection "Server=${databaseHost};Database=${database};Integrated Security=True;TrustServerCertificate=True"
try {
  $cn.Open()
  $cmd = $cn.CreateCommand()
  $cmd.CommandText = @'
SELECT
  s.name AS schema_name,
  t.name AS table_name,
  t.object_id,
  c.column_id,
  c.name AS column_name,
  ty.name AS data_type,
  c.max_length,
  c.precision,
  c.scale,
  c.is_nullable,
  c.is_identity,
  c.is_computed,
  dc.definition AS default_definition,
  ISNULL(pk.key_ordinal, 0) AS primary_key_ordinal
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.columns c ON c.object_id = t.object_id
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
LEFT JOIN (
  SELECT ic.object_id, ic.column_id, ic.key_ordinal
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
  WHERE i.is_primary_key = 1
) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
WHERE t.name = @tableName
  AND (@schemaName IS NULL OR s.name = @schemaName)
ORDER BY s.name, t.name, c.column_id
'@
  $null = $cmd.Parameters.Add('@tableName', [Data.SqlDbType]::NVarChar, 128)
  $cmd.Parameters['@tableName'].Value = ${psQuote(tableName)}
  $null = $cmd.Parameters.Add('@schemaName', [Data.SqlDbType]::NVarChar, 128)
  $cmd.Parameters['@schemaName'].Value = ${schema ? psQuote(schema) : "[DBNull]::Value"}
  $reader = $cmd.ExecuteReader()
  $rows = @()
  while ($reader.Read()) {
    $rows += [pscustomobject]@{
      schema = [string]$reader['schema_name']
      table = [string]$reader['table_name']
      objectId = [int]$reader['object_id']
      ordinal = [int]$reader['column_id']
      column = [string]$reader['column_name']
      type = [string]$reader['data_type']
      maxLength = [int]$reader['max_length']
      precision = [int]$reader['precision']
      scale = [int]$reader['scale']
      nullable = [bool]$reader['is_nullable']
      identity = [bool]$reader['is_identity']
      computed = [bool]$reader['is_computed']
      default = if ($reader['default_definition'] -eq [DBNull]::Value) { $null } else { [string]$reader['default_definition'] }
      primaryKeyOrdinal = [int]$reader['primary_key_ordinal']
    }
  }
  $reader.Close()
  if ($rows.Count -eq 0) { throw "Table not found: ${table}" }
  [pscustomobject]@{
    database = ${psQuote(database)}
    requestedTable = ${psQuote(table)}
    qualifiedTable = "$($rows[0].schema).$($rows[0].table)"
    objectId = $rows[0].objectId
    columns = $rows
    mapping = [pscustomobject]@{
      physicalSchema = $rows[0].schema
      physicalTable = $rows[0].table
      note = "SQL Server physical mapping. SampleManager entity-definition mapping is version-specific and is not inferred."
    }
  } | ConvertTo-Json -Depth 6 -Compress
}
finally {
  if ($cn.State -ne [Data.ConnectionState]::Closed) { $cn.Close() }
  $cn.Dispose()
}
`;
  const result = await runner.execPowerShell(script, 60000);
  ensureRemoteSuccess(result);
  return compactText(result.stdout || result.stderr);
}

export interface SqlOptions {
  allowMutation?: boolean;
  maxRows?: number;
  offset?: number;
  includeResultSets?: boolean;
  parameters?: Record<string, SqlParameterValue>;
  identifiers?: Record<string, string>;
  databaseHost?: string;
}

export type SqlParameterValue = string | number | boolean | null;

export function quoteSqlIdentifier(value: string): string {
  const parts = value.split(".");
  if (parts.length === 0 || parts.some((part) => !part || !/^[A-Za-z_][A-Za-z0-9_$#@]*$/.test(part))) {
    throw new Error(`Invalid SQL identifier: ${value}`);
  }
  return parts.map((part) => `[${part.replace(/]/g, "]]")}]`).join(".");
}

export function renderSqlIdentifiers(sql: string, identifiers: Record<string, string> = {}): string {
  return sql.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (match, name: string) => {
    const value = identifiers[name];
    if (value === undefined) {
      throw new Error(`Missing SQL identifier value for ${match}`);
    }
    return quoteSqlIdentifier(value);
  });
}

function validateSqlParameters(parameters: Record<string, SqlParameterValue> = {}): Record<string, SqlParameterValue> {
  for (const [name, value] of Object.entries(parameters)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid SQL parameter name: ${name}`);
    }
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
      throw new Error(`Unsupported SQL parameter value for ${name}`);
    }
  }
  return parameters;
}

export function sqlContainsMutation(sql: string): boolean {
  const withoutCommentsOrStrings = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\r\n]*/g, " ")
    .replace(/N?'(?:''|[^'])*'/gi, " ")
    .replace(/"(?:""|[^"])*"/g, " ")
    .replace(/\[(?:\]\]|[^\]])*\]/g, " ");
  return /\b(insert|update|delete|merge|drop|alter|truncate|create|exec|execute|grant|revoke|deny)\b/i
    .test(withoutCommentsOrStrings);
}

export interface UnicodeCheckResult {
  ok: boolean;
  connection?: Record<string, unknown>;
  sqlServer?: Record<string, unknown>;
  powershell?: Record<string, unknown>;
  agentReceived?: Record<string, unknown>;
  encoding?: Record<string, string>;
  error?: string;
  sqlErrors?: unknown[];
}

/** Read-only, layered Unicode probe for diagnosing Windows PowerShell/SQL transport loss. */
export async function runUnicodeCheck(
  runner: RemoteRunner,
  database: string,
  databaseHost: string,
): Promise<UnicodeCheckResult & { rawAgentStdout: string }> {
  if (!/^[A-Za-z0-9_.-]+$/.test(database)) throw new Error(`Invalid database name: ${database}`);
  if (!databaseHost || /[\r\n";]/.test(databaseHost)) throw new Error(`Invalid database host: ${databaseHost}`);
  const sqlBase64 = Buffer.from("SELECT N'注射用曲妥珠单抗' AS TEST_TEXT;", "utf8").toString("base64");
  const script = `
$ErrorActionPreference = "Stop"
try {
  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  function Describe([string]$value) {
    if ($null -eq $value) { $value = "" }
    $utf8 = [System.Text.Encoding]::UTF8.GetBytes($value)
    $units = @($value.ToCharArray() | ForEach-Object { [int]$_ })
    $points = @()
    for ($i = 0; $i -lt $value.Length; $i++) {
      $code = [int]$value[$i]
      if ($code -ge 0xD800 -and $code -le 0xDBFF -and $i + 1 -lt $value.Length) {
        $code = [char]::ConvertToUtf32($value[$i], $value[$i + 1]); $i++
      }
      $points += $code
    }
    [ordered]@{
      value = $value
      length = $value.Length
      containsQuestionMark = $value.Contains([char]0x3F)
      utf8Base64 = [Convert]::ToBase64String($utf8)
      utf8Hex = (($utf8 | ForEach-Object { $_.ToString('X2') }) -join ' ')
      utf16CodeUnits = $units
      unicodeCodePoints = $points
      sha256Utf8 = ([Security.Cryptography.SHA256]::Create().ComputeHash($utf8) | ForEach-Object { $_.ToString('x2') }) -join ''
    }
  }
  $cs = "Server=${databaseHost};Database=${database};Integrated Security=True;TrustServerCertificate=True"
  $cn = New-Object System.Data.SqlClient.SqlConnection $cs
  $cn.Open()
  $identity = $cn.CreateCommand(); $identity.CommandText = "SELECT SUSER_SNAME(), ORIGINAL_LOGIN(), DB_NAME(), @@SERVERNAME"
  $ir = $identity.ExecuteReader(); $connection = [ordered]@{ loginName=$null; originalLogin=$null; databaseName=$null; serverName=$null }
  if ($ir.Read()) { $connection.loginName=[string]$ir.GetValue(0); $connection.originalLogin=[string]$ir.GetValue(1); $connection.databaseName=[string]$ir.GetValue(2); $connection.serverName=[string]$ir.GetValue(3) }; $ir.Close()
  $cmd = $cn.CreateCommand(); $cmd.CommandText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${sqlBase64}'))
  $reader = $cmd.ExecuteReader(); $value = if ($reader.Read()) { [string]$reader.GetValue(0) } else { "" }; $reader.Close(); $cn.Close()
  $probe = Describe $value
  [pscustomobject]@{ ok=$true; connection=$connection; sqlServer=$probe; powershell=$probe; encoding=[ordered]@{ sqlClientString='UTF-16 (.NET String)'; powershellOutput='UTF-8'; agentProcessStdout='UTF-8'; relayJson='UTF-8'; ui='not measured' } } | ConvertTo-Json -Depth 8 -Compress
} catch {
  [pscustomobject]@{ ok=$false; error=$_.Exception.Message } | ConvertTo-Json -Depth 8 -Compress
}
`;
  const result = await runner.execPowerShell(script, 120000);
  ensureRemoteSuccess(result);
  const rawAgentStdout = result.stdout || result.stderr;
  try {
    const parsed = JSON.parse(rawAgentStdout) as UnicodeCheckResult;
    return { ...parsed, agentReceived: parsed.powershell, rawAgentStdout };
  } catch (error) {
    throw new Error(`Unicode diagnostic returned invalid JSON: ${error instanceof Error ? error.message : String(error)}; raw=${compactText(rawAgentStdout, 2000)}`);
  }
}

export async function runSql(
  runner: RemoteRunner,
  database: string,
  sql: string,
  options: boolean | SqlOptions = false
): Promise<string> {
  const sqlOptions: SqlOptions = typeof options === "boolean" ? { allowMutation: options } : options;
  const allowMutation = sqlOptions.allowMutation ?? false;
  const maxRows = Math.max(1, Math.min(sqlOptions.maxRows ?? 100, 1000));
  const offset = Math.max(0, Math.trunc(sqlOptions.offset ?? 0));
  const includeResultSets = sqlOptions.includeResultSets ?? false;
  const databaseHost = (sqlOptions.databaseHost ?? "localhost").trim();
  const finalSql = renderSqlIdentifiers(sql, sqlOptions.identifiers);
  const parameters = validateSqlParameters(sqlOptions.parameters);
  if (!allowMutation && sqlContainsMutation(finalSql)) {
    throw new Error("SQL appears to mutate data. Pass allowMutation=true only inside an approved workflow.");
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(database)) {
    throw new Error(`Invalid database name: ${database}`);
  }
  if (!databaseHost || /[\r\n";]/.test(databaseHost)) {
    throw new Error(`Invalid database host: ${databaseHost}`);
  }
  const sqlBase64 = Buffer.from(finalSql, "utf8").toString("base64");
  const parametersBase64 = Buffer.from(JSON.stringify(parameters), "utf8").toString("base64");
  const script = `
$ErrorActionPreference = "Stop"
$cs = "Server=${databaseHost};Database=${database};Integrated Security=True;TrustServerCertificate=True"
$cn = New-Object System.Data.SqlClient.SqlConnection $cs
$cmd = $null
$parameters = $null
try {
  $cn.Open()
  $identityCommand = $cn.CreateCommand()
  $identityCommand.CommandText = "SELECT SUSER_SNAME(), ORIGINAL_LOGIN(), DB_NAME(), @@SERVERNAME"
  $identityReader = $identityCommand.ExecuteReader()
  $connectionInfo = [ordered]@{
    loginName = $null
    originalLogin = $null
    databaseName = $null
    serverName = $null
  }
  if ($identityReader.Read()) {
    $connectionInfo.loginName = [string]$identityReader.GetValue(0)
    $connectionInfo.originalLogin = [string]$identityReader.GetValue(1)
    $connectionInfo.databaseName = [string]$identityReader.GetValue(2)
    $connectionInfo.serverName = [string]$identityReader.GetValue(3)
  }
  $identityReader.Close()
  $cmd = $cn.CreateCommand()
  $cmd.CommandTimeout = 120
  $cmd.CommandText = [System.Text.Encoding]::UTF8.GetString(
    [System.Convert]::FromBase64String(${psQuote(sqlBase64)})
  )
  $parameters = ConvertFrom-Json ([System.Text.Encoding]::UTF8.GetString(
    [System.Convert]::FromBase64String(${psQuote(parametersBase64)})
  ))
  if ($parameters) {
    foreach ($property in $parameters.PSObject.Properties) {
      $value = if ($null -eq $property.Value) { [System.DBNull]::Value } else { $property.Value }
      [void]$cmd.Parameters.AddWithValue("@$($property.Name)", $value)
    }
  }
  $maxRows = ${maxRows}
  $offset = ${offset}
  $includeResultSets = ${includeResultSets ? "$true" : "$false"}
  $reader = $cmd.ExecuteReader()
  $resultSets = @()
  do {
    $schema = $reader.GetSchemaTable()
    if ($schema -eq $null) {
      continue
    }

    $columns = @()
    foreach ($schemaRow in $schema.Rows) {
      $columns += [string]$schemaRow.ColumnName
    }

    $rows = @()
    $rowCount = 0
    while ($reader.Read()) {
      $rowCount += 1
      if ($rowCount -gt $offset -and @($rows).Count -lt $maxRows) {
        $row = [ordered]@{}
        foreach ($column in $columns) {
          $value = $reader[$column]
          if ($value -is [System.DBNull]) {
            $row[$column] = $null
          }
          elseif ($value -is [System.DateTime]) {
            $row[$column] = $value.ToString("o")
          }
          else {
            $row[$column] = $value
          }
        }
        $rows += [pscustomobject]$row
      }
    }

    $resultSets += [pscustomobject]@{
      columns = $columns
      rows = @($rows)
      rowCount = $rowCount
      rowsReturned = @($rows).Count
      offset = $offset
      hasMore = $rowCount -gt ($offset + @($rows).Count)
      nextOffset = if ($rowCount -gt ($offset + @($rows).Count)) { $offset + @($rows).Count } else { $null }
      truncated = $offset -gt 0 -or $rowCount -gt ($offset + @($rows).Count)
    }
  } while ($reader.NextResult())

  $firstRows = @()
  $firstRowCount = 0
  $firstRowsReturned = 0
  $firstTruncated = $false
  $firstHasMore = $false
  $firstNextOffset = $null
  if (@($resultSets).Count -gt 0) {
    $firstRows = @($resultSets[0].rows)
    $firstRowCount = $resultSets[0].rowCount
    $firstRowsReturned = $resultSets[0].rowsReturned
    $firstTruncated = $resultSets[0].truncated
    $firstHasMore = $resultSets[0].hasMore
    $firstNextOffset = $resultSets[0].nextOffset
  }

  [pscustomobject]@{
    ok = $true
    connection = [pscustomobject]$connectionInfo
    sql = $cmd.CommandText
    parameters = $parameters
    rows = @($firstRows)
    rowCount = $firstRowCount
    rowsReturned = $firstRowsReturned
    offset = $offset
    hasMore = $firstHasMore
    nextOffset = $firstNextOffset
    truncated = $firstTruncated
    maxRows = $maxRows
    resultSetCount = @($resultSets).Count
    resultSets = if ($includeResultSets) { @($resultSets) } else { @() }
    recordsAffected = $reader.RecordsAffected
  } | ConvertTo-Json -Depth 8 -Compress
}

catch {
  $exception = $_.Exception
  $sqlException = $exception
  while ($sqlException -and -not ($sqlException -is [System.Data.SqlClient.SqlException])) {
    $sqlException = $sqlException.InnerException
  }
  $errors = @()
  if ($sqlException) {
    foreach ($item in $sqlException.Errors) {
      $errors += [pscustomobject]@{
        number = $item.Number
        state = $item.State
        class = $item.Class
        line = $item.LineNumber
        procedure = $item.Procedure
        message = $item.Message
      }
    }
  }
  [pscustomobject]@{
    ok = $false
    sql = if ($cmd) { $cmd.CommandText } else { $null }
    parameters = if ($parameters) { $parameters } else { @{} }
    error = $exception.Message
    sqlErrors = @($errors)
  } | ConvertTo-Json -Depth 8 -Compress
}
finally {
  $cn.Close()
}
`;
  const result = await runner.execPowerShell(script, 120000);
  ensureRemoteSuccess(result);
  return compactText(result.stdout || result.stderr);
}

export interface SqlChangeSetItem {
  idempotencyKey: string;
  operation: "insert" | "update" | "delete";
  table: string;
  values?: Record<string, SqlParameterValue>;
  where?: string;
  parameters?: Record<string, SqlParameterValue>;
}

/** Execute multiple SQL mutations in one transaction. The caller owns deployment/idempotency state. */
export async function runSqlChangeSet(
  runner: RemoteRunner,
  database: string,
  changes: SqlChangeSetItem[],
  options: { dryRun?: boolean; createBackup?: boolean; maxRows?: number; databaseHost?: string; verifySql?: string } = {}
): Promise<string> {
  if (changes.length === 0 || changes.length > 50) throw new Error("changes must contain between 1 and 50 items");
  if (!/^[A-Za-z0-9_.-]+$/.test(database)) throw new Error(`Invalid database name: ${database}`);
  const createBackup = options.createBackup ?? true;
  const dryRun = options.dryRun ?? true;
  const maxRows = Math.max(1, Math.min(options.maxRows ?? 100, 1000));
  const statements: string[] = ["SET NOCOUNT ON;", "SET XACT_ABORT ON;", "BEGIN TRY", "BEGIN TRANSACTION;"];
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 17);
  const allParameters: Record<string, SqlParameterValue> = {};
  const evidence: string[] = [];

  changes.forEach((change, index) => {
    const table = quoteSqlIdentifier(change.table);
    const where = (change.where ?? "").trim();
    if (change.operation !== "insert" && !where) throw new Error(`where is required for change '${change.idempotencyKey}'`);
    if (/[;]|\b(insert|update|delete|merge|drop|alter|truncate|create|exec|execute)\b/i.test(where)) throw new Error(`Invalid where for change '${change.idempotencyKey}'`);
    const values = validateSqlParameters(change.values ?? {});
    if (change.operation !== "delete" && Object.keys(values).length === 0) throw new Error(`values are required for change '${change.idempotencyKey}'`);
    const bindings = Object.entries(values).map(([column, value], valueIndex) => {
      const name = `relay_change_${index}_value_${valueIndex}`;
      allParameters[name] = value;
      return { column: quoteSqlIdentifier(column), parameter: `@${name}` };
    });
    for (const [name, value] of Object.entries(validateSqlParameters(change.parameters ?? {}))) allParameters[`relay_change_${index}_${name}`] = value;
    const renderedWhere = where.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => `@relay_change_${index}_${name}`);
    const key = change.idempotencyKey.replace(/'/g, "''");
    if (createBackup && change.operation !== "insert") {
      const backupName = `RELAY_BACKUP_${change.table.split(".").pop()!.replace(/[^A-Za-z0-9_]/g, "_")}_${stamp}_${index}`;
      statements.push(`SELECT * INTO ${quoteSqlIdentifier(`dbo.${backupName}`)} FROM ${table} WHERE ${renderedWhere};`);
    }
    if (change.operation !== "insert") statements.push(`SELECT '${key}' AS __relay_change, 'before' AS __relay_phase, * FROM ${table} WHERE ${renderedWhere};`);
    if (change.operation === "insert") {
      statements.push(`INSERT INTO ${table} (${bindings.map((item) => item.column).join(", ")}) VALUES (${bindings.map((item) => item.parameter).join(", ")});`);
    } else if (change.operation === "update") {
      statements.push(`UPDATE ${table} SET ${bindings.map((item) => `${item.column} = ${item.parameter}`).join(", ")} WHERE ${renderedWhere};`);
    } else {
      statements.push(`DELETE FROM ${table} WHERE ${renderedWhere};`);
    }
    statements.push(`SELECT '${key}' AS __relay_change, 'after' AS __relay_phase, @@ROWCOUNT AS affectedRows;`);
    evidence.push(`${change.idempotencyKey}:${change.operation}:${change.table}`);
  });
  if (options.verifySql?.trim()) statements.push(options.verifySql.trim());
  statements.push(dryRun ? "ROLLBACK TRANSACTION;" : "COMMIT TRANSACTION;", "END TRY", "BEGIN CATCH", "IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;", "THROW;", "END CATCH");
  const raw = await runSql(runner, database, statements.join("\n"), { allowMutation: true, maxRows, includeResultSets: true, parameters: allParameters, databaseHost: options.databaseHost });
  let result: unknown = raw;
  try { result = JSON.parse(raw); } catch {}
  if (!result || typeof result !== "object" || (result as Record<string, unknown>).ok === false) throw new Error(`Change Set SQL failed: ${compactText(raw, 4000)}`);
  return JSON.stringify({ ok: true, dryRun, transaction: dryRun ? "rolled_back" : "committed", changeCount: changes.length, changes: evidence, backupRequested: createBackup, verificationSqlProvided: Boolean(options.verifySql?.trim()), result });
}

export interface SqlMutationOptions {
  operation: "insert" | "update" | "delete";
  table: string;
  values?: Record<string, SqlParameterValue>;
  where?: string;
  parameters?: Record<string, SqlParameterValue>;
  dryRun?: boolean;
  createBackup?: boolean;
  maxRows?: number;
  databaseHost?: string;
}

export async function runSqlMutation(
  runner: RemoteRunner,
  database: string,
  options: SqlMutationOptions
): Promise<string> {
  const table = quoteSqlIdentifier(options.table);
  const values = validateSqlParameters(options.values ?? {});
  const where = (options.where ?? "").trim();
  const dryRun = options.dryRun ?? true;
  const createBackup = options.createBackup ?? true;
  if (options.operation !== "insert" && !where) {
    throw new Error("where is required for update and delete mutations");
  }
  if (/[;]|\b(insert|update|delete|merge|drop|alter|truncate|create|exec|execute)\b/i.test(where)) {
    throw new Error("where must be a single predicate without statements or mutation keywords");
  }
  if (options.operation !== "delete" && Object.keys(values).length === 0) {
    throw new Error(`values are required for ${options.operation}`);
  }

  const valueParameters: Record<string, SqlParameterValue> = {};
  const valueBindings = Object.entries(values).map(([column, value], index) => {
    const name = `relay_value_${index}`;
    valueParameters[name] = value;
    return { column: quoteSqlIdentifier(column), parameter: `@${name}` };
  });
  const parameters = { ...(options.parameters ?? {}), ...valueParameters };
  validateSqlParameters(parameters);

  const safeName = options.table.split(".").pop()!.replace(/[^A-Za-z0-9_]/g, "_");
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 17);
  const backupName = `RELAY_BACKUP_${safeName}_${stamp}`;
  const backupTable = quoteSqlIdentifier(`dbo.${backupName}`);
  const begin = "SET NOCOUNT ON;\nSET XACT_ABORT ON;\nBEGIN TRANSACTION;";
  const finish = dryRun ? "ROLLBACK TRANSACTION;" : "COMMIT TRANSACTION;";
  const before = options.operation === "insert"
    ? "SELECT 'before' AS __relay_phase WHERE 1 = 0;"
    : `SELECT 'before' AS __relay_phase, * FROM ${table} WHERE ${where};`;
  const backup = createBackup && options.operation !== "insert"
    ? `SELECT * INTO ${backupTable} FROM ${table} WHERE ${where};`
    : "";
  let mutation: string;
  if (options.operation === "update") {
    mutation = `UPDATE ${table} SET ${valueBindings.map((item) => `${item.column} = ${item.parameter}`).join(", ")} WHERE ${where};`;
  } else if (options.operation === "delete") {
    mutation = `DELETE FROM ${table} WHERE ${where};`;
  } else {
    mutation = `INSERT INTO ${table} (${valueBindings.map((item) => item.column).join(", ")}) VALUES (${valueBindings.map((item) => item.parameter).join(", ")});`;
  }
  const after = options.operation === "insert"
    ? "SELECT 'after' AS __relay_phase, @@ROWCOUNT AS affectedRows;"
    : `SELECT 'after' AS __relay_phase, * FROM ${table} WHERE ${where};`;
  const sql = [
    begin,
    before,
    backup,
    mutation,
    "SELECT @@ROWCOUNT AS affectedRows;",
    after,
    finish,
  ].filter(Boolean).join("\n");

  const raw = await runSql(runner, database, sql, {
    allowMutation: true,
    maxRows: options.maxRows ?? 100,
    includeResultSets: true,
    parameters,
    databaseHost: options.databaseHost,
  });
  let result: unknown = raw;
  try { result = JSON.parse(raw); } catch {}
  return compactText(JSON.stringify({
    operation: options.operation,
    table: options.table,
    dryRun,
    transaction: dryRun ? "rolled_back" : "committed",
    backupRequested: createBackup,
    backupTable: createBackup && options.operation !== "insert" ? `dbo.${backupName}` : undefined,
    backupPersisted: createBackup && options.operation !== "insert" && !dryRun,
    result,
  }, null, 2));
}

export interface SampleManagerCommandOptions {
  username: string;
  task: string;
  args?: string[];
  timeoutMs?: number;
  execution?: RemoteExecutionOptions;
}

export async function runSampleManagerCommand(
  runner: RemoteRunner,
  instance: SampleManagerInstanceRef,
  options: SampleManagerCommandOptions
): Promise<string> {
  const paths = instancePaths(instance);
  const name = instanceName(instance);
  const args = [
    "-instance",
    name,
    "-username",
    options.username,
    "-task",
    options.task,
    ...(options.args ?? []),
  ];
  const script = `
$ErrorActionPreference = "Stop"
$exe = ${psQuote(paths.exe)}
$command = Join-Path $exe "SampleManagerCommand.exe"
$arguments = ${psArray(args)}
Push-Location $exe
try {
  & $command @arguments
  if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}
finally {
  Pop-Location
}
`;
  const result = await runner.execPowerShell(script, options.timeoutMs ?? 120000, options.execution);
  ensureRemoteSuccess(result);
  return compactText(`${result.stdout}\n${result.stderr}`.trim());
}

export interface SampleManagerUtilityOptions {
  args?: string[];
  timeoutMs?: number;
  execution?: RemoteExecutionOptions;
}

const ALLOWED_SAMPLEMANAGER_UTILITIES = new Set([
  "CreateEntityDefinition.exe",
  "convert_table.exe",
  "FormImport.exe",
  "BuildFormDefinition.exe",
  "DeployPackageTask.exe",
]);

export async function runSampleManagerUtility(
  runner: RemoteRunner,
  instance: SampleManagerInstanceRef,
  utility: string,
  options: SampleManagerUtilityOptions = {}
): Promise<string> {
  if (!ALLOWED_SAMPLEMANAGER_UTILITIES.has(utility)) {
    throw new Error(`Unsupported SampleManager utility: ${utility}`);
  }
  const paths = instancePaths(instance);
  const script = `
$ErrorActionPreference = "Stop"
$exe = ${psQuote(paths.exe)}
$command = Join-Path $exe ${psQuote(utility)}
$arguments = ${psArray(options.args ?? [])}
if (-not (Test-Path -LiteralPath $command)) {
  throw "Utility not found: $command"
}
Push-Location $exe
try {
  & $command @arguments
  if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}
finally {
  Pop-Location
}
`;
  const result = await runner.execPowerShell(script, options.timeoutMs ?? 300000, options.execution);
  ensureRemoteSuccess(result);
  return compactText(`${result.stdout}\n${result.stderr}`.trim());
}

export async function createEntityDefinition(
  runner: RemoteRunner,
  instance: SampleManagerInstanceRef,
  timeoutMs = 600000,
  execution: RemoteExecutionOptions = {}
): Promise<string> {
  const name = instanceName(instance);
  validateSampleManagerIdentifier(name, "instance");
  return runSampleManagerUtility(runner, instance, "CreateEntityDefinition.exe", {
    args: ["-instance", name],
    timeoutMs,
    execution,
  });
}

export async function convertSampleManagerTables(
  runner: RemoteRunner,
  instance: SampleManagerInstanceRef,
  tables: string[],
  timeoutMs = 600000,
  execution: RemoteExecutionOptions = {}
): Promise<string> {
  if (tables.length === 0) throw new Error("At least one table is required");
  const name = instanceName(instance);
  const outputs: string[] = [];
  for (const table of tables) {
    validateSampleManagerIdentifier(table, "table name");
    execution.onStdout?.(`Converting table ${table}\n`);
    outputs.push(await runSampleManagerUtility(runner, instance, "convert_table.exe", {
      args: ["-mode", "convert", "-tables", table, "-noconfirm", "-instance", name],
      timeoutMs,
      execution,
    }));
  }
  return compactText(outputs.join("\n\n"));
}

export async function loadTableLoaderFile(
  runner: RemoteRunner,
  instance: SampleManagerInstanceRef,
  username: string,
  remoteCsvPath: string,
  mode = "overwrite_table",
  timeoutMs = 300000,
  execution: RemoteExecutionOptions = {}
): Promise<string> {
  validateSampleManagerIdentifier(mode, "table-loader mode");
  return runSampleManagerCommand(runner, instance, {
    username,
    task: "VGL",
    args: ["-report", "$table_loader", "-prompts", `(${remoteCsvPath},${mode})`],
    timeoutMs,
    execution,
  });
}

function buildToolDiscoveryPowerShell(): string {
  return `
function Get-RelayMsBuildCandidates {
  $items = New-Object 'System.Collections.Generic.List[object]'
  function ConvertTo-RelayFilePath([object]$value) {
    if ($null -eq $value) { return $null }
    if ($value -is [System.Array]) {
      foreach ($item in $value) {
        $candidate = ConvertTo-RelayFilePath $item
        if ($candidate) { return $candidate }
      }
      return $null
    }
    $text = ([string]$value).Trim().Trim('"')
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    try {
      if (-not [IO.Path]::IsPathRooted($text)) { return $null }
      return [IO.Path]::GetFullPath($text)
    } catch {
      return $null
    }
  }
  function Add-RelayMsBuildCandidate([string]$source, [object]$rawPath, [int]$priority) {
    $path = ConvertTo-RelayFilePath $rawPath
    if (-not $path) {
      $null = $relayMsBuildWarnings.Add("Skipped $source because its MSBuild path was invalid")
      return
    }
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return }
    if ($items.path -contains $path) { return }
    try {
      $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($path).FileVersion
    } catch {
      $null = $relayMsBuildWarnings.Add("Could not read MSBuild version for '$path': $($_.Exception.Message)")
      return
    }
    $null = $items.Add([pscustomobject]@{
      priority = $priority
      source = $source
      path = $path
      fileVersion = $version
      supportsModernCSharp = $source -like 'Visual Studio*'
    })
  }

  $programFilesX86 = [Environment]::GetFolderPath('ProgramFilesX86')
  $vswhere = Join-Path $programFilesX86 'Microsoft Visual Studio\\Installer\\vswhere.exe'
  if (Test-Path -LiteralPath $vswhere) {
    $vs2022 = & $vswhere -latest -products * -version '[17.0,18.0)' -requires Microsoft.Component.MSBuild -property installationPath
    if ($vs2022) {
      Add-RelayMsBuildCandidate 'Visual Studio 2022' (Join-Path $vs2022 'MSBuild\\Current\\Bin\\MSBuild.exe') 10
    }
    $vs2019 = & $vswhere -latest -products * -version '[16.0,17.0)' -requires Microsoft.Component.MSBuild -property installationPath
    if ($vs2019) {
      Add-RelayMsBuildCandidate 'Visual Studio 2019' (Join-Path $vs2019 'MSBuild\\Current\\Bin\\MSBuild.exe') 20
    }
  }

  $windows = [Environment]::GetFolderPath('Windows')
  Add-RelayMsBuildCandidate '.NET Framework 64-bit' (Join-Path $windows 'Microsoft.NET\\Framework64\\v4.0.30319\\MSBuild.exe') 30
  Add-RelayMsBuildCandidate '.NET Framework 32-bit' (Join-Path $windows 'Microsoft.NET\\Framework\\v4.0.30319\\MSBuild.exe') 40

  $pathCommand = Get-Command MSBuild.exe -ErrorAction SilentlyContinue
  if ($pathCommand) {
    Add-RelayMsBuildCandidate 'PATH' $pathCommand.Source 50
  }
  return @($items | Sort-Object priority)
}
`;
}

export async function discoverBuildTools(
  runner: RemoteRunner,
  execution: RemoteExecutionOptions = {}
): Promise<string> {
  const script = `
$ErrorActionPreference = "Stop"
$relayMsBuildWarnings = New-Object 'System.Collections.Generic.List[string]'
${buildToolDiscoveryPowerShell()}
$tools = @(Get-RelayMsBuildCandidates)
[pscustomobject]@{
  selected = if ($tools.Count -gt 0) { $tools[0] } else { $null }
  candidates = $tools
  warnings = @($relayMsBuildWarnings)
  recommendation = if ($tools.Count -eq 0) {
    "Install Visual Studio Build Tools 2022 with MSBuild."
  } elseif (-not $tools[0].supportsModernCSharp) {
    "Only legacy Framework MSBuild was found; modern LangVersion projects may fail."
  } else {
    "Use the selected Visual Studio MSBuild."
  }
} | ConvertTo-Json -Depth 5 -Compress
`;
  const result = await runner.execPowerShell(script, 60000, execution);
  ensureRemoteSuccess(result);
  return compactText(result.stdout || result.stderr);
}

export async function buildDotNetProject(
  runner: RemoteRunner,
  projectOrSolutionPath: string,
  configuration = "Release",
  msbuildPath?: string,
  timeoutMs = 600000,
  execution: RemoteExecutionOptions = {}
): Promise<string> {
  if (!/^[A-Za-z0-9_.-]+$/.test(configuration)) {
    throw new Error(`Invalid build configuration: ${configuration}`);
  }
  const script = `
$ErrorActionPreference = "Stop"
$project = ${psQuote(projectOrSolutionPath)}
if (-not (Test-Path -LiteralPath $project)) {
  throw "Project or solution not found: $project"
}
$msbuild = ${msbuildPath ? psQuote(msbuildPath) : "$null"}
if (-not $msbuild) {
  ${buildToolDiscoveryPowerShell()}
  $tools = @(Get-RelayMsBuildCandidates)
  if ($tools.Count -gt 0) { $msbuild = $tools[0].path }
}
if (-not $msbuild -or -not (Test-Path -LiteralPath $msbuild)) {
  throw "MSBuild.exe was not found; pass msbuildPath explicitly"
}
& $msbuild $project /t:Restore,Build /p:Configuration=${configuration} /nologo
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
`;
  const result = await runner.execPowerShell(script, timeoutMs, execution);
  ensureRemoteSuccess(result);
  return compactText(`${result.stdout}\n${result.stderr}`.trim());
}

export interface SampleManagerBuildProfile {
  kind?: "msbuild" | "dotnet" | "unknown";
  selectedPath?: string;
  selectedVersion?: string;
  targetFramework?: string;
}

export async function buildSampleManagerProject(
  runner: RemoteRunner,
  projectOrSolutionPath: string,
  configuration = "Release",
  explicitToolPath?: string,
  profile: SampleManagerBuildProfile = {},
  timeoutMs = 600000,
  execution: RemoteExecutionOptions = {}
): Promise<string> {
  if (profile.kind !== "dotnet") {
    return buildDotNetProject(
      runner,
      projectOrSolutionPath,
      configuration,
      explicitToolPath || profile.selectedPath,
      timeoutMs,
      execution
    );
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(configuration)) {
    throw new Error(`Invalid build configuration: ${configuration}`);
  }
  const script = `
$ErrorActionPreference = "Stop"
$project = ${psQuote(projectOrSolutionPath)}
if (-not (Test-Path -LiteralPath $project)) { throw "Project or solution not found: $project" }
$dotnet = ${psQuote(explicitToolPath || profile.selectedPath || "dotnet.exe")}
$arguments = @("build", $project, "--configuration", ${psQuote(configuration)}, "--nologo")
${profile.targetFramework ? `$arguments += @("--framework", ${psQuote(profile.targetFramework)})` : ""}
& $dotnet @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
`;
  const result = await runner.execPowerShell(script, timeoutMs, execution);
  ensureRemoteSuccess(result);
  return compactText(`${result.stdout}\n${result.stderr}`.trim());
}

export type SampleManagerDeployArea = "exe" | "solutionAssemblies" | "forms" | "resourceIcon" | "data";

export async function deploySampleManagerFile(
  runner: RemoteRunner,
  instance: SampleManagerInstanceRef,
  sourcePath: string,
  area: SampleManagerDeployArea,
  targetRelativePath: string,
  backup = true,
  skipIfUnchanged = true,
  execution: RemoteExecutionOptions = {}
): Promise<string> {
  validateRelativeRemotePath(targetRelativePath, "targetRelativePath");
  const paths = instancePaths(instance);
  const targetRoot = paths[area];
  const script = `
$ErrorActionPreference = "Stop"
$source = ${psQuote(sourcePath)}
$targetRoot = ${psQuote(targetRoot)}
$relative = ${psQuote(targetRelativePath)}
$target = Join-Path $targetRoot $relative
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
  throw "Deployment source file not found: $source"
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
$sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
$targetHash = if (Test-Path -LiteralPath $target -PathType Leaf) {
  (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
} else { $null }
if (${skipIfUnchanged ? "$true" : "$false"} -and $targetHash -and $sourceHash -eq $targetHash) {
  [pscustomobject]@{
    source = $source
    target = $target
    skipped = $true
    reason = "target_already_matches_source"
    sha256 = $sourceHash
    bytes = (Get-Item -LiteralPath $target).Length
  } | ConvertTo-Json -Compress
  exit 0
}
$backupPath = $null
if (${backup ? "$true" : "$false"} -and (Test-Path -LiteralPath $target -PathType Leaf)) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmssfff"
  $backupRoot = Join-Path ${psQuote(paths.relayBackups)} $stamp
  $backupPath = Join-Path $backupRoot $relative
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backupPath) | Out-Null
  Copy-Item -LiteralPath $target -Destination $backupPath -Force
}
Copy-Item -LiteralPath $source -Destination $target -Force
$finalHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
if ($finalHash -ne $sourceHash) {
  throw "Deployment verification failed: source SHA-256 $sourceHash, target SHA-256 $finalHash"
}
[pscustomobject]@{
  source = $source
  target = $target
  backup = $backupPath
  bytes = (Get-Item -LiteralPath $target).Length
  skipped = $false
  sha256 = $finalHash
} | ConvertTo-Json -Compress
`;
  const result = await runner.execPowerShell(script, 120000, execution);
  ensureRemoteSuccess(result);
  return compactText(result.stdout || result.stderr);
}

export async function restoreSampleManagerBackup(
  runner: RemoteRunner,
  backupPath: string,
  targetPath: string,
  execution: RemoteExecutionOptions = {}
): Promise<string> {
  const script = `
$ErrorActionPreference = "Stop"
$backup = ${psQuote(backupPath)}
$target = ${psQuote(targetPath)}
if (-not (Test-Path -LiteralPath $backup -PathType Leaf)) {
  throw "Backup file not found: $backup"
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
Copy-Item -LiteralPath $backup -Destination $target -Force
[pscustomobject]@{ backup=$backup; restoredTo=$target; bytes=(Get-Item -LiteralPath $target).Length } |
  ConvertTo-Json -Compress
`;
  const result = await runner.execPowerShell(script, 120000, execution);
  ensureRemoteSuccess(result);
  return compactText(result.stdout || result.stderr);
}
