$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $root "out"
New-Item -ItemType Directory -Force -Path $out | Out-Null
Remove-Item (Join-Path $out "RelayAgent.*.exe") -Force -ErrorAction SilentlyContinue

$msbuildPath = $null
$msbuild = Get-Command MSBuild.exe -ErrorAction SilentlyContinue
if ($msbuild) {
  $msbuildPath = $msbuild.Source
}
if (-not $msbuild) {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path -LiteralPath $vswhere) {
    $install = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -property installationPath
    if ($install) {
      $candidate = Join-Path $install "MSBuild\Current\Bin\MSBuild.exe"
      if (Test-Path -LiteralPath $candidate) {
        $msbuildPath = $candidate
      }
    }
  }
}

if (-not $msbuildPath) {
  throw "MSBuild.exe was not found. Install Visual Studio Build Tools with .NET desktop build tools."
}

& $msbuildPath (Join-Path $root "RelayAgent.Client\RelayAgent.Client.csproj") /p:Configuration=Release /nologo
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$sourceExe = Join-Path $root "RelayAgent.Client\bin\Release\RelayAgent.Client.exe"
$destinationExe = Join-Path $out "RelayAgent.Client.exe"
try {
  Copy-Item $sourceExe $destinationExe -Force
}
catch {
  $fallbackExe = Join-Path $out "RelayAgent.Client.next.exe"
  Copy-Item $sourceExe $fallbackExe -Force
  Write-Warning "RelayAgent.Client.exe is running and could not be replaced."
  Write-Warning "The new build was written to $fallbackExe"
}

Write-Host "Built Relay Agent package:"
Get-ChildItem $out
