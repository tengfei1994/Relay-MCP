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

Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName WindowsBase

$assembly = [Reflection.Assembly]::LoadFrom($AssemblyPath)
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
    Invoke-LayoutPass
    Save-WindowPng `
      -Name ($viewport.Name + "-playwright-" + $tabNames[$index]) `
      -Width $viewport.Width `
      -Height $viewport.Height
  }
}

$window.Close()
$application.Shutdown()
