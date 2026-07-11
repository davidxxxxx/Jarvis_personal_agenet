param(
  [Parameter(Mandatory = $true)][string]$HelperDir,
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][string]$Target,
  [Parameter(Mandatory = $true)][string]$Session,
  [Parameter(Mandatory = $true)][string]$Moved,
  [Parameter(Mandatory = $true)][string]$Outside
)

$ErrorActionPreference = "Stop"
Add-Type -Path (Join-Path $HelperDir "SafeRecordingDelete.cs")
Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
public static class JarvisJunctionCleanup {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool MoveFileExW(string existingPath, string newPath, uint flags);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CreateHardLinkW(string newFileName, string existingFileName, System.IntPtr securityAttributes);
}
"@
[System.Action]$swap = {
  if (-not [JarvisJunctionCleanup]::MoveFileExW($Target, $Moved, 0)) {
    throw "failed to move test file"
  }
  if (-not [JarvisJunctionCleanup]::CreateHardLinkW($Target, (Join-Path $Outside "capture.wav"), [System.IntPtr]::Zero)) {
    throw "failed to create replacement hard link"
  }
}
$result = [Jarvis.Native.SafeRecordingDelete]::Delete($Root, $Target, $swap)
[PSCustomObject]@{ status = $result.Status; code = $result.Code } | ConvertTo-Json -Compress
