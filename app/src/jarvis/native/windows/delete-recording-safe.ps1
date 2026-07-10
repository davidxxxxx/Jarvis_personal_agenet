param(
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][string]$Path
)

$ErrorActionPreference = "Stop"
try {
  Add-Type -Path (Join-Path $PSScriptRoot "SafeRecordingDelete.cs")
  $result = [Jarvis.Native.SafeRecordingDelete]::Delete($Root, $Path, $null)
  [PSCustomObject]@{ status = $result.Status; code = $result.Code } |
    ConvertTo-Json -Compress
} catch {
  [PSCustomObject]@{ status = "retry"; code = "helper_exception" } |
    ConvertTo-Json -Compress
}
