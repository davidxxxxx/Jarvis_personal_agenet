const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");

const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const IO_REPARSE_TAG_MOUNT_POINT = "0xa0000003";
// PowerShell startup plus Win32_Volume CIM enumeration can exceed ten seconds while the
// all-day regression suite is saturating the machine. Storage migration is not a hot path;
// prefer a bounded, truthful result over a load-dependent false failure.
const WINDOWS_METADATA_TIMEOUT_MS = 30_000;

const WINDOWS_METADATA_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$candidate = $args[0]
$item = Get-Item -LiteralPath $candidate -Force -ErrorAction Stop
$resolved = (Resolve-Path -LiteralPath $candidate -ErrorAction Stop).ProviderPath
$attributes = [int64]$item.Attributes
$tag = $null
if (($attributes -band [int64][System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  $raw = (& fsutil reparsepoint query $candidate 2>$null | Out-String)
  $match = [regex]::Match($raw, '0x[0-9a-fA-F]{8}')
  if ($match.Success) { $tag = $match.Value.ToLowerInvariant() }
  elseif ([string]$item.LinkType -eq 'Junction') { $tag = '0xa0000003' }
  else { throw 'reparse tag unavailable' }
}
$volume = Get-Volume -FilePath $resolved -ErrorAction Stop
$volumeGuid = [string]$volume.Path
$cimVolume = Get-CimInstance Win32_Volume -ErrorAction Stop |
  Where-Object { ([string]$_.DeviceID).TrimEnd('\') -eq $volumeGuid.TrimEnd('\') } |
  Select-Object -First 1
if ($null -eq $cimVolume -and $volume.DriveLetter) {
  $letter = ([string]$volume.DriveLetter).TrimEnd(':') + ':'
  $cimVolume = Get-CimInstance Win32_Volume -Filter "DriveLetter='$letter'" -ErrorAction Stop |
    Select-Object -First 1
}
$serial = if ($null -ne $cimVolume) { [string]$cimVolume.SerialNumber } else { '' }
$root = [System.IO.Path]::GetPathRoot($resolved)
$driveType = ([System.IO.DriveInfo]::new($root)).DriveType.ToString()
[pscustomobject]@{
  finalPath = $resolved
  attributes = $attributes
  reparseTag = $tag
  linkType = [string]$item.LinkType
  driveType = $driveType
  volumeGuid = $volumeGuid
  serial = $serial
} | ConvertTo-Json -Compress
`;

function defaultMetadataProvider(candidate) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `& {${WINDOWS_METADATA_SCRIPT}}`, candidate],
      { windowsHide: true, timeout: WINDOWS_METADATA_TIMEOUT_MS, maxBuffer: 256 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          resolve(JSON.parse(String(stdout).trim()));
        } catch (parseError) {
          reject(parseError);
        }
      }
    );
  });
}

function normalizeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") throw new Error("metadata unavailable");
  if (typeof metadata.finalPath !== "string" || metadata.finalPath.length === 0) {
    throw new Error("final path unavailable");
  }
  return metadata;
}

class DefaultPathInspector {
  constructor({ platform = process.platform, metadataProvider = defaultMetadataProvider } = {}) {
    this.platform = platform;
    this.metadataProvider = metadataProvider;
  }

  async inspect(candidate, stat) {
    if (!stat || typeof stat.isSymbolicLink !== "function") {
      throw new TypeError("path stat is required");
    }
    if (this.platform !== "win32") {
      return {
        reparse: stat.isSymbolicLink(),
        mountPoint: false,
        reparseTag: null,
        finalPath: candidate,
      };
    }
    try {
      const metadata = normalizeMetadata(await this.metadataProvider(candidate));
      const attributes = Number(metadata.attributes);
      if (!Number.isSafeInteger(attributes)) throw new Error("attributes unavailable");
      const reparseTag =
        metadata.reparseTag === null ? null : String(metadata.reparseTag).toLowerCase();
      const reparse =
        stat.isSymbolicLink() ||
        (attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0 ||
        reparseTag !== null;
      if (reparse && reparseTag === null) throw new Error("reparse tag unavailable");
      return {
        reparse,
        mountPoint: reparseTag === IO_REPARSE_TAG_MOUNT_POINT,
        reparseTag,
        finalPath: metadata.finalPath,
      };
    } catch {
      throw new Error("Windows path inspection failed");
    }
  }
}

class DefaultVolumeInspector {
  constructor({
    platform = process.platform,
    fsImpl = fs,
    metadataProvider = defaultMetadataProvider,
  } = {}) {
    this.platform = platform;
    this.fs = fsImpl;
    this.metadataProvider = metadataProvider;
    this.requiresStableIdentity = true;
  }

  async inspect(candidate) {
    try {
      let existing = path.resolve(candidate);
      let existingStat = null;
      while (true) {
        const stat = await this.fs.lstat(existing).catch((error) => {
          if (error?.code === "ENOENT") return null;
          throw error;
        });
        if (stat) {
          existingStat = stat;
          break;
        }
        const parent = path.dirname(existing);
        if (parent === existing) throw new Error("no existing target ancestor");
        existing = parent;
      }
      const finalPath = await this.fs.realpath(existing);
      await this.fs.access(existing, fs.constants?.W_OK ?? 2);
      if (this.platform !== "win32") {
        if (!existingStat || !Number.isSafeInteger(Number(existingStat.dev))) {
          throw new Error("device identity unavailable");
        }
        return {
          kind: "fixed",
          writable: true,
          identity: `device:${String(existingStat.dev)}`,
          finalPath,
        };
      }
      if (/^\\\\/.test(finalPath)) return { kind: "network", writable: false };
      const metadata = normalizeMetadata(await this.metadataProvider(finalPath));
      const driveType = String(metadata.driveType ?? "").toLowerCase();
      const volumeGuid = String(metadata.volumeGuid ?? "");
      const serial = String(metadata.serial ?? "");
      if (!volumeGuid || !serial) throw new Error("volume identity unavailable");
      return {
        kind: driveType === "fixed" ? "fixed" : driveType || "unknown",
        writable: driveType === "fixed",
        identity: `${volumeGuid}|${serial}`,
        finalPath: metadata.finalPath,
      };
    } catch {
      return { kind: "unknown", writable: false };
    }
  }
}

module.exports = {
  DefaultPathInspector,
  DefaultVolumeInspector,
  defaultMetadataProvider,
};
