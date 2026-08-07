param(
  [string]$AssemblyPath = "",
  [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($AssemblyPath)) {
  $AssemblyPath = Join-Path $scriptRoot "out\RelayAgent.Client-responsive.exe"
}
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $scriptRoot "ui-qa"
}

$AssemblyPath = (Resolve-Path -LiteralPath $AssemblyPath).Path
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$qaAgentData = Join-Path $OutputDirectory "_agent-data"
New-Item -ItemType Directory -Force -Path $qaAgentData | Out-Null
$env:RELAY_AGENT_CONFIG_DIR = $qaAgentData

Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName WindowsBase

$assembly = [Reflection.Assembly]::LoadFrom($AssemblyPath)
$commandAuditType = $assembly.GetType("RelayAgent.Shared.CommandAuditStore", $true)
$commandAuditStart = $commandAuditType.GetMethod("Start")
$commandAuditComplete = $commandAuditType.GetMethod("Complete")
$commandAuditMarkResult = $commandAuditType.GetMethod("MarkResultPosted")
for ($index = 1; $index -le 105; $index++) {
  $jobId = "qa-command-{0:D3}" -f $index
  $commandAuditStart.Invoke($null, @(
    $jobId,
    "powershell",
    "Inspect SampleManager service state",
    '$service = Get-Service -Name SampleManager; password=qa-secret; $service | Select-Object Name,Status',
    "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <Agent jobs script>",
    120000,
    $true,
    $true,
    14
  )) | Out-Null
  $commandAuditComplete.Invoke($null, @(
    $jobId,
    $(if ($index % 9 -eq 0) { "failed" } else { "completed" }),
    $(if ($index % 9 -eq 0) { 1 } else { 0 }),
    "Name=SampleManager Status=Running`nQA output line $index",
    $(if ($index % 9 -eq 0) { "QA simulated stderr" } else { "" }),
    "QA command audit fixture"
  )) | Out-Null
  $commandAuditMarkResult.Invoke($null, @($jobId, $true, "")) | Out-Null
}
$windowType = $assembly.GetType("RelayAgent.Client.MainWindow", $true)
$showPage = $windowType.GetMethod(
  "ShowPage",
  [Reflection.BindingFlags]::Instance -bor [Reflection.BindingFlags]::NonPublic)
$restoreFromTray = $windowType.GetMethod(
  "RestoreFromTray",
  [Reflection.BindingFlags]::Instance -bor [Reflection.BindingFlags]::NonPublic)
$trayIconField = $windowType.GetField(
  "_trayIcon",
  [Reflection.BindingFlags]::Instance -bor [Reflection.BindingFlags]::NonPublic)
$trayHintField = $windowType.GetField(
  "_trayHintShown",
  [Reflection.BindingFlags]::Instance -bor [Reflection.BindingFlags]::NonPublic)

$application = [System.Windows.Application]::Current
if ($null -eq $application) {
  $application = New-Object System.Windows.Application
  $application.ShutdownMode = [System.Windows.ShutdownMode]::OnExplicitShutdown
}

$window = [Activator]::CreateInstance($windowType)
$window.WindowStartupLocation = [System.Windows.WindowStartupLocation]::Manual
$window.Left = -10000
$window.Top = -10000
$window.ShowInTaskbar = $false
$window.ShowActivated = $false
$window.Show()

function Invoke-LayoutPass {
  $window.UpdateLayout()
  $window.Dispatcher.Invoke(
    [Action] {},
    [System.Windows.Threading.DispatcherPriority]::ApplicationIdle)
  $window.UpdateLayout()
}

function Save-WindowPng {
  param(
    [string]$Name,
    [int]$Width,
    [int]$Height
  )

  $window.Width = $Width
  $window.Height = $Height
  Invoke-LayoutPass

  $pixelWidth = [Math]::Max(1, [int][Math]::Ceiling($window.ActualWidth))
  $pixelHeight = [Math]::Max(1, [int][Math]::Ceiling($window.ActualHeight))
  $bitmap = New-Object System.Windows.Media.Imaging.RenderTargetBitmap(
    $pixelWidth,
    $pixelHeight,
    96,
    96,
    [System.Windows.Media.PixelFormats]::Pbgra32)
  $bitmap.Render($window)

  $encoder = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
  $encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
  $path = Join-Path $OutputDirectory ($Name + ".png")
  $stream = [IO.File]::Open($path, [IO.FileMode]::Create)
  try {
    $encoder.Save($stream)
  }
  finally {
    $stream.Dispose()
  }
  Write-Host $path
}

function Ensure-QASelectedRun {
  $runs = $windowType.GetProperty("PlaywrightRuns").GetValue($window, $null)
  if ($runs.Count -eq 0) {
    $runType = $assembly.GetType("RelayAgent.Shared.PlaywrightRun", $true)
    $run = [Activator]::CreateInstance($runType)
    $run.Id = "qa-run-001"
    $run.SuiteName = "HKJC Web Client verification"
    $run.Status = "failed"
    $run.StartedAt = "2026-08-06T12:00:00Z"
    $run.FinishedAt = "2026-08-06T12:00:24Z"
    $run.DurationMs = 24000
    $run.ExitCode = 1
    $run.ArtifactDirectory = "C:\ProgramData\RelayMcpAgent\playwright\artifacts\qa-run-001"
    $run.Error = "QA fixture error message"
    $run.Output = (1..18 | ForEach-Object { "QA output line $_ - selected run terminal layout check" }) -join [Environment]::NewLine
    $runs.Add($run)
  }

  $runGrid = $window.FindName("PlaywrightRunGrid")
  if ($null -ne $runGrid) {
    $runGrid.SelectedIndex = 0
  }
}

function Wait-ForQACommandAudit {
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $auditGrid = $window.FindName("AuditGrid")
  $rows = $windowType.GetProperty("AuditRows").GetValue($window, $null)
  while (($rows.Count -eq 0 -or -not $auditGrid.IsEnabled) -and $watch.ElapsedMilliseconds -lt 5000) {
    Invoke-LayoutPass
    Start-Sleep -Milliseconds 25
    $rows = $windowType.GetProperty("AuditRows").GetValue($window, $null)
  }
  $watch.Stop()
  if ($rows.Count -eq 0) {
    throw "Command Audit QA failed: no rows loaded within five seconds."
  }
  if ($rows.Count -gt 100) {
    throw "Command Audit QA failed: expected at most 100 rows, got $($rows.Count)."
  }
  $auditGrid.SelectedIndex = 0
  Invoke-LayoutPass
  Write-Host "Command audit load: $($rows.Count) rows in $($watch.ElapsedMilliseconds) ms"
}

$trayHintField.SetValue($window, $true)
$window.WindowState = [System.Windows.WindowState]::Minimized
Invoke-LayoutPass
$trayIcon = $trayIconField.GetValue($window)
if ($window.IsVisible -or $window.ShowInTaskbar -or $null -eq $trayIcon -or -not $trayIcon.Visible) {
  throw "Tray QA failed: minimizing did not hide the window and expose the tray icon."
}

$restoreFromTray.Invoke($window, @()) | Out-Null
Invoke-LayoutPass
if (-not $window.IsVisible -or -not $window.ShowInTaskbar -or $trayIcon.Visible) {
  throw "Tray QA failed: restoring did not show the window and hide the tray icon."
}
Write-Host "Tray lifecycle: passed"

$viewports = @(
  @{ Name = "default"; Width = 1240; Height = 820 },
  @{ Name = "high-dpi-work-area"; Width = 1060; Height = 680 },
  @{ Name = "compact"; Width = 980; Height = 760 },
  @{ Name = "minimum"; Width = 900; Height = 700 }
)

$pages = @(
  @{ Name = "overview"; Page = "OverviewPage" },
  @{ Name = "connection"; Page = "ConnectionPage" },
  @{ Name = "service"; Page = "ServicePage" },
  @{ Name = "database"; Page = "DatabasePage" },
  @{ Name = "audit"; Page = "AuditPage" },
  @{ Name = "diagnostics"; Page = "DiagnosticsPage" }
)

foreach ($viewport in $viewports) {
  foreach ($page in $pages) {
    $showPage.Invoke($window, @($page.Page)) | Out-Null
    if ($page.Page -eq "AuditPage") {
      Wait-ForQACommandAudit
    }
    Invoke-LayoutPass
    Save-WindowPng `
      -Name ($viewport.Name + "-" + $page.Name) `
      -Width $viewport.Width `
      -Height $viewport.Height
  }

  $showPage.Invoke($window, @("PlaywrightPage")) | Out-Null
  $tabs = $window.FindName("PlaywrightTabs")
  $tabNames = @("overview", "runtime", "suites", "runs", "artifacts")
  for ($index = 0; $index -lt $tabNames.Count; $index++) {
    $tabs.SelectedIndex = $index
    if ($tabNames[$index] -eq "runs") {
      Ensure-QASelectedRun
    }
    Invoke-LayoutPass
    Save-WindowPng `
      -Name ($viewport.Name + "-playwright-" + $tabNames[$index]) `
      -Width $viewport.Width `
      -Height $viewport.Height
  }
}

$window.Close()
$application.Shutdown()
