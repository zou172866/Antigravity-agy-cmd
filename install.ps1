<#
.SYNOPSIS
  Pinned-release, SHA-256-verified Windows installer for agy-cmd.
  Supports:
    - Pinned remote release install:
        irm https://raw.githubusercontent.com/zou172866/Antigravity-agy-cmd/v2.8.0/install.ps1 | iex
    - Local checkout / extracted archive install:
        .\install.ps1
    - Offline SHA-256-verified ZIP install:
        .\install.ps1 --archive .\agy-cmd-v2.8.0.zip --checksums .\SHA256SUMS.txt
#>
$ErrorActionPreference = "Stop"
$ScriptPath = $MyInvocation.MyCommand.Path
$DefaultVersion = "v2.8.0"
$ReleaseDownloadBase = "https://github.com/zou172866/Antigravity-agy-cmd/releases/download"

function Fail-Install([string]$Message, [int]$Code = 1) {
  if ($ScriptPath) {
    Write-Error $Message
    exit $Code
  }
  throw $Message
}

function Normalize-ReleaseTag([string]$Raw) {
  if ([string]::IsNullOrWhiteSpace($Raw)) {
    return $DefaultVersion
  }
  $trimmed = $Raw.Trim()
  if ($trimmed -notmatch '^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
    Fail-Install "Invalid release version '$Raw'. Expected a SemVer release tag such as '$DefaultVersion' (mutable branches like 'main' are not allowed)."
  }
  if ($trimmed.StartsWith("v")) { return $trimmed }
  return "v$trimmed"
}

function Resolve-ExpectedSha256([string]$ChecksumsPath, [string]$AssetName) {
  if (-not (Test-Path -LiteralPath $ChecksumsPath -PathType Leaf)) {
    Fail-Install "Checksums file not found: $ChecksumsPath"
  }
  $foundHashes = @()
  foreach ($line in (Get-Content -LiteralPath $ChecksumsPath -Encoding UTF8)) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
    if ($trimmed -match '^([0-9a-fA-F]{64})\s+\*?(.+)$') {
      $hash = $Matches[1].ToLowerInvariant()
      $fname = [System.IO.Path]::GetFileName($Matches[2].Trim())
      if ($fname -ceq $AssetName) {
        $foundHashes += $hash
      }
    }
  }
  $unique = @($foundHashes | Select-Object -Unique)
  if ($unique.Count -ne 1) {
    Fail-Install "Could not find a unique SHA-256 entry for '$AssetName' in $ChecksumsPath."
  }
  return $unique[0]
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail-Install "Node.js >= 20 is required. Install Node.js first: https://nodejs.org/"
}

$PythonBin = if (Get-Command python -ErrorAction SilentlyContinue) { "python" } elseif (Get-Command python3 -ErrorAction SilentlyContinue) { "python3" } else { "" }
if (-not $PythonBin) {
  Fail-Install "Python 3.8+ is required to configure agy-cmd."
}

$TargetVersion = if ($env:AGY_CMD_VERSION) { $env:AGY_CMD_VERSION } else { "" }
$ArchivePath = ""
$ChecksumsPath = ""
$ExplicitSha256 = ""
$ForwardArgs = @()

for ($i = 0; $i -lt $args.Count; $i++) {
  $tok = [string]$args[$i]
  if (($tok -eq "--version" -or $tok -eq "-Version") -and ($i + 1 -lt $args.Count)) {
    $TargetVersion = [string]$args[++$i]
  } elseif (($tok -eq "--archive" -or $tok -eq "-Archive") -and ($i + 1 -lt $args.Count)) {
    $ArchivePath = [string]$args[++$i]
  } elseif (($tok -eq "--checksums" -or $tok -eq "-Checksums") -and ($i + 1 -lt $args.Count)) {
    $ChecksumsPath = [string]$args[++$i]
  } elseif (($tok -eq "--sha256" -or $tok -eq "-Sha256") -and ($i + 1 -lt $args.Count)) {
    $ExplicitSha256 = [string]$args[++$i]
  } else {
    $ForwardArgs += $tok
  }
}

$ScriptDir = if ($ScriptPath) { Split-Path -Parent $ScriptPath } else { "" }
$LocalSetup = if ($ScriptDir) { Join-Path $ScriptDir "skills\agy-cmd\scripts\setup_auto_router.py" } else { "" }
$TempWorkDir = ""

try {
  $UseLocalSource = (-not $ArchivePath) -and (-not $TargetVersion) -and $LocalSetup -and (Test-Path -LiteralPath $LocalSetup -PathType Leaf)

  if (-not $UseLocalSource) {
    $TempWorkDir = Join-Path ([System.IO.Path]::GetTempPath()) ("agy-cmd-bootstrap-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $TempWorkDir | Out-Null

    if ($ArchivePath) {
      if (-not (Test-Path -LiteralPath $ArchivePath -PathType Leaf)) {
        Fail-Install "Archive file not found: $ArchivePath"
      }
      $ZipFile = (Resolve-Path -LiteralPath $ArchivePath).Path
      $AssetName = [System.IO.Path]::GetFileName($ZipFile)
      if ($ExplicitSha256) {
        if ($ExplicitSha256.Trim() -notmatch '^[0-9a-fA-F]{64}$') {
          Fail-Install "Invalid --sha256 digest: expected 64 hex characters."
        }
        $ExpectedSha256 = $ExplicitSha256.Trim().ToLowerInvariant()
      } elseif ($ChecksumsPath) {
        $ExpectedSha256 = Resolve-ExpectedSha256 $ChecksumsPath $AssetName
      } else {
        Fail-Install "Offline archive install requires --checksums <SHA256SUMS.txt> or --sha256 <64-hex>."
      }
    } else {
      $Tag = Normalize-ReleaseTag $TargetVersion
      $AssetName = "agy-cmd-$Tag.zip"
      $ZipUrl = "$ReleaseDownloadBase/$Tag/$AssetName"
      $SumsUrl = "$ReleaseDownloadBase/$Tag/SHA256SUMS.txt"
      $ZipFile = Join-Path $TempWorkDir $AssetName
      $SumsFile = Join-Path $TempWorkDir "SHA256SUMS.txt"

      try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
      } catch {}

      Write-Host "[agy-cmd] Downloading release $Tag ($AssetName) and SHA256SUMS.txt..."
      Invoke-WebRequest -Uri $SumsUrl -OutFile $SumsFile -UseBasicParsing
      Invoke-WebRequest -Uri $ZipUrl -OutFile $ZipFile -UseBasicParsing
      $ExpectedSha256 = Resolve-ExpectedSha256 $SumsFile $AssetName
    }

    $ActualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $ZipFile).Hash.ToLowerInvariant()
    if ($ActualSha256 -cne $ExpectedSha256) {
      Fail-Install "SHA-256 verification failed for $AssetName! Expected $ExpectedSha256, got $ActualSha256. Aborting without unpacking."
    }
    Write-Host "[agy-cmd] SHA-256 verified ($ActualSha256)."

    $UnpackDir = Join-Path $TempWorkDir "unpacked"
    New-Item -ItemType Directory -Force -Path $UnpackDir | Out-Null

    $ExtractCode = @'
import os, pathlib, stat, sys, zipfile
zip_path, out_dir = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]).resolve()
with zipfile.ZipFile(zip_path, "r") as zf:
    infos = zf.infolist()
    if len(infos) > 2000:
        raise SystemExit("Too many entries in archive")
    total = 0
    for info in infos:
        name = info.filename.replace("\\", "/")
        if name.startswith("/") or name.startswith("../") or "/../" in name or name == "..":
            raise SystemExit(f"Unsafe archive path: {info.filename}")
        mode = info.external_attr >> 16
        if stat.S_ISLNK(mode):
            raise SystemExit(f"Symlink entry not allowed: {info.filename}")
        total += info.file_size
        if total > 64 * 1024 * 1024:
            raise SystemExit("Archive uncompressed size exceeds safety limit")
        target = (out_dir / name).resolve()
        if target != out_dir and out_dir not in target.parents:
            raise SystemExit(f"Path traversal blocked: {info.filename}")
    zf.extractall(out_dir)
'@
    $ExtractScript = Join-Path $TempWorkDir "extract.py"
    [System.IO.File]::WriteAllText($ExtractScript, $ExtractCode, (New-Object System.Text.UTF8Encoding($false)))
    & $PythonBin $ExtractScript $ZipFile $UnpackDir
    if ($LASTEXITCODE -ne 0) {
      Fail-Install "Failed to safely extract verified archive $AssetName." $LASTEXITCODE
    }

    $DirectSetup = Join-Path $UnpackDir "skills\agy-cmd\scripts\setup_auto_router.py"
    if (Test-Path -LiteralPath $DirectSetup -PathType Leaf) {
      $LocalSetup = $DirectSetup
    } else {
      $SubDirs = @(Get-ChildItem -LiteralPath $UnpackDir -Directory)
      if ($SubDirs.Count -eq 1) {
        $NestedSetup = Join-Path $SubDirs[0].FullName "skills\agy-cmd\scripts\setup_auto_router.py"
        if (Test-Path -LiteralPath $NestedSetup -PathType Leaf) {
          $LocalSetup = $NestedSetup
        }
      }
    }
    if (-not $LocalSetup -or -not (Test-Path -LiteralPath $LocalSetup -PathType Leaf)) {
      Fail-Install "Verified archive did not contain skills/agy-cmd/scripts/setup_auto_router.py."
    }
  }

  & $PythonBin $LocalSetup --install @ForwardArgs
  if ($LASTEXITCODE -ne 0) {
    Fail-Install "agy-cmd installer failed with exit code $LASTEXITCODE" $LASTEXITCODE
  }
} finally {
  if ($TempWorkDir -and (Test-Path -LiteralPath $TempWorkDir)) {
    Remove-Item -LiteralPath $TempWorkDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
