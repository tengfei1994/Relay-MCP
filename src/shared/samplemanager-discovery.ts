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

export const DATABASE_ASSOCIATION_RANK = {
  instanceRegistry: 400,
  instanceConfig: 300,
  machineInventory: 100,
  inferredInstanceName: 10,
} as const;

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
function Normalize-LocalSqlServer([string]$value) {
  $trimmed = ([string]$value).Trim()
  if ($trimmed -eq '.' -or $trimmed -ieq '(local)' -or
      $trimmed -ieq $env:COMPUTERNAME -or
      $trimmed -ieq [Environment]::MachineName) { return 'localhost' }
  if ($trimmed.StartsWith('.\')) { return "localhost\$($trimmed.Substring(2))" }
  return $trimmed
}
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
$sqlServers = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
$null = $sqlServers.Add('localhost')
foreach ($service in $services) {
  $path = [string]$service.PathName
  $match = [regex]::Match($path, '(?i)([A-Z]:\\[^"]*?\\SampleManager\\Server\\[^\\"]+)')
  if ($match.Success -and (Test-Path -LiteralPath $match.Groups[1].Value -PathType Container)) {
    $null = $roots.Add((Resolve-Path -LiteralPath $match.Groups[1].Value).Path)
  }
  if ([string]$service.Name -match '(?i)^MSSQL\$(.+)$') {
    $null = $sqlServers.Add("localhost\$($matches[1])")
  } elseif ([string]$service.Name -eq 'MSSQLSERVER') {
    $null = $sqlServers.Add('localhost')
  }
}

$msbuildCandidates = @()
$buildToolWarnings = New-Object 'System.Collections.Generic.List[string]'
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
function New-RelayMsbuildCandidate([object]$value) {
  $path = ConvertTo-RelayFilePath $value
  if (-not $path) {
    $null = $buildToolWarnings.Add('Skipped an MSBuild candidate because its value was not a valid absolute file path')
    return $null
  }
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
  try {
    return [pscustomobject]@{
      kind = 'msbuild'
      path = $path
      version = [Diagnostics.FileVersionInfo]::GetVersionInfo($path).FileVersion
    }
  } catch {
    $null = $buildToolWarnings.Add("Could not read MSBuild version for '$path': $($_.Exception.Message)")
    return $null
  }
}
$programFilesX86 = [Environment]::GetFolderPath('ProgramFilesX86')
$vswhere = Join-Path $programFilesX86 'Microsoft Visual Studio\Installer\vswhere.exe'
if (Test-Path -LiteralPath $vswhere) {
  $installationPaths = @(& $vswhere -products * -requires Microsoft.Component.MSBuild -property installationPath 2>$null)
  foreach ($installationPath in $installationPaths) {
    $basePath = ConvertTo-RelayFilePath $installationPath
    if (-not $basePath) { continue }
    $candidate = New-RelayMsbuildCandidate (Join-Path $basePath 'MSBuild\Current\Bin\MSBuild.exe')
    if ($candidate) { $msbuildCandidates += $candidate }
  }
}
$frameworkMsbuild = Join-Path ([Environment]::GetFolderPath('Windows')) 'Microsoft.NET\Framework64\v4.0.30319\MSBuild.exe'
$frameworkCandidate = New-RelayMsbuildCandidate $frameworkMsbuild
if ($frameworkCandidate) { $msbuildCandidates += $frameworkCandidate }
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
  $version = ''
  if ($versionFile) {
    try {
      $version = [Diagnostics.FileVersionInfo]::GetVersionInfo((ConvertTo-RelayFilePath $versionFile)).ProductVersion
    } catch {
      $null = $buildToolWarnings.Add("Could not read SampleManager version from '$versionFile': $($_.Exception.Message)")
    }
  }
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
  $databaseCandidates = @()

  # SampleManager instance creation records the database target under the
  # instance's LabSystems registry key. This is the strongest association
  # available on a server that hosts multiple LIMS instances.
  $registryPaths = @(
    "HKLM:\SOFTWARE\WOW6432Node\LabSystems\SampleManager Server\$name",
    "HKLM:\SOFTWARE\LabSystems\SampleManager Server\$name",
    "HKLM:\SOFTWARE\WOW6432Node\LabSystems\$name\Setup",
    "HKLM:\SOFTWARE\LabSystems\$name\Setup",
    "HKLM:\SOFTWARE\WOW6432Node\LabSystems\SampleManager\$name\Setup",
    "HKLM:\SOFTWARE\LabSystems\SampleManager\$name\Setup",
    "HKLM:\SOFTWARE\WOW6432Node\LabSystems\Sample Manager\$name\Setup",
    "HKLM:\SOFTWARE\LabSystems\Sample Manager\$name\Setup"
  )
  foreach ($registryPath in $registryPaths) {
    if (-not (Test-Path -LiteralPath $registryPath)) { continue }
    $registryValues = Get-ItemProperty -LiteralPath $registryPath -ErrorAction SilentlyContinue
    if (-not $registryValues) { continue }
    $properties = @($registryValues.PSObject.Properties | Where-Object {
      $_.Name -notmatch '^PS(Path|ParentPath|ChildName|Drive|Provider)$'
    })
    $registryText = ($properties | ForEach-Object { [string]$_.Value }) -join [Environment]::NewLine
    $registryConnectionSources = @()
    $adoConnectionProperty = $properties | Where-Object {
      $_.Name -ieq 'smp$ado_connection_string'
    } | Select-Object -First 1
    if ($adoConnectionProperty -and [string]$adoConnectionProperty.Value) {
      $registryConnectionSources += [pscustomobject]@{
        text = [string]$adoConnectionProperty.Value
        source = $registryPath + '\smp$ado_connection_string'
      }
    }
    $registryConnections = @([regex]::Matches($registryText, '(?i)(?:Data Source|Server)\s*=\s*[^;"<]+(?:;[^"<\r\n]+)*'))
    foreach ($connectionStringMatch in $registryConnections) {
      $registryConnectionSources += [pscustomobject]@{
        text = $connectionStringMatch.Value
        source = $registryPath
      }
    }
    foreach ($connectionSource in $registryConnectionSources) {
      $connectionText = [string]$connectionSource.text
      $serverMatch = [regex]::Match($connectionText, '(?i)(?:Data Source|Server)\s*=\s*([^;"<]+)')
      $databaseMatch = [regex]::Match($connectionText, '(?i)(?:Initial Catalog|Database)\s*=\s*([^;"<]+)')
      if (-not $databaseMatch.Success) { continue }
      $candidateHost = Normalize-LocalSqlServer $serverMatch.Groups[1].Value
      $candidateName = $databaseMatch.Groups[1].Value.Trim()
      $isLocalDb = $candidateHost -match '(?i)\(localdb\)' -or $connectionText -match '(?i)AttachDbFilename\s*='
      $isEntityContext = $candidateName -match '(?i)^EntityContext[-_]'
      $duplicate = $databaseCandidates | Where-Object {
        $_.host -eq $candidateHost -and $_.name -eq $candidateName
      } | Select-Object -First 1
      if (-not $duplicate) {
        $databaseCandidates += [pscustomobject][ordered]@{
          host = $candidateHost
          name = $candidateName
          authType = if ($connectionText -match '(?i)(Integrated Security\s*=\s*(true|sspi)|Trusted_Connection\s*=\s*true)') { 'windows' } else { 'sql-or-unknown' }
          source = $connectionSource.source
          sourceKind = 'instance-registry'
          associationRank = ${DATABASE_ASSOCIATION_RANK.instanceRegistry}
          auxiliary = $isLocalDb -or $isEntityContext
          auxiliaryReason = if ($isEntityContext) { 'entity-context' } elseif ($isLocalDb) { 'localdb-or-attached-file' } else { $null }
          probeStatus = 'not-probed'
          tableCount = $null
          sampleManagerTableCount = 0
          error = $null
          score = if ($isLocalDb -or $isEntityContext) { -100 } else { 10 }
        }
      }
    }

    # Older and encrypted installations may store server and database as
    # separate registry values instead of a readable ADO connection string.
    $databaseProperty = $properties | Where-Object {
      $_.Name -match '(?i)^(mssql)?database(name)?$|^initial.?catalog$'
    } | Select-Object -First 1
    $serverProperty = $properties | Where-Object {
      $_.Name -match '(?i)^(mssql)?server$|^databasehost$|^data.?source$'
    } | Select-Object -First 1
    if ($databaseProperty -and [string]$databaseProperty.Value) {
      $candidateName = ([string]$databaseProperty.Value).Trim()
      $candidateHosts = if ($serverProperty -and [string]$serverProperty.Value) {
        @(Normalize-LocalSqlServer ([string]$serverProperty.Value))
      } else {
        @($sqlServers)
      }
      foreach ($candidateHost in $candidateHosts) {
        $duplicate = $databaseCandidates | Where-Object {
          $_.host -eq $candidateHost -and $_.name -eq $candidateName
        } | Select-Object -First 1
        if (-not $duplicate) {
          $databaseCandidates += [pscustomobject][ordered]@{
            host = $candidateHost
            name = $candidateName
            authType = 'windows'
            source = "$registryPath\$($databaseProperty.Name)"
            sourceKind = 'instance-registry'
            associationRank = ${DATABASE_ASSOCIATION_RANK.instanceRegistry}
            auxiliary = $candidateName -match '(?i)^EntityContext[-_]'
            auxiliaryReason = if ($candidateName -match '(?i)^EntityContext[-_]') { 'entity-context' } else { $null }
            probeStatus = 'not-probed'
            tableCount = $null
            sampleManagerTableCount = 0
            error = $null
            score = if ($candidateName -match '(?i)^EntityContext[-_]') { -100 } else { 10 }
          }
        }
      }
    }
  }

  $configRoots = @($exe, (Join-Path $root 'Data'))
  $configFiles = @($configRoots | Where-Object { Test-Path -LiteralPath $_ } |
    ForEach-Object { Get-ChildItem -LiteralPath $_ -File -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $_.Extension -in '.config','.json','.ini','.xml' } |
      Select-Object -First 100 })
  foreach ($file in $configFiles) {
    $text = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction SilentlyContinue
    if (-not $text) { continue }
    $connectionStrings = @([regex]::Matches($text, '(?i)(?:Data Source|Server)\s*=\s*[^;"<]+(?:;[^"<\r\n]+)*'))
    foreach ($connectionStringMatch in $connectionStrings) {
      $connectionText = $connectionStringMatch.Value
      $serverMatch = [regex]::Match($connectionText, '(?i)(?:Data Source|Server)\s*=\s*([^;"<]+)')
      $databaseMatch = [regex]::Match($connectionText, '(?i)(?:Initial Catalog|Database)\s*=\s*([^;"<]+)')
      if (-not $databaseMatch.Success) { continue }
      $candidateHost = Normalize-LocalSqlServer $serverMatch.Groups[1].Value
      $candidateName = $databaseMatch.Groups[1].Value.Trim()
      $isLocalDb = $candidateHost -match '(?i)\(localdb\)' -or $connectionText -match '(?i)AttachDbFilename\s*='
      $isEntityContext = $candidateName -match '(?i)^EntityContext[-_]' -or $file.Name -match '(?i)ODataService'
      $candidate = [ordered]@{
        host = $candidateHost
        name = $candidateName
        authType = if ($connectionText -match '(?i)(Integrated Security\s*=\s*(true|sspi)|Trusted_Connection\s*=\s*true)') { 'windows' } else { 'sql-or-unknown' }
        source = $file.FullName
        sourceKind = 'instance-config'
        associationRank = ${DATABASE_ASSOCIATION_RANK.instanceConfig}
        auxiliary = $isLocalDb -or $isEntityContext
        auxiliaryReason = if ($isEntityContext) { 'entity-context-or-odata' } elseif ($isLocalDb) { 'localdb-or-attached-file' } else { $null }
        probeStatus = 'not-probed'
        tableCount = $null
        sampleManagerTableCount = 0
        error = $null
        score = if ($isLocalDb -or $isEntityContext) { -100 } else { 10 }
      }
      $duplicate = $databaseCandidates | Where-Object {
        $_.host -eq $candidate.host -and $_.name -eq $candidate.name
      } | Select-Object -First 1
      if (-not $duplicate) { $databaseCandidates += [pscustomobject]$candidate }
    }
  }

  # Enumerate every installed local SQL Server service, including named
  # instances such as localhost\SQLEXPRESS.
  foreach ($sqlServer in @($sqlServers)) {
    $masterConnection = $null
    try {
      $masterConnectionString = "Server=$sqlServer;Database=master;Integrated Security=SSPI;TrustServerCertificate=True;Connection Timeout=5"
      $masterConnection = New-Object System.Data.SqlClient.SqlConnection $masterConnectionString
      $masterConnection.Open()
      $masterCommand = $masterConnection.CreateCommand()
      $masterCommand.CommandTimeout = 15
      $masterCommand.CommandText = "SELECT name FROM sys.databases WHERE state_desc = 'ONLINE' AND database_id > 4"
      $masterReader = $masterCommand.ExecuteReader()
      while ($masterReader.Read()) {
        $localDatabaseName = $masterReader.GetString(0)
        $duplicate = $databaseCandidates | Where-Object {
          $_.host -eq $sqlServer -and $_.name -eq $localDatabaseName
        } | Select-Object -First 1
        if (-not $duplicate) {
          $databaseCandidates += [pscustomobject][ordered]@{
            host = $sqlServer
            name = $localDatabaseName
            authType = 'windows'
            source = "$sqlServer-sys.databases"
            sourceKind = 'machine-inventory'
            associationRank = ${DATABASE_ASSOCIATION_RANK.machineInventory}
            auxiliary = $localDatabaseName -match '(?i)^EntityContext[-_]'
            auxiliaryReason = if ($localDatabaseName -match '(?i)^EntityContext[-_]') { 'entity-context' } else { $null }
            probeStatus = 'not-probed'
            tableCount = $null
            sampleManagerTableCount = 0
            error = $null
            score = if ($localDatabaseName -match '(?i)^EntityContext[-_]') { -100 } else { 15 }
          }
        }
      }
      $masterReader.Close()
    } catch {
      # Continue with the other installed SQL Server instances.
    } finally {
      if ($masterConnection) { $masterConnection.Dispose() }
    }
  }

  # Try the instance name on every installed local SQL Server only as a final
  # fallback when no stronger source exposes the database target.
  foreach ($sqlServer in @($sqlServers)) {
    if (-not ($databaseCandidates | Where-Object { $_.host -eq $sqlServer -and $_.name -eq $name })) {
      $databaseCandidates += [pscustomobject][ordered]@{
        host = $sqlServer
        name = $name
        authType = 'windows'
        source = "$sqlServer-inferred-from-instance-name"
        sourceKind = 'inferred-instance-name'
        associationRank = ${DATABASE_ASSOCIATION_RANK.inferredInstanceName}
        auxiliary = $false
        auxiliaryReason = $null
        probeStatus = 'not-probed'
        tableCount = $null
        sampleManagerTableCount = 0
        error = $null
        score = 5
      }
    }
  }

  $coreTables = @('VERSION','MASTER_MENU','TASK','FORM','WORKFLOW_NODE','LAB_EXECUTION')
  foreach ($candidate in $databaseCandidates) {
    if ($candidate.auxiliary) { continue }
    $connection = $null
    try {
      # Probe with the Agent/SSH Windows identity. This is intentional even
      # when the stored ADO string uses SQL authentication: the Relay needs
      # to verify the identity it will actually use for SampleManager tools.
      $connectionString = "Server=$($candidate.host);Database=$($candidate.name);Integrated Security=SSPI;TrustServerCertificate=True;Connection Timeout=5"
      $connection = New-Object System.Data.SqlClient.SqlConnection($connectionString)
      $connection.Open()
      $command = $connection.CreateCommand()
      $command.CommandTimeout = 15
      $command.CommandText = @'
SELECT TABLE_NAME
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_TYPE = 'BASE TABLE'
'@
      $reader = $command.ExecuteReader()
      $tables = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
      while ($reader.Read()) {
        $null = $tables.Add($reader.GetString(0))
      }
      $reader.Close()
      $coreCount = @($coreTables | Where-Object { $tables.Contains($_) }).Count
      $candidate.probeStatus = 'verified'
      $candidate.tableCount = $tables.Count
      $candidate.sampleManagerTableCount = $coreCount
      $candidate.score += ($coreCount * 25) + [Math]::Min($tables.Count, 100)
    } catch {
      $candidate.probeStatus = 'failed'
      $candidate.error = $_.Exception.Message
    } finally {
      if ($connection) { $connection.Dispose() }
    }
  }

  $selectedDatabase = $databaseCandidates |
    Where-Object { -not $_.auxiliary } |
    Sort-Object @{Expression = { $_.associationRank }; Descending = $true}, @{Expression = { $_.sampleManagerTableCount }; Descending = $true}, @{Expression = { $_.score }; Descending = $true} |
    Select-Object -First 1
  if ($selectedDatabase) {
    $databaseHost = $selectedDatabase.host
    $databaseName = $selectedDatabase.name
    $databaseAuthType = $selectedDatabase.authType
    $databaseConfigSource = $selectedDatabase.source
  }
  $databaseProbe = [ordered]@{
    status = if ($selectedDatabase) { $selectedDatabase.probeStatus } else { 'unavailable' }
    tableCount = if ($selectedDatabase) { $selectedDatabase.tableCount } else { $null }
    sampleManagerTableCount = if ($selectedDatabase) { $selectedDatabase.sampleManagerTableCount } else { 0 }
    score = if ($selectedDatabase) { $selectedDatabase.score } else { $null }
    error = if ($selectedDatabase) { $selectedDatabase.error } else { $null }
    candidates = $databaseCandidates
  }

  $buildCandidates = if ($runtimeKind -eq 'dotnet') { @($dotnetCandidates + $msbuildCandidates) } else { @($msbuildCandidates + $dotnetCandidates) }
  $selected = $buildCandidates | Select-Object -First 1
  $warnings = @()
  if (-not $version) { $warnings += 'SampleManager version could not be detected' }
  if ($instanceServices.Count -eq 0) { $warnings += 'No Windows services were confidently associated' }
  if (-not $databaseName) { $warnings += 'Database target was not found' }
  elseif ($databaseProbe.sampleManagerTableCount -eq 0) { $warnings += 'Selected database was not verified as a SampleManager LIMS business database' }
  if ($selectedDatabase -and $selectedDatabase.sourceKind -notin @('instance-registry','instance-config')) { $warnings += 'Database target came from machine-wide fallback discovery and must be reviewed before import' }
  if (@($databaseCandidates | Where-Object { $_.auxiliary }).Count -gt 0) { $warnings += 'Auxiliary LocalDB/EntityContext databases were excluded from LIMS database selection' }
  foreach ($buildToolWarning in $buildToolWarnings) { $warnings += $buildToolWarning }
  if (-not $selected) { $warnings += 'No compatible build tool was detected' }
  $confidence = 40
  if ($version) { $confidence += 20 }
  if ($instanceServices.Count -gt 0) { $confidence += 20 }
  if ($databaseProbe.status -eq 'verified') { $confidence += 10 }
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
      warnings = @($buildToolWarnings)
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
