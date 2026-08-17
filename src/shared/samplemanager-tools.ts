import { ensureRemoteSuccess, type RemoteErrorCategory, type RemoteExecutionOptions, type RemoteRunner } from "./remote-runner.js";
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

export type SampleManagerRestartFailureStage =
  | "preflight"
  | "stop"
  | "stop_wait"
  | "start"
  | "start_wait"
  | "termination"
  | "health"
  | "parse"
  | "transport";

export interface SampleManagerRestartServiceEvidence {
  name: string;
  before: string | null;
  after: string | null;
  stop?: Record<string, unknown>;
  start?: Record<string, unknown>;
  wait?: { stop?: Record<string, unknown>; start?: Record<string, unknown> };
}

export interface SampleManagerRestartEvidence {
  instance: string;
  startedAt: string;
  finishedAt?: string;
  elapsedMs?: number;
  configuredServices: string[];
  missingServices: string[];
  services: SampleManagerRestartServiceEvidence[];
  terminatedProcessIds: number[];
  terminationFailures: Array<{ processId: number; lastState: string | null; error: string }>;
  failedServices: Array<{ service: string; desiredState: string; elapsedMs: number; lastState: string | null; error?: string }>;
  health: {
    state: "pending" | "healthy" | "failed";
    checkedAt?: string;
    readyServices: string[];
    notRunningServices: string[];
    missingServices: string[];
  };
  failure?: {
    stage: SampleManagerRestartFailureStage;
    message: string;
    service?: string;
    desiredState?: string;
    elapsedMs?: number;
    lastState?: string | null;
  };
}

export class SampleManagerRestartError extends Error {
  readonly evidence: SampleManagerRestartEvidence;
  readonly category?: RemoteErrorCategory;
  readonly cause?: unknown;

  constructor(message: string, evidence: SampleManagerRestartEvidence, options: { category?: RemoteErrorCategory; cause?: unknown } = {}) {
    super(message);
    this.name = "SampleManagerRestartError";
    this.evidence = evidence;
    this.category = options.category;
    this.cause = options.cause;
  }
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
  const waitTimeoutMs = 60000;
  const waitPollMs = 1000;
  const evidence: SampleManagerRestartEvidence = {
    instance: name,
    startedAt: new Date().toISOString(),
    configuredServices: [...serviceNames],
    missingServices: [],
    services: [],
    terminatedProcessIds: [],
    terminationFailures: [],
    failedServices: [],
    health: { state: "pending", readyServices: [], notRunningServices: [], missingServices: [] },
  };
  let stage: SampleManagerRestartFailureStage = "preflight";
  let activeService: { name: string; desiredState: string } | undefined;

  // The restart function owns phase names. Per-request transport phases would otherwise
  // overwrite e.g. `waiting:<service>` with `completed` between service transitions.
  const stepExecution: RemoteExecutionOptions = { ...execution, onPhase: undefined };
  const finishEvidence = () => {
    evidence.finishedAt = new Date().toISOString();
    evidence.elapsedMs = Math.max(0, Date.parse(evidence.finishedAt) - Date.parse(evidence.startedAt));
    return evidence;
  };
  const throwEvidence = (
    failureStage: SampleManagerRestartFailureStage,
    message: string,
    details: Partial<SampleManagerRestartEvidence["failure"]> = {},
    options: { category?: RemoteErrorCategory; cause?: unknown } = {}
  ): never => {
    const service = details.service;
    const desiredState = details.desiredState;
    const elapsedMs = details.elapsedMs ?? evidence.elapsedMs ?? Math.max(0, Date.now() - Date.parse(evidence.startedAt));
    const lastState = details.lastState ?? null;
    if (service && desiredState && !evidence.failedServices.some((item) => item.service === service && item.desiredState === desiredState)) {
      evidence.failedServices.push({ service, desiredState, elapsedMs, lastState, error: message });
    }
    evidence.health = { ...evidence.health, state: "failed", checkedAt: new Date().toISOString() };
    evidence.failure = { stage: failureStage, message, ...details, elapsedMs, lastState };
    const completed = finishEvidence();
    execution.onStderr?.(JSON.stringify(completed));
    throw new SampleManagerRestartError(message, completed, options);
  };
  const parseStep = async (script: string, timeoutMs: number): Promise<Record<string, unknown>> => {
    const result = await runner.execPowerShell(script, timeoutMs, stepExecution);
    ensureRemoteSuccess(result);
    const payload = (result.stdout || result.stderr).trim();
    if (!payload) throw new Error("Restart step returned no JSON evidence");
    try {
      return JSON.parse(payload) as Record<string, unknown>;
    } catch {
      stage = "parse";
      throw new Error(`Restart step returned invalid JSON evidence: ${compactText(payload, 500)}`);
    }
  };
  const asStringArray = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const numberValue = (value: unknown, fallback = 0): number => typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const transitionScript = (serviceName: string, action: "stop" | "start", desiredState: "Stopped" | "Running") => `
# relay-restart:service-transition
$ErrorActionPreference = "Stop"
$serviceName = ${psQuote(serviceName)}
$action = ${psQuote(action)}
$desiredState = ${psQuote(desiredState)}
$startedAt = Get-Date
$service = Get-Service -Name $serviceName -ErrorAction Stop
$before = [string]$service.Status
if (($action -eq "stop" -and $before -ne "Stopped") -or ($action -eq "start" -and $before -ne "Running")) {
  if ($action -eq "stop") { Stop-Service -Name $serviceName -Force -ErrorAction Stop }
  else { Start-Service -Name $serviceName -ErrorAction Stop }
}
$actionElapsedMs = [int][math]::Round(((Get-Date) - $startedAt).TotalMilliseconds)
$waitStartedAt = Get-Date
$deadline = (Get-Date).AddMilliseconds(${waitTimeoutMs})
$lastState = $null
$reached = $false
do {
  $current = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  $lastState = if ($current) { [string]$current.Status } else { "Missing" }
  if ($lastState -eq $desiredState) { $reached = $true; break }
  if ((Get-Date) -ge $deadline) { break }
  Start-Sleep -Milliseconds ${waitPollMs}
} while ($true)
[pscustomobject]@{
  service = $serviceName
  action = $action
  desiredState = $desiredState
  before = $before
  after = $lastState
  reached = $reached
  lastState = $lastState
  actionElapsedMs = $actionElapsedMs
  waitElapsedMs = [int][math]::Round(((Get-Date) - $waitStartedAt).TotalMilliseconds)
  elapsedMs = [int][math]::Round(((Get-Date) - $startedAt).TotalMilliseconds)
} | ConvertTo-Json -Depth 4 -Compress
`;

  try {
    execution.onPhase?.("restart_preflight");
    stage = "preflight";
    const preflight = await parseStep(`
# relay-restart:preflight
$ErrorActionPreference = "Stop"
$services = ${psArray(serviceNames)}
$serviceEvidence = @()
$missing = @()
foreach ($serviceName in $services) {
  $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  if ($service) { $serviceEvidence += [pscustomobject]@{ name = $serviceName; before = [string]$service.Status } }
  else { $missing += $serviceName }
}
[pscustomobject]@{ configuredServices = @($services); missingServices = @($missing); services = @($serviceEvidence) } | ConvertTo-Json -Depth 5 -Compress
`, 30000);
    evidence.missingServices = asStringArray(preflight.missingServices);
    evidence.health.missingServices = [...evidence.missingServices];
    const preflightServices = new Map<string, Record<string, unknown>>(
      (Array.isArray(preflight.services) ? preflight.services : [])
        .filter((service): service is Record<string, unknown> => Boolean(service) && typeof service === "object" && typeof (service as Record<string, unknown>).name === "string")
        .map((service) => [service.name as string, service])
    );
    evidence.services = serviceNames
      .filter((service) => !evidence.missingServices.includes(service))
      .map((service) => ({ name: service, before: (preflightServices.get(service)?.before as string | undefined) ?? null, after: (preflightServices.get(service)?.before as string | undefined) ?? null }));
    if (evidence.missingServices.length > 0) {
      throwEvidence("preflight", `Configured services are missing: ${evidence.missingServices.join(", ")}`);
    }
    const serviceByName = new Map(evidence.services.map((service) => [service.name, service]));

    for (const serviceName of [...serviceNames].reverse()) {
      const service = serviceByName.get(serviceName)!;
      activeService = { name: serviceName, desiredState: "Stopped" };
      stage = "stop";
      execution.onPhase?.(`stopping:${serviceName}`);
      const transition = await parseStep(transitionScript(serviceName, "stop", "Stopped"), waitTimeoutMs + 5000);
      execution.onPhase?.(`waiting:${serviceName}`);
      service.stop = { ...transition, elapsedMs: numberValue(transition.actionElapsedMs, numberValue(transition.elapsedMs)) };
      service.wait = { ...service.wait, stop: { ...transition, elapsedMs: numberValue(transition.waitElapsedMs, numberValue(transition.elapsedMs)) } };
      service.after = (transition.lastState as string | undefined) ?? service.after;
      if (transition.reached !== true) {
        throwEvidence("stop_wait", `Service '${serviceName}' did not reach 'Stopped' within ${numberValue(transition.waitElapsedMs, waitTimeoutMs)}ms; last state: ${transition.lastState ?? "Unknown"}`, {
          service: serviceName,
          desiredState: "Stopped",
          elapsedMs: numberValue(transition.waitElapsedMs, waitTimeoutMs),
          lastState: (transition.lastState as string | undefined) ?? null,
        }, { category: "timeout" });
      }
    }

    activeService = undefined;
    stage = "termination";
    execution.onPhase?.("terminating_instance_processes");
    const termination = await parseStep(`
# relay-restart:terminate
$ErrorActionPreference = "Stop"
$instanceName = ${psQuote(name)}
$instanceRoot = ${psQuote(paths.root)}
$normalizedRoot = $instanceRoot.TrimEnd('\\', '/')
$instanceTokenPattern = '(?i)(?<![A-Za-z0-9_.-])' + [Regex]::Escape($instanceName) + '(?![A-Za-z0-9_.-])'
$terminated = @()
$terminationFailures = @()
Get-CimInstance Win32_Process -Filter "Name='SampleManagerServerHost.exe'" -ErrorAction SilentlyContinue |
  ForEach-Object {
    $processId = [int]$_.ProcessId
    $executablePath = [string]$_.ExecutablePath
    $commandLine = [string]$_.CommandLine
    $pathBelongsToInstance = $executablePath -and (
      $executablePath.Equals($normalizedRoot, [StringComparison]::OrdinalIgnoreCase) -or
      $executablePath.StartsWith($normalizedRoot + '\\', [StringComparison]::OrdinalIgnoreCase)
    )
    $commandBelongsToInstance = $commandLine -and [Regex]::IsMatch($commandLine, $instanceTokenPattern)
    $belongsToInstance = $pathBelongsToInstance -or $commandBelongsToInstance
    if ($belongsToInstance) {
      try {
        $terminationResult = Invoke-CimMethod -InputObject $_ -MethodName Terminate -ErrorAction Stop
        if ($terminationResult.ReturnValue -ne 0) {
          throw "Terminate returned $($terminationResult.ReturnValue)"
        }
        $deadline = (Get-Date).AddMilliseconds(10000)
        do {
          $remaining = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
          if (-not $remaining) { break }
          Start-Sleep -Milliseconds 250
        } while ((Get-Date) -lt $deadline)
        if ($remaining) {
          $terminationFailures += [pscustomobject]@{ processId = $processId; lastState = "Running"; error = "Process still exists after terminate" }
        } else {
          $terminated += $processId
        }
      } catch {
        $terminationFailures += [pscustomobject]@{ processId = $processId; lastState = "Unknown"; error = $_.Exception.Message }
      }
    }
  }
[pscustomobject]@{ terminatedProcessIds = @($terminated); terminationFailures = @($terminationFailures) } | ConvertTo-Json -Depth 5 -Compress
`, 30000);
    evidence.terminatedProcessIds = (Array.isArray(termination.terminatedProcessIds) ? termination.terminatedProcessIds : [])
      .filter((value): value is number => typeof value === "number");
    evidence.terminationFailures = (Array.isArray(termination.terminationFailures) ? termination.terminationFailures : [])
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item) => ({ processId: numberValue(item.processId), lastState: (item.lastState as string | undefined) ?? null, error: String(item.error ?? "Termination was not verified") }));
    if (evidence.terminationFailures.length > 0) {
      throwEvidence("termination", `Failed to verify termination of process IDs: ${evidence.terminationFailures.map((item) => item.processId).join(", ")}`);
    }

    for (const serviceName of serviceNames) {
      const service = serviceByName.get(serviceName)!;
      activeService = { name: serviceName, desiredState: "Running" };
      stage = "start";
      execution.onPhase?.(`starting:${serviceName}`);
      const transition = await parseStep(transitionScript(serviceName, "start", "Running"), waitTimeoutMs + 5000);
      execution.onPhase?.(`waiting:${serviceName}`);
      service.start = { ...transition, elapsedMs: numberValue(transition.actionElapsedMs, numberValue(transition.elapsedMs)) };
      service.wait = { ...service.wait, start: { ...transition, elapsedMs: numberValue(transition.waitElapsedMs, numberValue(transition.elapsedMs)) } };
      service.after = (transition.lastState as string | undefined) ?? service.after;
      if (transition.reached !== true) {
        throwEvidence("start_wait", `Service '${serviceName}' did not reach 'Running' within ${numberValue(transition.waitElapsedMs, waitTimeoutMs)}ms; last state: ${transition.lastState ?? "Unknown"}`, {
          service: serviceName,
          desiredState: "Running",
          elapsedMs: numberValue(transition.waitElapsedMs, waitTimeoutMs),
          lastState: (transition.lastState as string | undefined) ?? null,
        }, { category: "timeout" });
      }
    }

    activeService = undefined;
    stage = "health";
    execution.onPhase?.("health_check");
    const health = await parseStep(`
# relay-restart:health
$ErrorActionPreference = "Stop"
$services = ${psArray(serviceNames)}
$readyServices = @()
$notRunningServices = @()
foreach ($serviceName in $services) {
  $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  if ($service -and [string]$service.Status -eq "Running") { $readyServices += $serviceName }
  else { $notRunningServices += $serviceName }
}
[pscustomobject]@{ readyServices = @($readyServices); notRunningServices = @($notRunningServices) } | ConvertTo-Json -Depth 4 -Compress
`, 30000);
    evidence.health = {
      state: asStringArray(health.notRunningServices).length > 0 ? "failed" : "healthy",
      checkedAt: new Date().toISOString(),
      readyServices: asStringArray(health.readyServices),
      notRunningServices: asStringArray(health.notRunningServices),
      missingServices: [],
    };
    if (evidence.health.notRunningServices.length > 0) {
      const failedService = evidence.health.notRunningServices[0];
      throwEvidence("health", `Service '${failedService}' is not Running after restart`, {
        service: failedService,
        desiredState: "Running",
        lastState: serviceByName.get(failedService)?.after ?? null,
      });
    }
    execution.onPhase?.("completed");
    return compactText(JSON.stringify(finishEvidence()));
  } catch (error) {
    if (error instanceof SampleManagerRestartError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const fallbackStage = stage;
    const service = activeService?.name;
    const desiredState = activeService?.desiredState;
    const conciseMessage = service
      ? `Restart ${fallbackStage} failed for service '${service}' targeting '${desiredState}': ${message}`
      : `Restart ${fallbackStage} failed: ${message}`;
    const category = error && typeof error === "object" && "category" in error
      ? (error as { category?: RemoteErrorCategory }).category
      : undefined;
    return throwEvidence(fallbackStage, conciseMessage, { service, desiredState }, { category, cause: error });
  }
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

export interface SampleManagerBuildProfile {
  kind?: "msbuild" | "dotnet" | "unknown";
  selectedPath?: string;
  selectedVersion?: string;
  targetFramework?: string;
}

export interface SampleManagerBuildOptions {
  instance?: SampleManagerInstanceRef;
  msbuildProperties?: Record<string, string>;
  environmentVariables?: Record<string, string>;
  preflightOnly?: boolean;
  expectedAssemblyPath?: string;
}

interface EffectiveBuildContext {
  instance?: { name: string; root: string; exe: string };
  properties: Record<string, string>;
  environment: Record<string, string>;
  redactionValues: Record<string, string>;
  preflightOnly: boolean;
  expectedAssemblyPath?: string;
}

const BUILD_SETTING_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SENSITIVE_BUILD_SETTING_NAME = /TOKEN|SECRET|PASSWORD|PWD|PASS|KEY|CREDENTIAL|AUTH|PAT|BEARER|COOKIE|CONNECTION_?STRING/i;

/**
 * Converts an instance name into the deterministic MSBuild property <INSTANCE>_EXE:
 * ASCII letters and digits are preserved in uppercase, other characters become `_`,
 * and an underscore is prepended when the first character is not a letter or `_`.
 */
export function instanceExePropertyName(name: string): string {
  const normalized = name.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase() || "INSTANCE";
  const identifier = /^[A-Za-z_]/.test(normalized) ? normalized : `_${normalized}`;
  return `${identifier}_EXE`;
}

function isSensitiveEnvironmentVariableName(name: string): boolean {
  return SENSITIVE_BUILD_SETTING_NAME.test(name);
}

export function redactSensitiveBuildOutput(text: string, environment: Record<string, string>): string {
  return Object.entries(environment)
    .filter(([, value]) => value.length > 0)
    .sort(([, left], [, right]) => right.length - left.length)
    .reduce((redacted, [, value]) => redacted.split(value).join("[REDACTED]"), text);
}

export function buildSettingsMetadata(values: Record<string, string> | undefined): {
  keys: string[];
  count: number;
  valuesRedacted: true;
} {
  const keys = Object.keys(values ?? {}).sort();
  return { keys, count: keys.length, valuesRedacted: true };
}

function redactedBuildExecutionOptions(
  execution: RemoteExecutionOptions,
  environment: Record<string, string>
): RemoteExecutionOptions {
  return {
    ...execution,
    onStdout: execution.onStdout
      ? (text) => execution.onStdout?.(redactSensitiveBuildOutput(text, environment))
      : undefined,
    onStderr: execution.onStderr
      ? (text) => execution.onStderr?.(redactSensitiveBuildOutput(text, environment))
      : undefined,
  };
}

function validatedBuildSettings(values: Record<string, string> | undefined, label: string): Record<string, string> {
  const validated: Record<string, string> = {};
  for (const [name, value] of Object.entries(values ?? {})) {
    if (!BUILD_SETTING_NAME.test(name)) throw new Error(`Invalid ${label} name: ${name}`);
    if (typeof value !== "string") throw new Error(`${label} '${name}' must be a string`);
    validated[name] = value;
  }
  return validated;
}

export function validateBuildEnvironmentVariables(
  values: Record<string, string> | undefined
): Record<string, string> {
  const environment = validatedBuildSettings(values, "environment variable");
  const sensitiveName = Object.keys(environment).find(isSensitiveEnvironmentVariableName);
  if (sensitiveName) {
    throw new Error(
      `Direct secret-bearing environment variables are not supported; preconfigure secrets on the target service account (rejected: ${sensitiveName})`
    );
  }
  return environment;
}

export function validateBuildMsbuildProperties(
  values: Record<string, string> | undefined
): Record<string, string> {
  const properties = validatedBuildSettings(values, "MSBuild property");
  const sensitiveName = Object.keys(properties).find(isSensitiveEnvironmentVariableName);
  if (sensitiveName) {
    throw new Error(
      `Direct secret-bearing MSBuild properties are not supported; preconfigure secrets on the target service account (rejected: ${sensitiveName})`
    );
  }
  return properties;
}

function effectiveBuildContext(options: SampleManagerBuildOptions): EffectiveBuildContext {
  const properties = validateBuildMsbuildProperties(options.msbuildProperties);
  const environment = validateBuildEnvironmentVariables(options.environmentVariables);
  if (!options.instance) {
    return {
      properties,
      environment,
      redactionValues: { ...properties, ...environment },
      preflightOnly: options.preflightOnly === true,
      expectedAssemblyPath: options.expectedAssemblyPath,
    };
  }

  const paths = instancePaths(options.instance);
  const name = instanceName(options.instance);
  return {
    instance: { name, root: paths.root, exe: paths.exe },
    properties: {
      ...properties,
      [instanceExePropertyName(name)]: paths.exe,
      SAMPLEMANAGER_EXE: paths.exe,
    },
    environment,
    redactionValues: { ...properties, ...environment },
    preflightOnly: options.preflightOnly === true,
    expectedAssemblyPath: options.expectedAssemblyPath,
  };
}

function psOrderedMap(name: string, values: Record<string, string>): string {
  const entries = Object.entries(values)
    .map(([key, value]) => `  ${psQuote(key)} = ${psQuote(value)}`)
    .join("\n");
  return `$${name} = [ordered]@{${entries ? `\n${entries}\n` : ""}}`;
}

function buildScript(
  projectOrSolutionPath: string,
  configuration: string,
  explicitToolPath: string | undefined,
  profile: SampleManagerBuildProfile,
  context: EffectiveBuildContext
): string {
  const toolKind = profile.kind === "dotnet" ? "dotnet" : "msbuild";
  const toolSetup = toolKind === "dotnet"
    ? `
$dotnet = ${psQuote(explicitToolPath || profile.selectedPath || "dotnet.exe")}
$dotnetCommand = Get-Command $dotnet -ErrorAction SilentlyContinue
$toolPath = if (Test-Path -LiteralPath $dotnet -PathType Leaf) { (Resolve-Path -LiteralPath $dotnet).Path } elseif ($dotnetCommand) { $dotnetCommand.Source } else { $null }
if (-not $toolPath) { throw "dotnet was not found; pass msbuildPath explicitly" }
`
    : `
$msbuild = ${explicitToolPath ? psQuote(explicitToolPath) : "$null"}
if (-not $msbuild) {
  ${buildToolDiscoveryPowerShell()}
  $tools = @(Get-RelayMsBuildCandidates)
  if ($tools.Count -gt 0) { $msbuild = $tools[0].path }
}
if (-not $msbuild -or -not (Test-Path -LiteralPath $msbuild -PathType Leaf)) {
  throw "MSBuild.exe was not found; pass msbuildPath explicitly"
}
$toolPath = (Resolve-Path -LiteralPath $msbuild).Path
`;
  const instanceContext = context.instance
    ? `[pscustomobject]@{ name = ${psQuote(context.instance.name)}; root = ${psQuote(context.instance.root)}; exe = ${psQuote(context.instance.exe)} }`
    : "$null";
  const instanceValidation = context.instance
    ? `
$instanceRoot = ${psQuote(context.instance.root)}
$instanceExe = ${psQuote(context.instance.exe)}
if (-not (Test-Path -LiteralPath $instanceRoot -PathType Container)) { throw "SampleManager instance root not found: $instanceRoot" }
if (-not (Test-Path -LiteralPath $instanceExe -PathType Container)) { throw "SampleManager instance Exe directory not found: $instanceExe" }
`
    : "";
  const properties = psOrderedMap("effectiveProperties", context.properties);
  const buildEnvironment = psOrderedMap("buildEnvironment", context.environment);
  const propertyArguments = Object.entries(context.properties)
    .map(([name, value]) => psQuote(`/p:${name}=${value}`))
    .join(", ");
  const buildInvocation = toolKind === "dotnet"
    ? `
$arguments = @("build", $project, "--configuration", ${psQuote(configuration)}, "--nologo")
${profile.targetFramework ? `$arguments += @("--framework", ${psQuote(profile.targetFramework)})` : ""}
$arguments += @(${propertyArguments})
& $toolPath @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
`
    : `
$arguments = @($project, "/t:Restore,Build", "/p:Configuration=${configuration}", "/nologo")
$arguments += @(${propertyArguments})
& $toolPath @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
`;
  return `
$ErrorActionPreference = "Stop"
$project = ${psQuote(projectOrSolutionPath)}
if (-not (Test-Path -LiteralPath $project)) { throw "Project or solution not found: $project" }
${instanceValidation}
${properties}
${buildEnvironment}
foreach ($entry in $buildEnvironment.GetEnumerator()) { Set-Item -Path "Env:$($entry.Key)" -Value $entry.Value }
${toolSetup}
if (${context.preflightOnly ? "$true" : "$false"}) {
  [pscustomobject]@{
    preflightOnly = $true
    projectOrSolutionPath = $project
    tool = [pscustomobject]@{ kind = ${psQuote(toolKind)}; path = $toolPath }
    instance = ${instanceContext}
    effectiveProperties = $effectiveProperties
    effectiveEnvironment = $buildEnvironment
    expectedAssemblyPath = ${context.expectedAssemblyPath ? psQuote(context.expectedAssemblyPath) : "$null"}
  } | ConvertTo-Json -Depth 6 -Compress
  exit 0
}
${buildInvocation}
`;
}

export async function buildDotNetProject(
  runner: RemoteRunner,
  projectOrSolutionPath: string,
  configuration = "Release",
  msbuildPath?: string,
  timeoutMs = 600000,
  execution: RemoteExecutionOptions = {},
  options: SampleManagerBuildOptions = {}
): Promise<string> {
  return buildSampleManagerProject(
    runner,
    projectOrSolutionPath,
    configuration,
    msbuildPath,
    { kind: "msbuild" },
    timeoutMs,
    execution,
    options
  );
}

export async function buildSampleManagerProject(
  runner: RemoteRunner,
  projectOrSolutionPath: string,
  configuration = "Release",
  explicitToolPath?: string,
  profile: SampleManagerBuildProfile = {},
  timeoutMs = 600000,
  execution: RemoteExecutionOptions = {},
  options: SampleManagerBuildOptions = {}
): Promise<string> {
  if (!/^[A-Za-z0-9_.-]+$/.test(configuration)) {
    throw new Error(`Invalid build configuration: ${configuration}`);
  }
  const context = effectiveBuildContext(options);
  const script = buildScript(
    projectOrSolutionPath,
    configuration,
    explicitToolPath || profile.selectedPath,
    profile,
    context
  );
  const result = await runner.execPowerShell(
    script,
    timeoutMs,
    redactedBuildExecutionOptions(execution, context.redactionValues)
  );
  const redactedResult = {
    ...result,
    stdout: redactSensitiveBuildOutput(result.stdout, context.redactionValues),
    stderr: redactSensitiveBuildOutput(result.stderr, context.redactionValues),
  };
  ensureRemoteSuccess(redactedResult);
  return compactText(`${redactedResult.stdout}\n${redactedResult.stderr}`.trim());
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
