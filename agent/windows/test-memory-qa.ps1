param(
  [string]$AssemblyPath = ""
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($AssemblyPath)) {
  $AssemblyPath = Join-Path $scriptRoot "out\RelayAgent.Client.exe"
}
$AssemblyPath = (Resolve-Path -LiteralPath $AssemblyPath).Path
$qaRoot = Join-Path ([IO.Path]::GetTempPath()) ("relay-agent-memory-qa-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $qaRoot | Out-Null
$env:RELAY_AGENT_CONFIG_DIR = $qaRoot

Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName WindowsBase

$assembly = [Reflection.Assembly]::LoadFrom($AssemblyPath)
$commandAuditType = $assembly.GetType("RelayAgent.Shared.CommandAuditStore", $true)
$commandAuditStart = $commandAuditType.GetMethod("Start")
$commandAuditComplete = $commandAuditType.GetMethod("Complete")
$commandAuditMarkResult = $commandAuditType.GetMethod("MarkResultPosted")
$largeCommand = "Write-Output 'memory qa'`r`n" + ("C" * 65536)
$largeOutput = "QA command output`r`n" + ("O" * 262000)
for ($index = 1; $index -le 100; $index++) {
  $jobId = "memory-command-{0:D3}" -f $index
  $commandAuditStart.Invoke($null, @(
    $jobId,
    "powershell",
    "Run large-output memory QA command $index",
    $largeCommand,
    "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <Agent jobs script>",
    120000,
    $true,
    $true,
    14
  )) | Out-Null
  $commandAuditComplete.Invoke($null, @(
    $jobId,
    "completed",
    0,
    $largeOutput,
    "",
    "Memory QA result"
  )) | Out-Null
  $commandAuditMarkResult.Invoke($null, @($jobId, $true, "")) | Out-Null
}

$playwrightManagerType = $assembly.GetType("RelayAgent.Shared.PlaywrightManager", $true)
$playwrightRunType = $assembly.GetType("RelayAgent.Shared.PlaywrightRun", $true)
$saveRun = $playwrightManagerType.GetMethod(
  "SaveRun",
  [Reflection.BindingFlags]::Static -bor [Reflection.BindingFlags]::NonPublic)
$largePlaywrightOutput = "QA Playwright output`r`n" + ("P" * 499000)
for ($index = 1; $index -le 50; $index++) {
  $run = [Activator]::CreateInstance($playwrightRunType)
  $run.Id = "memory-run-{0:D3}" -f $index
  $run.SuiteId = "memory-suite"
  $run.SuiteName = "Memory QA suite"
  $run.Status = "passed"
  $run.StartedAt = [DateTimeOffset]::Now.AddMinutes(-$index).ToString("o")
  $run.FinishedAt = [DateTimeOffset]::Now.AddMinutes(-$index).AddSeconds(2).ToString("o")
  $run.DurationMs = 2000
  $run.ExitCode = 0
  $run.Output = $largePlaywrightOutput
  $run.ArtifactDirectory = Join-Path $qaRoot ("playwright\artifacts\" + $run.Id)
  $saveRun.Invoke($null, @($run)) | Out-Null
}

$logPath = Join-Path $qaRoot "agent.log"
$utf8 = New-Object Text.UTF8Encoding($false)
$writer = New-Object IO.StreamWriter($logPath, $false, $utf8, 65536)
try {
  for ($index = 1; $index -le 180000; $index++) {
    $writer.WriteLine("2026-08-06T12:00:00.0000000+08:00 INFO Memory QA agent log line {0:D6} with bounded tail verification payload.", $index)
  }
}
finally {
  $writer.Dispose()
}

$largeCommand = $null
$largeOutput = $null
$largePlaywrightOutput = $null
$run = $null
[GC]::Collect()
[GC]::WaitForPendingFinalizers()
[GC]::Collect()

$application = [Windows.Application]::Current
if ($null -eq $application) {
  $application = New-Object Windows.Application
  $application.ShutdownMode = [Windows.ShutdownMode]::OnExplicitShutdown
}
$windowType = $assembly.GetType("RelayAgent.Client.MainWindow", $true)
$showPage = $windowType.GetMethod(
  "ShowPage",
  [Reflection.BindingFlags]::Instance -bor [Reflection.BindingFlags]::NonPublic)
$window = $null

function Invoke-UiIdle {
  $window.UpdateLayout()
  $window.Dispatcher.Invoke(
    [Action] {},
    [Windows.Threading.DispatcherPriority]::ApplicationIdle)
  $window.UpdateLayout()
}

function Get-MemorySnapshot {
  param([string]$Name)
  $process = [Diagnostics.Process]::GetCurrentProcess()
  $process.Refresh()
  [pscustomobject]@{
    Name = $Name
    ManagedMb = [Math]::Round([GC]::GetTotalMemory($false) / 1MB, 1)
    WorkingSetMb = [Math]::Round($process.WorkingSet64 / 1MB, 1)
    PrivateMb = [Math]::Round($process.PrivateMemorySize64 / 1MB, 1)
  }
}

function Wait-Until {
  param(
    [scriptblock]$Condition,
    [int]$TimeoutMs = 15000
  )
  $watch = [Diagnostics.Stopwatch]::StartNew()
  while (-not (& $Condition)) {
    if ($watch.ElapsedMilliseconds -ge $TimeoutMs) {
      throw "Memory QA timed out after $TimeoutMs ms."
    }
    Invoke-UiIdle
    Start-Sleep -Milliseconds 25
  }
  Invoke-UiIdle
}

try {
  $window = [Activator]::CreateInstance($windowType)
  $window.WindowStartupLocation = [Windows.WindowStartupLocation]::Manual
  $window.Left = -10000
  $window.Top = -10000
  $window.ShowInTaskbar = $false
  $window.ShowActivated = $false
  $window.Show()
  Invoke-UiIdle
  $snapshots = New-Object Collections.Generic.List[object]
  $snapshots.Add((Get-MemorySnapshot "overview"))

  $showPage.Invoke($window, @("AuditPage")) | Out-Null
  Wait-Until { $windowType.GetProperty("AuditRows").GetValue($window, $null).Count -ge 100 }
  $snapshots.Add((Get-MemorySnapshot "command-audit-list"))
  $auditGrid = $window.FindName("AuditGrid")
  $auditGrid.SelectedIndex = 0
  Wait-Until { -not $window.FindName("AuditDetailBox").Text.StartsWith("Loading") }
  $snapshots.Add((Get-MemorySnapshot "command-audit-detail"))

  $showPage.Invoke($window, @("DiagnosticsPage")) | Out-Null
  Invoke-UiIdle
  $snapshots.Add((Get-MemorySnapshot "agent-log-tail"))

  $showPage.Invoke($window, @("PlaywrightPage")) | Out-Null
  Wait-Until { $windowType.GetProperty("PlaywrightRuns").GetValue($window, $null).Count -ge 50 } 30000
  $snapshots.Add((Get-MemorySnapshot "playwright-list"))
  $tabs = $window.FindName("PlaywrightTabs")
  $tabs.SelectedIndex = 3
  $runGrid = $window.FindName("PlaywrightRunGrid")
  $runGrid.SelectedIndex = 0
  Wait-Until { -not $window.FindName("PlaywrightRunDetailBox").Text.StartsWith("Loading") }
  $snapshots.Add((Get-MemorySnapshot "playwright-detail"))

  $baseline = $snapshots[0]
  $peak = $snapshots | Sort-Object WorkingSetMb -Descending | Select-Object -First 1
  $result = [pscustomobject]@{
    Fixtures = [pscustomobject]@{
      CommandRecords = 100
      CommandOutputCharactersEach = 262000
      PlaywrightRuns = 50
      PlaywrightOutputCharactersEach = 499000
      AgentLogBytes = (Get-Item $logPath).Length
    }
    BaselineWorkingSetMb = $baseline.WorkingSetMb
    PeakWorkingSetMb = $peak.WorkingSetMb
    PeakDeltaMb = [Math]::Round($peak.WorkingSetMb - $baseline.WorkingSetMb, 1)
    Snapshots = $snapshots
  }
  $result | ConvertTo-Json -Depth 5
  if ($result.PeakDeltaMb -gt 125) {
    throw "Memory QA failed: working-set delta was $($result.PeakDeltaMb) MB."
  }
}
finally {
  if ($null -ne $window) {
    $window.Close()
  }
  $application.Shutdown()
  [Environment]::SetEnvironmentVariable("RELAY_AGENT_CONFIG_DIR", $null)
  if ($qaRoot.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $qaRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
