$ErrorActionPreference = 'Stop'
$null = Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class JarvisDirectoryLeaseNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct FILETIME {
    public uint Low;
    public uint High;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct BY_HANDLE_FILE_INFORMATION {
    public uint FileAttributes;
    public FILETIME CreationTime;
    public FILETIME LastAccessTime;
    public FILETIME LastWriteTime;
    public uint VolumeSerialNumber;
    public uint FileSizeHigh;
    public uint FileSizeLow;
    public uint NumberOfLinks;
    public uint FileIndexHigh;
    public uint FileIndexLow;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateFileW(
    string fileName,
    uint desiredAccess,
    uint shareMode,
    IntPtr securityAttributes,
    uint creationDisposition,
    uint flagsAndAttributes,
    IntPtr templateFile
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool GetFileInformationByHandle(
    IntPtr handle,
    out BY_HANDLE_FILE_INFORMATION information
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool CloseHandle(IntPtr handle);
}
'@

$candidate = $args[0]
$handle = [JarvisDirectoryLeaseNative]::CreateFileW(
  $candidate,
  [uint32]0x00010080,
  [uint32]3,
  [IntPtr]::Zero,
  [uint32]3,
  ([uint32]0x02000000 -bor [uint32]0x00200000),
  [IntPtr]::Zero
)
if ($handle -eq [IntPtr]::new(-1)) {
  throw "CreateFileW failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}
try {
  $information = New-Object JarvisDirectoryLeaseNative+BY_HANDLE_FILE_INFORMATION
  if (-not [JarvisDirectoryLeaseNative]::GetFileInformationByHandle($handle, [ref]$information)) {
    throw "GetFileInformationByHandle failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
  $fileIndex = (([uint64]$information.FileIndexHigh) -shl 32) -bor [uint64]$information.FileIndexLow
  [pscustomobject]@{
    volumeSerial = ([uint32]$information.VolumeSerialNumber).ToString('x8')
    fileId = ([uint64]$fileIndex).ToString('x16')
    attributes = [uint32]$information.FileAttributes
  } | ConvertTo-Json -Compress
  [Console]::Out.Flush()
  $null = [Console]::ReadLine()
} finally {
  $null = [JarvisDirectoryLeaseNative]::CloseHandle($handle)
}
