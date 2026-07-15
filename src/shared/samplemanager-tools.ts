import type { RemoteExecutionOptions, RemoteRunner } from "./remote-runner.js";
import { compactText } from "./output.js";
import { validateRelativeRemotePath, validateSampleManagerIdentifier } from "./shell-utils.js";

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function psArray(values: string[]): string {
  return `@(${values.map(psQuote).join(", ")})`;
}

export function instancePaths(instance: string) {
  const root = `C:\\Thermo\\SampleManager\\Server\\${instance}`;
  return {
    root,
    exe: `${root}\\Exe`,
    formsBin: `${root}\\Exe\\FormsBin`,
    forms: `${root}\\Exe\\Forms`,
    logfile: `${root}\\Logfile`,
    data: `${root}\\Data`,
    solutionAssemblies: `${root}\\Exe\\SolutionAssemblies`,
    resourceIcon: `${root}\\Resource\\Icon`,
    relayBackups: `${root}\\RelayBackups`,
  };
}

export async function restartSampleManagerInstance(
  runner: RemoteRunner,
  instance: string,
  execution: RemoteExecutionOptions = {}
): Promise<string> {
  const suffix = instance.toLowerCase();
  const script = `
$ErrorActionPreference = "Continue"
Get-Process SampleManagerServerHost -ErrorAction SilentlyContinue | Stop-Process -Force
$services = @('smptq${suffix}','smpSTAT${suffix}','smp${suffix}','SMDaemon${suffix}')
foreach ($svc in $services) {
  if (Get-Service $svc -ErrorAction SilentlyContinue) {
    Restart-Service $svc -Force
  }
}
Get-Service $services -ErrorAction SilentlyContinue | Select-Object Name,Status | Format-Table -AutoSize
`;
  const result = await runner.execPowerShell(script, 120000, execution);
  return compactText(`${result.stdout}\n${result.stderr}`.trim());
}

export async function clearFormCache(runner: RemoteRunner, instance: string, formName: string): Promise<string> {
  const paths = instancePaths(instance);
  const script = `
$ErrorActionPreference = "Continue"
$formsBin = ${psQuote(paths.formsBin)}
$formName = ${psQuote(formName)}
$removed = @()
if (Test-Path -LiteralPath $formsBin) {
  Get-ChildItem -LiteralPath $formsBin -File -Filter "$formName*" -ErrorAction SilentlyContinue | ForEach-Object {
    $removed += $_.FullName
    Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
  }
}
[pscustomobject]@{ Instance=${psQuote(instance)}; Form=$formName; Removed=$removed } | ConvertTo-Json -Compress
`;
  const result = await runner.execPowerShell(script, 30000);
  return compactText(result.stdout || result.stderr);
}

export async function recentErrors(
  runner: RemoteRunner,
  instance: string,
  minutes = 30,
  keywords: string[] = ["ERROR", "Exception", "NewPharma", "SampleManager"]
): Promise<string> {
  const paths = instancePaths(instance);
  const pattern = keywords.join("|");
  const script = `
$ErrorActionPreference = "Continue"
$since = (Get-Date).AddMinutes(-${minutes})
$root = ${psQuote(paths.logfile)}
$pattern = ${psQuote(pattern)}
$matches = @()
if (Test-Path -LiteralPath $root) {
  Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -ge $since -and ($_.Extension -in '.log','.txt','.lis' -or $_.Name -like '*log*') } |
    ForEach-Object {
      Select-String -LiteralPath $_.FullName -Pattern $pattern -ErrorAction SilentlyContinue |
        Select-Object -Last 20 |
        ForEach-Object {
          $matches += [pscustomobject]@{ file=$_.Path; line=$_.LineNumber; text=$_.Line }
        }
    }
}
$matches | Select-Object -Last 80 | ConvertTo-Json -Compress
`;
  const result = await runner.execPowerShell(script, 60000);
  return compactText(result.stdout || result.stderr);
}

export interface SqlOptions {
  allowMutation?: boolean;
  maxRows?: number;
  includeResultSets?: boolean;
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

export async function runSql(
  runner: RemoteRunner,
  database: string,
  sql: string,
  options: boolean | SqlOptions = false
): Promise<string> {
  const sqlOptions: SqlOptions = typeof options === "boolean" ? { allowMutation: options } : options;
  const allowMutation = sqlOptions.allowMutation ?? false;
  const maxRows = Math.max(1, Math.min(sqlOptions.maxRows ?? 100, 1000));
  const includeResultSets = sqlOptions.includeResultSets ?? false;
  if (!allowMutation && sqlContainsMutation(sql)) {
    throw new Error("SQL appears to mutate data. Pass allowMutation=true only inside an approved workflow.");
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(database)) {
    throw new Error(`Invalid database name: ${database}`);
  }
  const sqlBase64 = Buffer.from(sql, "utf8").toString("base64");
  const script = `
$ErrorActionPreference = "Stop"
$cs = "Server=localhost;Database=${database};Integrated Security=True;TrustServerCertificate=True"
$cn = New-Object System.Data.SqlClient.SqlConnection $cs
$cn.Open()
try {
  $cmd = $cn.CreateCommand()
  $cmd.CommandTimeout = 120
  $cmd.CommandText = [System.Text.Encoding]::UTF8.GetString(
    [System.Convert]::FromBase64String(${psQuote(sqlBase64)})
  )
  $maxRows = ${maxRows}
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
      if (@($rows).Count -lt $maxRows) {
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
      truncated = $rowCount -gt @($rows).Count
    }
  } while ($reader.NextResult())

  $firstRows = @()
  $firstRowCount = 0
  $firstRowsReturned = 0
  $firstTruncated = $false
  if (@($resultSets).Count -gt 0) {
    $firstRows = @($resultSets[0].rows)
    $firstRowCount = $resultSets[0].rowCount
    $firstRowsReturned = $resultSets[0].rowsReturned
    $firstTruncated = $resultSets[0].truncated
  }

  [pscustomobject]@{
    rows = @($firstRows)
    rowCount = $firstRowCount
    rowsReturned = $firstRowsReturned
    truncated = $firstTruncated
    maxRows = $maxRows
    resultSetCount = @($resultSets).Count
    resultSets = if ($includeResultSets) { @($resultSets) } else { @() }
    recordsAffected = $reader.RecordsAffected
  } | ConvertTo-Json -Depth 8 -Compress
}
finally {
  $cn.Close()
}
`;
  const result = await runner.execPowerShell(script, 120000);
  return compactText(result.stdout || result.stderr);
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
  instance: string,
  options: SampleManagerCommandOptions
): Promise<string> {
  const paths = instancePaths(instance);
  const args = [
    "-instance",
    instance,
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
  instance: string,
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
  return compactText(`${result.stdout}\n${result.stderr}`.trim());
}

export async function createEntityDefinition(
  runner: RemoteRunner,
  instance: string,
  timeoutMs = 600000,
  execution: RemoteExecutionOptions = {}
): Promise<string> {
  validateSampleManagerIdentifier(instance, "instance");
  return runSampleManagerUtility(runner, instance, "CreateEntityDefinition.exe", {
    args: ["-instance", instance],
    timeoutMs,
    execution,
  });
}

export async function convertSampleManagerTables(
  runner: RemoteRunner,
  instance: string,
  tables: string[],
  timeoutMs = 600000,
  execution: RemoteExecutionOptions = {}
): Promise<string> {
  if (tables.length === 0) throw new Error("At least one table is required");
  const outputs: string[] = [];
  for (const table of tables) {
    validateSampleManagerIdentifier(table, "table name");
    execution.onStdout?.(`Converting table ${table}\n`);
    outputs.push(await runSampleManagerUtility(runner, instance, "convert_table.exe", {
      args: ["-mode", "convert", "-tables", table, "-noconfirm", "-instance", instance],
      timeoutMs,
      execution,
    }));
  }
  return compactText(outputs.join("\n\n"));
}

export async function loadTableLoaderFile(
  runner: RemoteRunner,
  instance: string,
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
  $command = Get-Command MSBuild.exe -ErrorAction SilentlyContinue
  if ($command) { $msbuild = $command.Source }
}
if (-not $msbuild) {
  $programFilesX86 = [Environment]::GetFolderPath("ProgramFilesX86")
  $vswhere = Join-Path $programFilesX86 "Microsoft Visual Studio\\Installer\\vswhere.exe"
  if (Test-Path -LiteralPath $vswhere) {
    $installation = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -property installationPath
    if ($installation) {
      $candidate = Join-Path $installation "MSBuild\\Current\\Bin\\MSBuild.exe"
      if (Test-Path -LiteralPath $candidate) { $msbuild = $candidate }
    }
  }
}
if (-not $msbuild -or -not (Test-Path -LiteralPath $msbuild)) {
  throw "MSBuild.exe was not found; pass msbuildPath explicitly"
}
& $msbuild $project /t:Restore,Build /p:Configuration=${configuration} /nologo
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
`;
  const result = await runner.execPowerShell(script, timeoutMs, execution);
  return compactText(`${result.stdout}\n${result.stderr}`.trim());
}

export type SampleManagerDeployArea = "exe" | "solutionAssemblies" | "forms" | "resourceIcon" | "data";

export async function deploySampleManagerFile(
  runner: RemoteRunner,
  instance: string,
  sourcePath: string,
  area: SampleManagerDeployArea,
  targetRelativePath: string,
  backup = true,
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
$backupPath = $null
if (${backup ? "$true" : "$false"} -and (Test-Path -LiteralPath $target -PathType Leaf)) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmssfff"
  $backupRoot = Join-Path ${psQuote(paths.relayBackups)} $stamp
  $backupPath = Join-Path $backupRoot $relative
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backupPath) | Out-Null
  Copy-Item -LiteralPath $target -Destination $backupPath -Force
}
Copy-Item -LiteralPath $source -Destination $target -Force
[pscustomobject]@{
  source = $source
  target = $target
  backup = $backupPath
  bytes = (Get-Item -LiteralPath $target).Length
} | ConvertTo-Json -Compress
`;
  const result = await runner.execPowerShell(script, 120000, execution);
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
  return compactText(result.stdout || result.stderr);
}
