import { ensureRemoteSuccess, type RemoteExecutionOptions, type RemoteRunner } from "./remote-runner.js";
import { instancePaths, type SampleManagerInstanceRef } from "./samplemanager-tools.js";

export interface SampleManagerRuntimeInspectionOptions {
  instance: SampleManagerInstanceRef;
  filePaths?: string[];
  assemblyPaths?: string[];
  logMinutes?: number;
  maxErrors?: number;
  execution?: RemoteExecutionOptions;
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function psArray(values: string[]): string {
  return `@(${values.map(psQuote).join(", ")})`;
}

function safeRemotePath(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 4096 || /[\r\n\0]/.test(trimmed)) throw new Error(`Invalid ${label}`);
  return trimmed;
}

/** Collect bounded runtime evidence without changing services, files, or SQL data. */
export async function inspectSampleManagerDeploymentRuntime(
  runner: RemoteRunner,
  options: SampleManagerRuntimeInspectionOptions,
): Promise<string> {
  const name = typeof options.instance === "string" ? options.instance : options.instance.name;
  const paths = instancePaths(options.instance);
  const filePaths = [...new Set((options.filePaths ?? []).map((path) => safeRemotePath(path, "file path")))].slice(0, 100);
  const assemblyPaths = [...new Set((options.assemblyPaths ?? []).map((path) => safeRemotePath(path, "assembly path")))].slice(0, 50);
  const logMinutes = Math.max(1, Math.min(Math.trunc(options.logMinutes ?? 30), 24 * 60));
  const maxErrors = Math.max(1, Math.min(Math.trunc(options.maxErrors ?? 20), 200));
  const configuredServices = typeof options.instance === "string" ? [] : (options.instance.services ?? []).map((service) => service.name);
  const suffix = name.toLowerCase();
  const serviceNames = configuredServices.length > 0 ? configuredServices : [`smptq${suffix}`, `smpSTAT${suffix}`, `smp${suffix}`, `SMDaemon${suffix}`];
  const script = `
$ErrorActionPreference = "Stop"
$instanceName = ${psQuote(name)}
$instanceRoot = ${psQuote(paths.root)}
$requestedFiles = ${psArray(filePaths)}
$requestedAssemblies = ${psArray(assemblyPaths)}
$serviceNames = ${psArray(serviceNames)}
$since = (Get-Date).AddMinutes(-${logMinutes})
$startedAt = Get-Date

function Get-FileEvidence([string]$path) {
  $exists = Test-Path -LiteralPath $path -PathType Leaf
  $entry = [ordered]@{ path=$path; exists=$exists; bytes=$null; modifiedAt=$null; sha256=$null; fileVersion=$null; assemblyName=$null; assemblyVersion=$null; error=$null }
  if (-not $exists) { return [pscustomobject]$entry }
  try {
    $item = Get-Item -LiteralPath $path -ErrorAction Stop
    $entry.bytes = [long]$item.Length
    $entry.modifiedAt = $item.LastWriteTimeUtc.ToString('o')
    $entry.sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
    if ($item.Extension -in '.dll','.exe') {
      try {
        $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($item.FullName)
        $entry.fileVersion = $version.FileVersion
        try { $entry.assemblyName = ([Reflection.AssemblyName]::GetAssemblyName($item.FullName)).Name; $entry.assemblyVersion = [string]([Reflection.AssemblyName]::GetAssemblyName($item.FullName)).Version } catch { }
      } catch { $entry.error = $_.Exception.Message }
    }
  } catch { $entry.error = $_.Exception.Message }
  return [pscustomobject]$entry
}

$files = @($requestedFiles | ForEach-Object { Get-FileEvidence $_ })
$assemblies = @($requestedAssemblies | ForEach-Object { Get-FileEvidence $_ })
$services = @($serviceNames | ForEach-Object {
  $service = Get-Service -Name $_ -ErrorAction SilentlyContinue
  $cim = Get-CimInstance Win32_Service -Filter ("Name='" + $_.Replace("'", "''") + "'") -ErrorAction SilentlyContinue
  [pscustomobject]@{ name=$_; exists=[bool]$service; status=if($service){[string]$service.Status}else{'Missing'}; processId=if($cim){[int]$cim.ProcessId}else{$null}; startMode=if($cim){[string]$cim.StartMode}else{$null}; pathName=if($cim){[string]$cim.PathName}else{$null} }
})

$processes = @()
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($instanceRoot, [StringComparison]::OrdinalIgnoreCase)) -or ($_.CommandLine -and $_.CommandLine.IndexOf($instanceName, [StringComparison]::OrdinalIgnoreCase) -ge 0) } |
  Select-Object -First 100 |
  ForEach-Object { $processes += [pscustomobject]@{ id=[int]$_.ProcessId; name=$_.Name; executablePath=$_.ExecutablePath } }

$loadedModules = @()
$moduleErrors = @()
$wantedModuleNames = @($assemblies | Where-Object { $_.exists } | ForEach-Object { [IO.Path]::GetFileName($_.path) })
foreach ($process in $processes) {
  try {
    $modules = @(Get-Process -Id $process.id -ErrorAction Stop | Select-Object -ExpandProperty Modules)
    foreach ($module in $modules) {
      if ($wantedModuleNames.Count -eq 0 -or $wantedModuleNames -icontains $module.ModuleName) {
        $loadedModules += [pscustomobject]@{ processId=$process.id; processName=$process.name; moduleName=$module.ModuleName; fileName=$module.FileName; fileVersion=$module.FileVersionInfo.FileVersion; moduleVersion=$module.FileVersionInfo.ProductVersion }
      }
    }
  } catch { $moduleErrors += [pscustomobject]@{ processId=$process.id; processName=$process.name; error=$_.Exception.Message } }
}

$errors = @()
$filesScanned = 0
$logRoot = ${psQuote(paths.logfile)}
if (Test-Path -LiteralPath $logRoot -PathType Container) {
  Get-ChildItem -LiteralPath $logRoot -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in '.log','.txt','.lis' -or $_.Name -like '*log*' } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 10 |
    ForEach-Object {
      $filesScanned++
      $logFile = $_
      Get-Content -LiteralPath $logFile.FullName -Tail 500 -ErrorAction SilentlyContinue |
        Select-String -Pattern 'ERROR|Exception|Fatal' -CaseSensitive:$false |
        ForEach-Object {
          $timestamp = $null
          if ($_.Line -match '(?<stamp>\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?)') { try { $timestamp = [DateTimeOffset]::Parse($Matches.stamp) } catch { } }
          if ($null -eq $timestamp -or $timestamp -ge [DateTimeOffset]$since) { $errors += [pscustomobject]@{ file=$logFile.FullName; line=$_.LineNumber; text=$_.Line; timestamp=if($timestamp){$timestamp.ToString('o')}else{$null} } }
        }
    }
}
$errors = @($errors | Select-Object -Last ${maxErrors})
$notRunning = @($services | Where-Object { $_.status -ne 'Running' } | ForEach-Object { $_.name })
[pscustomobject]@{
  instance=$instanceName
  startedAt=$startedAt.ToUniversalTime().ToString('o')
  finishedAt=(Get-Date).ToUniversalTime().ToString('o')
  files=$files
  assemblies=$assemblies
  services=$services
  processes=$processes
  loadedModules=$loadedModules
  moduleErrors=$moduleErrors
  logs=[pscustomobject]@{ searchedFrom=$since.ToUniversalTime().ToString('o'); filesScanned=$filesScanned; errors=$errors }
  summary=[pscustomobject]@{ requestedFileCount=$requestedFiles.Count; missingFiles=@($files | Where-Object { -not $_.exists } | ForEach-Object { $_.path }); requestedAssemblyCount=$requestedAssemblies.Count; missingAssemblies=@($assemblies | Where-Object { -not $_.exists } | ForEach-Object { $_.path }); loadedAssemblyCount=$loadedModules.Count; moduleInspectionErrors=$moduleErrors.Count; unhealthyServices=$notRunning; processCount=$processes.Count; errorCount=$errors.Count; healthy=(@($files | Where-Object { -not $_.exists }).Count -eq 0 -and @($assemblies | Where-Object { -not $_.exists }).Count -eq 0 -and $notRunning.Count -eq 0 -and $moduleErrors.Count -eq 0 -and $errors.Count -eq 0) }
  limits=[pscustomobject]@{ maxFiles=100; maxAssemblies=50; maxProcesses=100; maxLogFiles=10; maxErrors=${maxErrors}; logMinutes=${logMinutes} }
  readOnly=$true
  mutationAttempted=$false
} | ConvertTo-Json -Depth 10 -Compress
`;
  const result = await runner.execPowerShell(script, 120000, options.execution ?? {});
  ensureRemoteSuccess(result);
  const output = (result.stdout || result.stderr).trim();
  if (!output) throw new Error("SampleManager runtime inspection returned no JSON evidence");
  try { JSON.parse(output); } catch { throw new Error(`SampleManager runtime inspection returned invalid JSON: ${output.slice(0, 1000)}`); }
  return output;
}
