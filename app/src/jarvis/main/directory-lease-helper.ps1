$ErrorActionPreference = 'Stop'
$null = Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class JarvisDirectoryLeaseNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct UNICODE_STRING {
    public ushort Length;
    public ushort MaximumLength;
    public IntPtr Buffer;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct OBJECT_ATTRIBUTES {
    public int Length;
    public IntPtr RootDirectory;
    public IntPtr ObjectName;
    public uint Attributes;
    public IntPtr SecurityDescriptor;
    public IntPtr SecurityQualityOfService;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct IO_STATUS_BLOCK {
    public IntPtr Status;
    public UIntPtr Information;
  }

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

  [DllImport("ntdll.dll")]
  private static extern int NtCreateFile(
    out IntPtr fileHandle,
    uint desiredAccess,
    ref OBJECT_ATTRIBUTES objectAttributes,
    out IO_STATUS_BLOCK ioStatusBlock,
    IntPtr allocationSize,
    uint fileAttributes,
    uint shareAccess,
    uint createDisposition,
    uint createOptions,
    IntPtr eaBuffer,
    uint eaLength
  );

  [DllImport("ntdll.dll")]
  private static extern uint RtlNtStatusToDosError(uint status);

  public static IntPtr CreateDirectoryAndLease(string path) {
    string ntPath = @"\??\" + path;
    IntPtr pathBuffer = IntPtr.Zero;
    IntPtr unicodeStringBuffer = IntPtr.Zero;
    try {
      pathBuffer = Marshal.StringToHGlobalUni(ntPath);
      int byteLength = checked(ntPath.Length * sizeof(char));
      UNICODE_STRING unicodeString = new UNICODE_STRING {
        Length = checked((ushort)byteLength),
        MaximumLength = checked((ushort)(byteLength + sizeof(char))),
        Buffer = pathBuffer
      };
      unicodeStringBuffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));
      Marshal.StructureToPtr(unicodeString, unicodeStringBuffer, false);
      OBJECT_ATTRIBUTES objectAttributes = new OBJECT_ATTRIBUTES {
        Length = Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES)),
        RootDirectory = IntPtr.Zero,
        ObjectName = unicodeStringBuffer,
        Attributes = 0x40,
        SecurityDescriptor = IntPtr.Zero,
        SecurityQualityOfService = IntPtr.Zero
      };
      IO_STATUS_BLOCK ioStatusBlock;
      IntPtr handle;
      int status = NtCreateFile(
        out handle,
        0x00110080,
        ref objectAttributes,
        out ioStatusBlock,
        IntPtr.Zero,
        0x10,
        0x3,
        0x2,
        0x00200021,
        IntPtr.Zero,
        0
      );
      if (status < 0) {
        throw new Win32Exception((int)RtlNtStatusToDosError(unchecked((uint)status)));
      }
      return handle;
    } finally {
      if (unicodeStringBuffer != IntPtr.Zero) Marshal.FreeHGlobal(unicodeStringBuffer);
      if (pathBuffer != IntPtr.Zero) Marshal.FreeHGlobal(pathBuffer);
    }
  }

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

$mode = $args[0]
$candidate = $args[1]
if ($mode -eq '--create') {
  $handle = [JarvisDirectoryLeaseNative]::CreateDirectoryAndLease($candidate)
} elseif ($mode -eq '--open') {
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
} elseif ($mode -eq '--exclusive-file') {
  $handle = [JarvisDirectoryLeaseNative]::CreateFileW(
    $candidate,
    [uint32]0x40000000,
    [uint32]0,
    [IntPtr]::Zero,
    [uint32]4,
    [uint32]0x00000080,
    [IntPtr]::Zero
  )
  if ($handle -eq [IntPtr]::new(-1)) {
    throw "CreateFileW failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
} else {
  throw 'directory lease helper mode is invalid'
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
