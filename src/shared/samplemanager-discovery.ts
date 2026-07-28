import { ensureRemoteSuccess, type RemoteExecutionOptions, type RemoteRunner } from "./remote-runner.js";

export interface DiscoveredService {
  name: string;
  displayName: string;
  state: string;
  startMode: string;
  pathName: string;
}

export interface DiscoveredBuildProfile {
  kind: "msbuild" | "dotnet" | "unknown";
  selectedPath?: string;
  selectedVersion?: string;
  targetFramework?: string;
  candidates: Array<{ kind: "msbuild" | "dotnet"; path: string; version: string }>;
}

export interface DiscoveredSampleManagerInstance {
  name: string;
  version: string;
  runtimeKind: "framework" | "dotnet" | "unknown";
  rootPath: string;
  exePath: string;
  formsPath: string;
  formsBinPath: string;
  solutionAssembliesPath: string;
  logfilePath: string;
  dataPath: string;
  databaseHost: string;
  databaseName: string;
  databaseAuthType: string;
  databaseConfigSource: string;
  databaseProbe: {
    status: "verified" | "unavailable" | "failed";
    tableCount?: number;
    columnCount?: number;
    schemaFingerprint?: string;
    error?: string;
  };
  services: DiscoveredService[];
  buildProfile: DiscoveredBuildProfile;
  confidence: number;
  warnings: string[];
}

function psArray(values: string[]): string {
  return `@(${values.map((value) => `'${value.replace(/'/g, "''")}'`).join(",")})`;
}

export async function discoverSampleManagerInstances(
  runner: RemoteRunner,
  rootHints: string[] = [],
  execution: RemoteExecutionOptions = {}
): Promise<DiscoveredSampleManagerInstance[]> {
  const script = String.raw`
$ErrorActionPreference = "Stop"
$rootHints = ${psArray(rootHints)}
$roots = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
$defaultRoot = 'C:\Thermo\SampleManager\Server'
if (Test-Path -LiteralPath $defaultRoot) {
  Get-ChildItem -LiteralPath $defaultRoot -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { $null = $roots.Add($_.FullName) }
}
foreach ($hint in $rootHints) {
  if (Test-Path -LiteralPath $hint -PathType Container) { $null = $roots.Add((Resolve-Path -LiteralPath $hint).Path) }
}

$services = @(Get-CimInstance Win32_Service -ErrorAction SilentlyContinue |
  Select-Object Name, DisplayName, State, StartMode, PathName)
foreach ($service in $services) {
  $path = [string]$service.PathName
  $match = [regex]::Match($path, '(?i)([A-Z]:\\[^"]*?\\SampleManager\\Server\\[^\\"]+)')
  if ($match.Success -and (Test-Path -LiteralPath $match.Groups[1].Value -PathType Container)) {
    $null = $roots.Add((Resolve-Path -LiteralPath $match.Groups[1].Value).Path)
  }
}

$msbuildCandidates = @()
$programFilesX86 = [Environment]::GetFolderPath('ProgramFilesX86')
$vswhere = Join-Path $programFilesX86 'Microsoft Visual Studio\Installer\vswhere.exe'
if (Test-Path -LiteralPath $vswhere) {
  $installations = @(& $vswhere -products * -requires Microsoft.Component.MSBuild -format json | ConvertFrom-Json)
  foreach ($installation in $installations) {
    $path = Join-Path $installation.installationPath 'MSBuild\Current\Bin\MSBuild.exe'
    if (Test-Path -LiteralPath $path) {
      $msbuildCandidates += [pscustomobject]@{ kind='msbuild'; path=$path; version=[Diagnostics.FileVersionInfo]::GetVersionInfo($path).FileVersion }
    }
  }
}
$frameworkMsbuild = Join-Path ([Environment]::GetFolderPath('Windows')) 'Microsoft.NET\Framework64\v4.0.30319\MSBuild.exe'
if (Test-Path -LiteralPath $frameworkMsbuild) {
  $msbuildCandidates += [pscustomobject]@{ kind='msbuild'; path=$frameworkMsbuild; version=[Diagnostics.FileVersionInfo]::GetVersionInfo($frameworkMsbuild).FileVersion }
}
$dotnetCandidates = @()
$dotnetCommand = Get-Command dotnet.exe -ErrorAction SilentlyContinue
if ($dotnetCommand) {
  $sdkLines = @(& $dotnetCommand.Source --list-sdks 2>$null)
  foreach ($line in $sdkLines) {
    if ($line -match '^([^\s]+)\s+\[(.+)\]') {
      $dotnetCandidates += [pscustomobject]@{ kind='dotnet'; path=$dotnetCommand.Source; version=$matches[1] }
    }
  }
}

$instances = @()
foreach ($root in @($roots)) {
  $name = Split-Path -Leaf $root
  $exe = Join-Path $root 'Exe'
  if (-not (Test-Path -LiteralPath $exe -PathType Container)) { continue }
  $versionFile = @(
    'SampleManagerServerHost.exe',
    'SampleManagerCommand.exe',
    'SampleManager.exe'
  ) | ForEach-Object { Join-Path $exe $_ } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  $version = if ($versionFile) { [Diagnostics.FileVersionInfo]::GetVersionInfo($versionFile).ProductVersion } else { '' }
  $runtimeKind = 'unknown'
  $parsedVersion = [version]'0.0'
  if ([version]::TryParse(($version -replace '[^0-9.].*$',''), [ref]$parsedVersion)) {
    if ($parsedVersion.Major -gt 21 -or ($parsedVersion.Major -eq 21 -and $parsedVersion.Minor -ge 2)) { $runtimeKind = 'dotnet' }
    elseif ($parsedVersion.Major -gt 0) { $runtimeKind = 'framework' }
  }

  $instanceServices = @($services | Where-Object {
      ([string]$_.PathName).IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
      ([string]$_.Name).IndexOf($name, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
      ([string]$_.DisplayName).IndexOf($name, [StringComparison]::OrdinalIgnoreCase) -ge 0
    } | ForEach-Object {
      [pscustomobject]@{
        name = $_.Name
        displayName = $_.DisplayName
        state = $_.State
        startMode = $_.StartMode
        pathName = $_.PathName
      }
    })

  $databaseHost = ''
  $databaseName = ''
  $databaseAuthType = 'unknown'
  $databaseConfigSource = ''
  $configRoots = @($exe, (Join-Path $root 'Data'))
  $configFiles = @($configRoots | Where-Object { Test-Path -LiteralPath $_ } |
    ForEach-Object { Get-ChildItem -LiteralPath $_ -File -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $_.Extension -in '.config','.json','.ini','.xml' } |
      Select-Object -First 100 })
  foreach ($file in $configFiles) {
    if ($databaseName) { break }
    $text = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction SilentlyContinue
    if (-not $text) { continue }
    $serverMatch = [regex]::Match($text, '(?i)(?:Data Source|Server)\s*=\s*([^;"<]+)')
    $databaseMatch = [regex]::Match($text, '(?i)(?:Initial Catalog|Database)\s*=\s*([^;"<]+)')
    if ($databaseMatch.Success) {
      $databaseName = $databaseMatch.Groups[1].Value.Trim()
      $databaseHost = if ($serverMatch.Success) { $serverMatch.Groups[1].Value.Trim() } else { '' }
      $databaseAuthType = if ($text -match '(?i)(Integrated Security\s*=\s*(true|sspi)|Trusted_Connection\s*=\s*true)') { 'windows' } else { 'sql-or-unknown' }
      $databaseConfigSource = $file.FullName
    }
  }

  $databaseProbe = [ordered]@{ status = 'unavailable' }
  if ($databaseHost -and $databaseName -and $databaseAuthType -eq 'windows') {
    $connection = $null
    try {
      $connectionString = "Server=$databaseHost;Database=$databaseName;Integrated Security=SSPI;TrustServerCertificate=True;Connection Timeout=5"
      $connection = New-Object System.Data.SqlClient.SqlConnection($connectionString)
      $connection.Open()
      $command = $connection.CreateCommand()
      $command.CommandTimeout = 15
      $command.CommandText = @'
SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS
ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
'@
      $reader = $command.ExecuteReader()
      $schemaLines = New-Object 'System.Collections.Generic.List[string]'
      $tables = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
      while ($reader.Read()) {
        $tableKey = "$($reader.GetString(0)).$($reader.GetString(1))"
        $null = $tables.Add($tableKey)
        $null = $schemaLines.Add("$tableKey|$($reader.GetString(2))|$($reader.GetString(3))|$($reader.GetString(4))")
      }
      $reader.Close()
      $sha = [Security.Cryptography.SHA256]::Create()
      try {
        $bytes = [Text.Encoding]::UTF8.GetBytes(($schemaLines -join [Environment]::NewLine))
        $fingerprint = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
      } finally {
        $sha.Dispose()
      }
      $databaseProbe = [ordered]@{
        status = 'verified'
        tableCount = $tables.Count
        columnCount = $schemaLines.Count
        schemaFingerprint = "sha256:$fingerprint"
      }
    } catch {
      $databaseProbe = [ordered]@{
        status = 'failed'
        error = $_.Exception.Message
      }
    } finally {
      if ($connection) { $connection.Dispose() }
    }
  }

  $buildCandidates = if ($runtimeKind -eq 'dotnet') { @($dotnetCandidates + $msbuildCandidates) } else { @($msbuildCandidates + $dotnetCandidates) }
  $selected = $buildCandidates | Select-Object -First 1
  $warnings = @()
  if (-not $version) { $warnings += 'SampleManager version could not be detected' }
  if ($instanceServices.Count -eq 0) { $warnings += 'No Windows services were confidently associated' }
  if (-not $databaseName) { $warnings += 'Database target was not found in readable configuration files' }
  if (-not $selected) { $warnings += 'No compatible build tool was detected' }
  $confidence = 40
  if ($version) { $confidence += 20 }
  if ($instanceServices.Count -gt 0) { $confidence += 20 }
  if ($databaseName) { $confidence += 10 }
  if ($selected) { $confidence += 10 }

  $instances += [pscustomobject]@{
    name = $name
    version = $version
    runtimeKind = $runtimeKind
    rootPath = $root
    exePath = $exe
    formsPath = Join-Path $exe 'Forms'
    formsBinPath = Join-Path $exe 'FormsBin'
    solutionAssembliesPath = Join-Path $exe 'SolutionAssemblies'
    logfilePath = Join-Path $root 'Logfile'
    dataPath = Join-Path $root 'Data'
    databaseHost = $databaseHost
    databaseName = $databaseName
    databaseAuthType = $databaseAuthType
    databaseConfigSource = $databaseConfigSource
    databaseProbe = $databaseProbe
    services = $instanceServices
    buildProfile = [pscustomobject]@{
      kind = if ($selected) { $selected.kind } else { 'unknown' }
      selectedPath = if ($selected) { $selected.path } else { $null }
      selectedVersion = if ($selected) { $selected.version } else { $null }
      targetFramework = $null
      candidates = $buildCandidates
    }
    confidence = $confidence
    warnings = $warnings
  }
}
@($instances | Sort-Object name) | ConvertTo-Json -Depth 8 -Compress
`;
  const result = await runner.execPowerShell(script, 120000, execution);
  ensureRemoteSuccess(result);
  const parsed = JSON.parse(result.stdout || "[]");
  return Array.isArray(parsed) ? parsed : [parsed];
}
