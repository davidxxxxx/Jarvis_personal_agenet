param(
  [Parameter(ValueFromRemainingArguments = $true, Mandatory = $true)]
  [string[]]$Paths
)

$ErrorActionPreference = "Stop"
$results = foreach ($artifactPath in $Paths) {
  try {
    $signature = Get-AuthenticodeSignature -LiteralPath $artifactPath
    [PSCustomObject]@{
      name = [IO.Path]::GetFileName($artifactPath)
      status = [string]$signature.Status
    }
  } catch {
    [PSCustomObject]@{
      name = [IO.Path]::GetFileName($artifactPath)
      status = "Unverifiable"
    }
  }
}
$results | ConvertTo-Json -Compress
