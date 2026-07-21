[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$PythonRuntime,

  [Parameter(Mandatory = $true)]
  [string]$PyannoteDirectory,

  [Parameter(Mandatory = $true)]
  [string]$MossFormerDirectory,

  [Parameter(Mandatory = $true)]
  [string]$ClearerVoiceDirectory,

  [string]$DiarizationModelsDirectory,
  [string]$OutputDirectory,
  [switch]$SkipDependencyInstall,
  [switch]$SkipGpuSelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$appRoot = Split-Path -Parent $PSScriptRoot
$workspaceTemp = "G:\Jarvis\.tmp"
$pipCache = "G:\Jarvis\.cache\pip"
if (-not $DiarizationModelsDirectory) {
  $DiarizationModelsDirectory = Join-Path $appRoot "resources\bin\diarization-models"
}
if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path $appRoot "resources\ai-model-pack\prebuilt"
}

function Resolve-RequiredPath([string]$Value, [string]$Label, [switch]$Directory) {
  $resolved = [System.IO.Path]::GetFullPath($Value)
  if ($Directory -and -not (Test-Path -LiteralPath $resolved -PathType Container)) {
    throw "$Label directory is unavailable: $resolved"
  }
  if (-not $Directory -and -not (Test-Path -LiteralPath $resolved)) {
    throw "$Label is unavailable: $resolved"
  }
  return $resolved
}

function Assert-NonSystemDestination([string]$Value, [string]$Label) {
  $resolved = [System.IO.Path]::GetFullPath($Value)
  $systemDrive = [System.IO.Path]::GetPathRoot($env:SystemRoot)
  if ([System.IO.Path]::GetPathRoot($resolved) -ieq $systemDrive) {
    throw "$Label must not be stored on the Windows system drive: $resolved"
  }
  return $resolved
}

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $Command"
  }
}

$pythonSource = Resolve-RequiredPath $PythonRuntime "Python runtime" -Directory
$pyannoteSource = Resolve-RequiredPath $PyannoteDirectory "pyannote Community-1" -Directory
$mossFormerSource = Resolve-RequiredPath $MossFormerDirectory "MossFormer2" -Directory
$clearerVoiceSource = Resolve-RequiredPath $ClearerVoiceDirectory "ClearerVoice-Studio" -Directory
$diarizationSource = Resolve-RequiredPath $DiarizationModelsDirectory "Diarization models" -Directory
$safeOutput = Assert-NonSystemDestination $OutputDirectory "Model pack"
$safeTemp = Assert-NonSystemDestination $workspaceTemp "Temporary workspace"

New-Item -ItemType Directory -Force -Path $safeTemp, $pipCache | Out-Null
$stagingRoot = Join-Path $safeTemp ("ai-model-runtime-" + [guid]::NewGuid().ToString("N"))
$stagedRuntime = Join-Path $stagingRoot "runtime"

$previousTemp = $env:TEMP
$previousTmp = $env:TMP
$previousPipCache = $env:PIP_CACHE_DIR
$previousHfOffline = $env:HF_HUB_OFFLINE
$previousTransformersOffline = $env:TRANSFORMERS_OFFLINE
try {
  $env:TEMP = $safeTemp
  $env:TMP = $safeTemp
  $env:PIP_CACHE_DIR = $pipCache
  New-Item -ItemType Directory -Path $stagingRoot | Out-Null
  Copy-Item -LiteralPath $pythonSource -Destination $stagedRuntime -Recurse
  $python = Join-Path $stagedRuntime "python.exe"
  if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw "The supplied self-contained runtime does not contain python.exe"
  }

  if (-not $SkipDependencyInstall) {
    Invoke-Checked $python @("-m", "pip", "install", "--upgrade", "pip")
    Invoke-Checked $python @(
      "-m", "pip", "install",
      "torch==2.11.0", "torchvision==0.26.0", "torchaudio==2.11.0",
      "--index-url", "https://download.pytorch.org/whl/cu128"
    )
    Invoke-Checked $python @(
      "-m", "pip", "install", "--requirement",
      (Join-Path $appRoot "resources\ai-model-pack\requirements.lock.txt")
    )
    Invoke-Checked $python @("-m", "pip", "check")
    $freeze = & $python -m pip freeze --all
    if ($LASTEXITCODE -ne 0) { throw "Unable to record the Python dependency lock" }
    $freeze | Set-Content -LiteralPath (Join-Path $stagedRuntime "JARVIS_PYTHON_LOCK.txt") -Encoding utf8
  }

  Invoke-Checked (Get-Command node.exe).Source @(
    (Join-Path $appRoot "scripts\build-ai-model-pack.js"),
    "--output-dir", $safeOutput,
    "--python-runtime", $stagedRuntime,
    "--pyannote-dir", $pyannoteSource,
    "--mossformer-dir", $mossFormerSource,
    "--clearer-voice-dir", $clearerVoiceSource,
    "--diarization-models-dir", $diarizationSource
  )

  if (-not $SkipGpuSelfTest) {
    $env:HF_HUB_OFFLINE = "1"
    $env:TRANSFORMERS_OFFLINE = "1"
    Invoke-Checked (Join-Path $safeOutput "runtime\python.exe") @(
      "-I", "-u",
      (Join-Path $safeOutput "runtime\jarvis_diarization_sidecar.py"),
      "--self-test", "--load-separator", "--model-root", $safeOutput
    )
  }
} finally {
  $env:TEMP = $previousTemp
  $env:TMP = $previousTmp
  $env:PIP_CACHE_DIR = $previousPipCache
  $env:HF_HUB_OFFLINE = $previousHfOffline
  $env:TRANSFORMERS_OFFLINE = $previousTransformersOffline
  if (Test-Path -LiteralPath $stagingRoot) {
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
  }
}
