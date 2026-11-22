<#
.SYNOPSIS
  One-command Windows installer for agy-cmd (supports both `irm ... | iex` and local repo runs).
.EXAMPLE
  irm https://raw.githubusercontent.com/zou172866/agy-cmd/main/install.ps1 | iex
  .\install.ps1
#>
$ErrorActionPreference = "Stop"
$ScriptPath = $MyInvocation.MyCommand.Path

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  $msg = "Node.js >= 20 is required. Install Node.js first: https://nodejs.org/"
  if ($ScriptPath) { Write-Error $msg; exit 1 } else { throw $msg }
}

$PythonBin = if (Get-Command python -ErrorAction SilentlyContinue) { "python" } elseif (Get-Command python3 -ErrorAction SilentlyContinue) { "python3" } else { "" }
if (-not $PythonBin) {
  $msg = "Python 3 is required to configure agy-cmd."
  if ($ScriptPath) { Write-Error $msg; exit 1 } else { throw $msg }
}

$ScriptDir = if ($ScriptPath) { Split-Path -Parent $ScriptPath } else { "" }
$LocalSetup = if ($ScriptDir) { Join-Path $ScriptDir "skills\agy-cmd\scripts\setup_auto_router.py" } else { "" }
$TempWorkDir = ""

try {
  if (-not $LocalSetup -or -not (Test-Path -LiteralPath $LocalSetup)) {
    $TempWorkDir = Join-Path ([System.IO.Path]::GetTempPath()) ("agy-cmd-bootstrap-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $TempWorkDir | Out-Null
    $RepoDir = Join-Path $TempWorkDir "repo"
    if (Get-Command git -ErrorAction SilentlyContinue) {
      Write-Host "[agy-cmd] Fetching latest release from GitHub..."
      & git clone --depth 1 --quiet "https://github.com/zou172866/agy-cmd.git" $RepoDir
      if ($LASTEXITCODE -ne 0) { throw "git clone failed with exit code $LASTEXITCODE" }
    } else {
      Write-Host "[agy-cmd] Downloading archive from GitHub..."
      $ZipFile = Join-Path $TempWorkDir "agy-cmd.zip"
      Invoke-WebRequest -Uri "https://github.com/zou172866/agy-cmd/archive/refs/heads/main.zip" -OutFile $ZipFile -UseBasicParsing
      Expand-Archive -Path $ZipFile -DestinationPath $TempWorkDir -Force
      $Extracted = Get-ChildItem -Path $TempWorkDir -Directory -Filter "agy-cmd-*" | Select-Object -First 1
      if (-not $Extracted) { throw "Failed to unpack agy-cmd archive." }
      $RepoDir = $Extracted.FullName
    }
    $LocalSetup = Join-Path $RepoDir "skills\agy-cmd\scripts\setup_auto_router.py"
  }

  & $PythonBin $LocalSetup --install @args
  if ($LASTEXITCODE -ne 0) {
    if ($ScriptPath) { exit $LASTEXITCODE } else { throw "agy-cmd installer failed with exit code $LASTEXITCODE" }
  }
} finally {
  if ($TempWorkDir -and (Test-Path -LiteralPath $TempWorkDir)) {
    Remove-Item -LiteralPath $TempWorkDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
