$ErrorActionPreference = "Stop"

try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $root = [string]$request.root
  $paths = @($request.paths)
  $results = @()

  if (-not (Test-Path -LiteralPath $root -PathType Container)) {
    foreach ($unused in $paths) {
      $results += [PSCustomObject]@{ status = "missing"; code = "root_not_found" }
    }
  } else {
    Add-Type -Path (Join-Path $PSScriptRoot "SafeRecordingDelete.cs")
    foreach ($target in $paths) {
      try {
        $result = [Jarvis.Native.SafeRecordingDelete]::Delete($root, [string]$target, $null)
        $results += [PSCustomObject]@{ status = $result.Status; code = $result.Code }
      } catch {
        $results += [PSCustomObject]@{ status = "retry"; code = "helper_exception" }
      }
    }
  }
  ConvertTo-Json -InputObject @($results) -Compress
} catch {
  @([PSCustomObject]@{ status = "retry"; code = "request_invalid" }) |
    ConvertTo-Json -Compress
  exit 1
}
